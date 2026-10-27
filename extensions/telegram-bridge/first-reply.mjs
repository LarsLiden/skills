import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readText, removeFile } from "./storage.mjs";
import { safeId } from "./bridge.mjs";

const text = value => typeof value === "string" && value.trim().length > 0;
const validKey = value => typeof value === "string" && /^[a-f0-9]{18}$/.test(value);
const bindings = ["sessionId", "epoch", "selectionId", "botId", "chatId", "threadId"];
export const phoneInputHash = value => createHash("sha256").update(value).digest("hex");
export const firstReplyEligible = (state, input) => Boolean(input && state.enabled && state.peer && state.bot &&
    state.sessions[input.sessionId]?.idleSelectionId === input.selectionId &&
    state.idleEpoch === input.epoch && state.bot.id === input.botId && state.peer.chatId === input.chatId);

function validate(value) {
    const publicIdentity = text(value?.messageId) && value.completionEventId === null ||
        value?.messageId === null && text(value.completionEventId) && value.completionEventId === value.eventId;
    if (value?.version !== 1 || !validKey(value.inputId) || !safeId(value.sessionId) ||
        !text(value.epoch) || !text(value.selectionId) || !Number.isSafeInteger(value.botId) ||
        !Number.isSafeInteger(value.chatId) || !(value.threadId === null || Number.isSafeInteger(value.threadId)) ||
        !text(value.triggerEventId) || !text(value.eventId) || !publicIdentity ||
        !text(value.interactionId) || !text(value.turnId) || !text(value.content) ||
        !text(value.receivedAt) || !Number.isFinite(Date.parse(value.receivedAt))) {
        throw new Error("The first-reply capture has an unsupported format; nothing was forwarded.");
    }
}

