import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, readText, removeFile } from "./storage.mjs";
import { safeId } from "./bridge.mjs";

const bindings = ["key", "sessionId", "requestId", "hash", "selectionId", "botId", "chatId"];
const matches = (value, request) => bindings.every(field => value[field] === request[field]);
const validKey = key => typeof key === "string" && /^[a-f0-9]{18}$/.test(key);
const captureStates = new Set(["notifying", "pending", "stale", "attempting", "uncertain"]);

function validate(value) {
    if (value?.version !== 1 || !validKey(value.key) || !safeId(value.sessionId) ||
        typeof value.requestId !== "string" || !value.requestId ||
        typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) ||
        typeof value.selectionId !== "string" || !value.selectionId ||
        !Number.isSafeInteger(value.botId) || !Number.isSafeInteger(value.chatId) ||
        !(value.answer === null || typeof value.answer === "string") ||
        typeof value.eventId !== "string" || !value.eventId ||
        typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) {
        throw new Error("The answer receipt has an unsupported format; no answer was forwarded.");
    }
}

export class AnswerReceiptStore {
    constructor(directory) { this.directory = join(directory, "answer-receipts"); }
    path(key) {
        if (!validKey(key)) throw new Error("Invalid answer-receipt key.");
        return join(this.directory, `${key}.json`);
    }
    async write(value) {
        validate(value);
        await mkdir(this.directory, { recursive: true });
        await atomicWrite(this.path(value.key), JSON.stringify(value));
    }
    async read(request) {
        let text;
        try { text = await readText(this.path(request.key)); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
        let value;
        try { value = JSON.parse(text); }
        catch { throw new Error("The answer receipt is corrupt; no answer was forwarded."); }
        validate(value);
        return matches(value, request) ? value : null;
    }
    async remove(key) {
        await removeFile(this.path(key));
    }
    async clear(keys) { for (const key of keys) await this.remove(key); }
}

export class AnswerListener {
    constructor({ sessionId, stateStore, receipts, notify }) {
        if (!safeId(sessionId)) throw new Error("Invalid answer-listener session ID.");
        Object.assign(this, { sessionId, stateStore, receipts, notify });
        this.queue = Promise.resolve();
    }
    eligible(state, request) {
        return state.enabled && state.peer && state.bot &&
            request?.sessionId === this.sessionId && captureStates.has(request.state) &&
            typeof request.selectionId === "string" &&
            state.sessions[this.sessionId]?.idleSelectionId === request.selectionId &&
            state.bot.id === request.botId && state.peer.chatId === request.chatId;
    }
    handle(event) {
        if (event.type !== "user_input.completed" || event.agentId || event.data?.parentToolCallId) return this.queue;
        this.queue = this.queue.then(() => this.capture(event)).catch(error => this.notify(error.message));
        return this.queue;
    }
    async capture(event) {
        const state = await this.stateStore.load();
        const requests = Object.values(state.requests).filter(request =>
            this.eligible(state, request) && request.requestId === event.data?.requestId);
        if (!requests.length) return;
        if (typeof event.id !== "string" || !event.id || !Number.isFinite(Date.parse(event.timestamp)) ||
            !(event.data.answer === undefined || typeof event.data.answer === "string")) {
            throw new Error("Question completion identity, timestamp or answer is unavailable.");
        }
        for (const request of requests) {
            const answer = event.data.answer ?? null;
            const existing = await this.receipts.read(request);
            if (existing) {
                if (existing.answer !== answer) throw new Error("Conflicting question completion; the original answer receipt was preserved.");
                continue;
            }
            await this.receipts.write({
                version: 1, ...Object.fromEntries(bindings.map(field => [field, request[field]])),
                answer, eventId: event.id, completedAt: event.timestamp,
            });
            const current = await this.stateStore.load();
            const retained = current.requests[request.key];
            if (!this.eligible(current, retained) || !matches(request, retained)) await this.receipts.remove(request.key);
        }
    }
    async close() { await this.queue; }
}
