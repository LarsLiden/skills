import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, readText } from "./storage.mjs";
import { safeId } from "./bridge.mjs";

export const INACTIVITY_MS = 15 * 60_000;
export const OBSERVATION_GAP_MS = 45_000;
const activityEvents = new Set([
    "user.message", "pending_messages.modified", "abort",
    "assistant.turn_start", "assistant.turn_end", "assistant.intent", "assistant.message",
    "assistant.message_start", "assistant.message_delta", "assistant.reasoning",
    "assistant.reasoning_delta", "assistant.streaming_delta",
    "tool.user_requested", "tool.execution_start", "tool.execution_progress",
    "tool.execution_partial_result", "tool.execution_complete",
    "subagent.started", "subagent.completed", "subagent.failed", "subagent.selected", "subagent.deselected",
    "permission.requested", "permission.completed", "user_input.requested", "user_input.completed",
    "elicitation.requested", "elicitation.completed", "exit_plan_mode.requested", "exit_plan_mode.completed",
    "external_tool.requested", "external_tool.completed", "command.queued", "command.execute", "command.completed",
    "system.notification", "session.idle", "session.start", "session.resume", "session.error",
    "session.shutdown", "session.task_complete", "session.background_tasks_changed", "session.plan_changed",
]);

export class ActivityStore {
    constructor(directory) { this.directory = join(directory, "activity"); }
    path(id) {
        if (!safeId(id)) throw new Error("Invalid activity session ID.");
        return join(this.directory, `${id}.json`);
    }
    async write(value) {
        await mkdir(this.directory, { recursive: true });
        await atomicWrite(this.path(value.sessionId), JSON.stringify(value));
    }
    async read(id, epoch, selectionId) {
        let source;
        try { source = await readText(this.path(id)); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
        let value;
        try { value = JSON.parse(source); }
        catch { throw new Error("The activity observation is corrupt; inactivity was not confirmed."); }
        if (value?.version !== 1 || value.sessionId !== id ||
            !["epoch", "selectionId", "revision"].every(field => typeof value[field] === "string" && value[field]) ||
            !Number.isFinite(value.seenAt) || typeof value.busy !== "boolean" ||
            typeof value.available !== "boolean" || typeof value.blocked !== "boolean") {
            throw new Error("The activity observation has an unsupported format; inactivity was not confirmed.");
        }
        return value.epoch === epoch && value.selectionId === selectionId ? value : null;
    }
}

// Keep only identities and observation flags, never tool output or message text.
export class ActivityListener {
    constructor({ sessionId, stateStore, observations, notify, now = Date.now }) {
        Object.assign(this, { sessionId, stateStore, observations, notify, now });
        if (!safeId(sessionId)) throw new Error("Invalid activity-listener session ID.");
        this.queue = Promise.resolve();
        this.value = null;
        this.events = new Set();
        this.pending = new Set();
        this.closed = false;
        this.failed = false;
    }
    enqueue(operation) {
        this.queue = this.queue.then(operation).catch(async error => {
            this.failed = true;
            if (this.value) {
                this.value.available = false;
                this.value.revision = randomUUID();
                try { await this.observations.write(this.value); }
                catch (writeError) { await this.notify(writeError.message); }
            }
            await this.notify(error.message);
        });
        return this.queue;
    }
    heartbeat() { return this.enqueue(() => this.record()); }
    handle(event) {
        if (!activityEvents.has(event.type)) return this.queue;
        return this.enqueue(() => this.record(event));
    }
    async record(event) {
        if (this.closed) return;
        const state = await this.stateStore.load();
        const selectionId = state.sessions[this.sessionId]?.idleSelectionId;
        if (!state.enabled || !state.peer || !state.idleEpoch || !selectionId) {
            this.value = null; this.events.clear(); this.pending.clear();
            return;
        }
        const now = this.now();
        if (!this.value || this.value.epoch !== state.idleEpoch || this.value.selectionId !== selectionId) {
            this.events.clear(); this.pending.clear();
            this.value = { version: 1, sessionId: this.sessionId, epoch: state.idleEpoch, selectionId,
                revision: randomUUID(), seenAt: now, busy: false, available: !this.failed, blocked: false };
        } else if (now < this.value.seenAt || now - this.value.seenAt > OBSERVATION_GAP_MS) {
            this.value.revision = randomUUID();
        }
        if (event && !this.events.has(event.id)) {
            if (typeof event.id !== "string" || !event.id) throw new Error("Activity event identity is unavailable.");
            this.events.add(event.id);
            if (this.events.size > 512) this.events.delete(this.events.values().next().value);
            const root = !event.agentId && !event.data?.parentToolCallId;
            const type = event.type;
            // A repeated idle signal is not new work, unlike a message/tool/job event.
            if (type !== "session.idle" || this.value.busy || !this.value.available) this.value.revision = randomUUID();
            if (root && type === "session.idle") {
                this.value.busy = false; this.value.available = true; this.failed = false;
            }
            else if (type === "user.message" || type === "assistant.turn_start" || type === "tool.execution_start") this.value.busy = true;
            if (root && ["session.error", "session.shutdown", "session.start", "session.resume"].includes(type)) this.value.available = false;
            const requestId = event.data?.requestId;
            const family = type.split(".")[0];
            if (["permission", "user_input", "elicitation", "exit_plan_mode"].includes(family)) {
                if (type.endsWith(".requested") && event.data?.resolvedByHook !== true) this.pending.add(`${family}:${requestId ?? event.id}`);
                if (type.endsWith(".completed")) this.pending.delete(`${family}:${requestId ?? event.id}`);
            }
            this.value.blocked = this.pending.size > 0;
        }
        this.value.seenAt = now;
        await this.observations.write(this.value);
    }
    async close() {
        await this.queue;
        this.closed = true;
        if (this.value) {
            this.value.available = false;
            this.value.revision = randomUUID();
            await this.observations.write(this.value);
        }
    }
}