export class FirstReplyStore {
    constructor(directory) { this.directory = join(directory, "first-replies"); }
    path(id) {
        if (!validKey(id)) throw new Error("Invalid first-reply input ID.");
        return join(this.directory, `${id}.json`);
    }
    async write(value) {
        validate(value);
        await mkdir(this.directory, { recursive: true });
        await atomicWrite(this.path(value.inputId), JSON.stringify(value));
    }
    async read(input) {
        let source;
        try { source = await readText(this.path(input.id)); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
        let value;
        try { value = JSON.parse(source); }
        catch { throw new Error("The first-reply cache is corrupt; nothing was forwarded."); }
        validate(value);
        return value.inputId === input.id && bindings.every(field => value[field] === input[field]) ? value : null;
    }
    async remove(id) { await removeFile(this.path(id)); }
    async clear(ids) { for (const id of ids) await this.remove(id); }
    async watch(onChange, onError) {
        await mkdir(this.directory, { recursive: true });
        const watcher = watch(this.directory, (_, filename) => {
            if (filename === null || /^[a-f0-9]{18}\.json$/.test(String(filename))) onChange();
        });
        watcher.on("error", error => { watcher.close(); onError(error); });
        return watcher;
    }
}

export class FirstReplyListener {
    constructor({ sessionId, stateStore, replies, notify }) {
        if (!safeId(sessionId)) throw new Error("Invalid first-reply listener session ID.");
        Object.assign(this, { sessionId, stateStore, replies, notify });
        this.queue = Promise.resolve();
        this.active = new Map();
        this.streams = new Map();
        this.turn = null;
    }
    handle(event) {
        if (event.agentId || event.data?.parentToolCallId ||
            !["user.message", "user_input.completed", "assistant.turn_start", "assistant.message_start",
                "assistant.message_delta", "assistant.message", "session.task_complete", "session.idle"].includes(event.type)) return this.queue;
        this.queue = this.queue.then(() => this.capture(event)).catch(error => {
            this.active.clear(); this.streams.clear();
            return this.notify(error.message);
        });
        return this.queue;
    }
    async capture(event) {
        const state = await this.stateStore.load(), data = event.data ?? {};
        const inputs = Object.values(state.phoneInputs ?? {}).filter(input =>
            input.sessionId === this.sessionId && firstReplyEligible(state, input) &&
            ["attempting", "accepted"].includes(input.state) && !input.delivery);
        for (const id of this.active.keys()) if (!inputs.some(input => input.id === id)) this.active.delete(id);
        if (event.type === "session.idle") {
            this.active.clear(); this.streams.clear(); this.turn = null;
            return;
        }
        if (event.type === "user.message" || event.type === "user_input.completed") {
            const isMessage = event.type === "user.message";
            const value = isMessage ? data.content : data.answer;
            const candidates = inputs.filter(input => input.kind === (isMessage ? "message" : "answer") &&
                Date.parse(event.timestamp) >= input.createdAt && typeof value === "string" &&
                phoneInputHash(value) === input.inputHash &&
                (isMessage ? data.source === `agent-${input.senderId}` && !data.isAutopilotContinuation
                    : data.requestId === input.requestId));
            if (!candidates.length) { this.active.clear(); this.streams.clear(); return; }
            if (candidates.length !== 1) throw new Error("Phone input attribution is ambiguous; no first reply was guessed.");
            if (!text(event.id) || !Number.isFinite(Date.parse(event.timestamp)) ||
                isMessage && (!text(data.messageId) || !text(data.interactionId) || !text(data.turnId))) {
                throw new Error("Phone input lacks native message/turn identity; first-reply capture is unavailable.");
            }
            const input = candidates[0];
            if (await this.replies.read(input)) return;
            const interactionId = isMessage ? data.interactionId : this.turn?.interactionId ?? null;
            if (isMessage) this.turn = { interactionId: data.interactionId, turnId: data.turnId };
            for (const [id, active] of this.active) {
                if (active.interactionId !== interactionId) this.active.delete(id);
            }
            this.streams.clear();
            this.active.set(input.id, { input, triggerEventId: event.id, interactionId,
                turnId: isMessage ? data.turnId : null });
            return;
        }
        if (event.type === "assistant.turn_start") {
            this.streams.clear();
            this.turn = { interactionId: data.interactionId, turnId: data.turnId };
            for (const [id, active] of this.active) {
                if (!text(data.interactionId) || !text(data.turnId) ||
                    active.interactionId !== null && active.interactionId !== data.interactionId) {
                    this.active.delete(id);
                } else {
                    active.interactionId = data.interactionId;
                    active.turnId = data.turnId;
                }
            }
            return;
        }
        if (!this.active.size) return;
        if (event.type === "assistant.message_start") {
            if (text(data.messageId) && !this.streams.has(data.messageId)) {
                this.streams.set(data.messageId, { chunks: [], events: new Set() });
            }
            return;
        }
        if (event.type === "assistant.message_delta") {
            const stream = this.streams.get(data.messageId);
            if (stream && text(event.id) && typeof data.deltaContent === "string" && !stream.events.has(event.id)) {
                stream.events.add(event.id); stream.chunks.push(data.deltaContent);
            }
            return;
        }
        const completion = event.type === "session.task_complete";
        const stream = this.streams.get(data.messageId);
        this.streams.delete(data.messageId);
        if (event.ephemeral || data.phase !== undefined && !["commentary", "final", "final_answer", "response"].includes(data.phase)) return;
        const content = completion ? data.summary
            : typeof data.content === "string" ? data.content || stream?.chunks.join("") : null;
        if (!text(content)) return;
        const interactionId = completion ? this.turn?.interactionId : data.interactionId;
        const turnId = completion ? this.turn?.turnId : data.turnId;
        if (!completion && !text(data.messageId) || !text(interactionId) || !text(turnId)) {
            throw new Error("Public reply lacks native message/turn identity; no first reply was forwarded.");
        }
        for (const [id, active] of this.active) {
            if (active.interactionId !== interactionId || active.turnId !== turnId) continue;
            if (!await this.replies.read(active.input)) {
                await this.replies.write({
                    version: 1, inputId: id, ...Object.fromEntries(bindings.map(field => [field, active.input[field]])),
                    triggerEventId: active.triggerEventId, eventId: event.id,
                    messageId: completion ? null : data.messageId, completionEventId: completion ? event.id : null,
                    interactionId, turnId, receivedAt: event.timestamp, content,
                });
                const current = await this.stateStore.load();
                if (!firstReplyEligible(current, current.phoneInputs?.[id])) await this.replies.remove(id);
            }
            this.active.delete(id);
        }
    }
    async close() { await this.queue; this.active.clear(); this.streams.clear(); this.turn = null; }
}
