import { mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readText, removeFile } from "./storage.mjs";
import { safeId } from "./bridge.mjs";

const replyPhase = phase => phase === undefined || ["final", "final_answer", "response"].includes(phase);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const captureDiagnostics = () => ({
    version: 2, turns: 0, starts: 0, deltas: 0, taskCompletions: 0,
    lastTerminal: null, lastCompletion: null,
});

export class IdleReplyStore {
    constructor(directory) { this.directory = join(directory, "idle-replies"); }
    path(id) {
        if (!safeId(id)) throw new Error("Invalid idle-reply session ID.");
        return join(this.directory, `${id}.json`);
    }
    async write(value) {
        await mkdir(this.directory, { recursive: true });
        await atomicWrite(this.path(value.sessionId), JSON.stringify(value));
    }
    async read(id, epoch, selectionId) {
        let text;
        try { text = await readText(this.path(id)); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
        let value;
        try { value = JSON.parse(text); }
        catch { throw new Error("The idle-reply cache is corrupt; no message was forwarded."); }
        const completionId = value?.completionEventId ?? null;
        const validReply = nonempty(value?.content) &&
            (nonempty(value.messageId) && completionId === null ||
                value.messageId === null && nonempty(completionId));
        if (value?.version !== 1 || value.sessionId !== id || typeof value.epoch !== "string" ||
            typeof value.selectionId !== "string" || typeof value.eventId !== "string" || !value.eventId ||
            typeof value.idleAt !== "string" || !Number.isFinite(Date.parse(value.idleAt)) ||
            typeof value.aborted !== "boolean" ||
            (!(value.content === null && value.messageId === null && completionId === null) && !validReply)) {
            throw new Error("The idle-reply cache has an unsupported format; no message was forwarded.");
        }
        return value.epoch === epoch && value.selectionId === selectionId ? value : null;
    }
    async remove(id) {
        await removeFile(this.path(id));
    }
    async clear(ids) { for (const id of ids) await this.remove(id); }
    async watch(onChange, onError) {
        await mkdir(this.directory, { recursive: true });
        const watcher = watch(this.directory, (_, filename) => {
            if (filename === null || /^[A-Za-z0-9._-]+\.json$/.test(String(filename))) onChange();
        });
        watcher.on("error", error => { watcher.close(); onError(error); });
        return watcher;
    }
}

export class IdleListener {
    constructor({ sessionId, stateStore, replies, notify }) {
        if (!safeId(sessionId)) throw new Error("Invalid idle-listener session ID.");
        Object.assign(this, { sessionId, stateStore, replies, notify });
        this.queue = Promise.resolve();
        this.latest = null;
        this.epoch = null;
        this.selectionId = null;
        this.started = false;
        this.streams = new Map();
        this.diagnostics = captureDiagnostics();
    }
    reset() {
        this.latest = null;
        this.started = false;
        this.streams.clear();
        this.diagnostics = captureDiagnostics();
    }
    eligible(state) {
        return state.enabled && state.peer &&
            typeof state.idleEpoch === "string" && typeof state.sessions[this.sessionId]?.idleSelectionId === "string";
    }
    handle(event) {
        if (event.agentId || event.data?.parentToolCallId ||
            !["user.message", "assistant.turn_start", "assistant.message_start",
                "assistant.message_delta", "assistant.message", "session.task_complete", "session.idle"].includes(event.type)) return this.queue;
        this.queue = this.queue.then(() => this.capture(event)).catch(error => {
            this.reset();
            return this.notify(error.message);
        });
        return this.queue;
    }
    async capture(event) {
        const state = await this.stateStore.load();
        if (!this.eligible(state)) {
            this.reset();
            await this.replies.remove(this.sessionId);
            return;
        }
        const selectionId = state.sessions[this.sessionId].idleSelectionId;
        if (this.epoch !== state.idleEpoch || this.selectionId !== selectionId ||
            event.type === "user.message") {
            this.reset();
        }
        this.epoch = state.idleEpoch;
        this.selectionId = selectionId;
        if (event.type === "user.message" || event.type === "assistant.turn_start") {
            this.started = true;
            if (event.type === "assistant.turn_start") {
                // Model/tool iterations share a user-visible run, but not unfinished streams.
                this.streams.clear();
                this.diagnostics.turns++;
            }
        } else if (event.type === "assistant.message_start") {
            const data = event.data;
            if (typeof data.messageId !== "string" || !data.messageId) throw new Error("Streaming message identity is unavailable.");
            if (replyPhase(data.phase) && !this.streams.has(data.messageId)) {
                this.streams.set(data.messageId, { chunks: [], events: new Set() });
                this.diagnostics.starts++;
            }
        } else if (event.type === "assistant.message_delta") {
            const stream = this.streams.get(event.data.messageId);
            if (!stream) return;
            if (typeof event.id !== "string" || !event.id || typeof event.data.deltaContent !== "string") {
                throw new Error("Streaming message chunk identity or text is unavailable.");
            }
            if (!stream.events.has(event.id)) {
                stream.events.add(event.id);
                stream.chunks.push(event.data.deltaContent);
                this.diagnostics.deltas++;
            }
        } else if (event.type === "assistant.message") {
            const data = event.data;
            const stream = this.streams.get(data.messageId);
            this.streams.delete(data.messageId);
            const streamed = stream?.chunks.join("") ?? "";
            const terminal = {
                eventId: event.id, messageId: data.messageId,
                phase: replyPhase(data.phase) ? data.phase ?? null : "nonpublic",
                contentLength: typeof data.content === "string" ? data.content.length : null,
                streamedLength: streamed.length, hadStart: !!stream,
                ephemeral: event.ephemeral === true, toolCalls: data.toolRequests?.length ?? 0,
                disposition: "ignored",
            };
            this.diagnostics.lastTerminal = terminal;
            if (event.ephemeral || data.toolRequests?.length || !replyPhase(data.phase)) {
                return;
            }
            if (typeof data.content !== "string") throw new Error("Assistant message text is unavailable.");
            const content = data.content || streamed;
            if (!content.trim()) { terminal.disposition = "empty"; return; }
            if (typeof data.messageId !== "string" || !data.messageId) throw new Error("Assistant message identity is unavailable.");
            terminal.disposition = "captured";
            this.latest = { content, messageId: data.messageId };
            this.started = true;
        } else if (event.type === "session.task_complete") {
            const summary = event.data?.summary;
            this.diagnostics.taskCompletions++;
            this.diagnostics.lastCompletion = {
                eventId: event.id, summaryLength: typeof summary === "string" ? summary.length : null,
            };
            if (summary === undefined || summary === null) return;
            if (typeof summary !== "string") throw new Error("Task completion summary text is unavailable.");
            if (!summary.trim()) return;
            if (!nonempty(event.id)) throw new Error("Task completion event identity is unavailable.");
            this.latest = { content: summary, messageId: null, completionEventId: event.id };
            this.started = true;
        } else if (event.type === "session.idle") {
            this.streams.clear();
            if (!this.started) return;
            if (typeof event.id !== "string" || !event.id || !Number.isFinite(Date.parse(event.timestamp))) {
                throw new Error("Idle event identity or timestamp is unavailable.");
            }
            const latest = event.data?.aborted ? null : this.latest;
            await this.replies.write({
                version: 1, sessionId: this.sessionId, epoch: this.epoch, selectionId,
                eventId: event.id, idleAt: event.timestamp, aborted: event.data?.aborted === true,
                content: latest?.content ?? null, messageId: latest?.messageId ?? null,
                completionEventId: latest?.completionEventId ?? null, capture: this.diagnostics,
            });
            this.reset();
            const current = await this.stateStore.load();
            if (!this.eligible(current) || current.idleEpoch !== this.epoch ||
                current.sessions[this.sessionId].idleSelectionId !== selectionId) await this.replies.remove(this.sessionId);
        }
    }
    async close() { await this.queue; this.reset(); }
}
