export const initialTopics = () => ({ enabled: false, botId: null, chatId: null, bridge: null, sessions: {} });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const thread = value => Number.isSafeInteger(value) && value > 0;
const rejected = error => [400, 401, 403, 404, 429].includes(error.apiCode);
const deletionStates = ["attempting", "uncertain", "rejected", "deleted"];
const deletionReasons = ["deselected", "archived", "deleted"];

export function validateTopics(state, safeId) {
    const t = state.topics;
    if (!object(t) || typeof t.enabled !== "boolean" || !object(t.sessions) ||
        (t.enabled && (t.botId !== state.bot?.id || t.chatId !== state.peer?.chatId ||
            !Number.isSafeInteger(t.botId) || !Number.isSafeInteger(t.chatId)))) {
        throw new Error("Saved topic ownership is invalid; no topic routing was enabled.");
    }
    const used = new Set();
    for (const [id, route] of [[null, t.bridge], ...Object.entries(t.sessions)]) {
        if (id !== null && (!safeId(id) || !Object.hasOwn(state.aliases, id))) {
            throw new Error("Saved topic session identity is invalid.");
        }
        if (route === null && id === null) continue;
        if (!object(route) || !["creating", "ready", "uncertain", "rejected"].includes(route.state) ||
            typeof route.name !== "string" || !route.name || route.name.length > 128 ||
            (route.state === "ready" && !thread(route.threadId)) ||
            (route.threadId !== null && (!thread(route.threadId) || used.has(route.threadId))) ||
            (route.rename !== undefined && (!object(route.rename) || typeof route.rename.name !== "string" ||
                !["attempting", "uncertain", "rejected"].includes(route.rename.state)))) {
            throw new Error("Saved topic binding is invalid or duplicated; repair it before starting.");
        }
        if (route.threadId !== null) used.add(route.threadId);
        if (route.deletion !== undefined && (!object(route.deletion) || !thread(route.threadId) ||
            !deletionStates.includes(route.deletion.state) || !deletionReasons.includes(route.deletion.reason) ||
            !Number.isFinite(Date.parse(route.deletion.requestedAt)) ||
            (route.deletion.state === "deleted" && !Number.isFinite(Date.parse(route.deletion.completedAt))))) {
            throw new Error("Saved topic deletion receipt is invalid; no cleanup was attempted.");
        }
        if (route.retired !== undefined && !Array.isArray(route.retired)) throw new Error("Saved retired topic identities are invalid.");
        for (const old of route.retired ?? []) {
            if (!object(old) || !thread(old.threadId) || used.has(old.threadId) ||
                old.deletion?.state !== "deleted" || !deletionReasons.includes(old.deletion.reason) ||
                !Number.isFinite(Date.parse(old.deletion.completedAt))) {
                throw new Error("Saved retired topic identity is invalid or duplicated.");
            }
            used.add(old.threadId);
        }
    }
}

export class TopicRouter {
    constructor(bridge) { this.bridge = bridge; }
    get state() { return this.bridge.state.topics; }

    async enable(signal) {
        const b = this.bridge;
        if (signal?.aborted) throw new Error("Topic setup canceled.");
        if (!b.state.peer || !b.state.enabled) throw new Error("Connect and pair your phone before enabling topics.");
        const bot = await b.telegram.identity();
        if (signal?.aborted) throw new Error("Topic setup canceled.");
        if (bot.id !== b.state.bot?.id) throw new Error("Saved bot identity changed; topic activation refused.");
        if (!bot.hasTopicsEnabled) throw new Error("Enable private-chat topics for this bot in BotFather, then try again.");
        b.state.bot = bot;
        if (!this.state.enabled) {
            const next = { ...b.state, topics: { ...this.state, enabled: true, botId: bot.id, chatId: b.state.peer.chatId } };
            await b.store.save(next);
            b.state = next;
        }
        await this.sync(true, signal);
    }

    async sync(retryRejected = false, signal) {
        if (!this.state.enabled) return;
        validateTopics(this.bridge.state, id => Object.hasOwn(this.bridge.state.aliases, id));
        const jobs = [[this.state, "bridge", "Bridge", true]];
        for (const id of new Set([...Object.keys(this.state.sessions), ...Object.keys(this.bridge.state.sessions)])) {
            const selected = this.bridge.state.sessions[id];
            const existing = this.state.sessions[id];
            const title = selected ? selected.name : existing.name;
            jobs.push([this.state.sessions, id, title.slice(0, 128), Boolean(selected)]);
        }
        const errors = [];
        for (const job of jobs) {
            if (signal?.aborted) {
                errors.push("Topic setup canceled; completed topic identities were retained.");
                break;
            }
            try {
                const [container, id, name, active] = job;
                if (active) await this.ensure(container, id, name, retryRejected);
                else await this.remove(container[id], retryRejected, signal);
            }
            catch (error) { errors.push(error.message); }
        }
        if (errors.length) throw new Error(errors.join("\n"));
    }

    async ensure(container, id, name, retryRejected) {
        if (!name.trim()) throw new Error("Session topic name is empty; name the session in Copilot before syncing topics.");
        const b = this.bridge;
        let route = container[id];
        if (route?.deletion && route.deletion.state !== "deleted") {
            throw new Error(`${name}: topic deletion ${route.deletion.state}; inspect before selecting again.`);
        }
        if (route?.deletion?.state === "deleted") {
            route = container[id] = { state: "rejected", threadId: null, name,
                retired: [...route.retired ?? [], { threadId: route.threadId, deletion: route.deletion }] };
            retryRejected = true;
        }
        if (!route || (route.state === "rejected" && retryRejected)) {
            route = container[id] = { state: "creating", threadId: null, name, ...(route?.retired ? { retired: route.retired } : {}) };
            await b.save();
            try {
                const result = await b.telegram.createTopic(this.state.chatId, name);
                const used = [this.state.bridge, ...Object.values(this.state.sessions)]
                    .some(other => other !== route && other?.threadId === result?.message_thread_id ||
                        other?.retired?.some(old => old.threadId === result?.message_thread_id));
                if (!thread(result?.message_thread_id) || used) throw new Error("Topic creation returned an invalid or duplicate identity.");
                route.threadId = result.message_thread_id;
                route.state = "ready";
                await b.save();
            } catch (error) {
                route.state = rejected(error) ? "rejected" : "uncertain";
                await b.save();
                throw new Error(`${name}: topic creation ${route.state}. ${error.message}`);
            }
        }
        if (route.state !== "ready") throw new Error(`${name}: topic creation ${route.state}; inspect Telegram and the setup panel. No automatic retry.`);
        if (route.rename && !(route.rename.state === "rejected" && retryRejected)) {
            throw new Error(`${name}: topic rename ${route.rename.state}; routing still uses the original topic ID. No automatic retry.`);
        }
        if (route.name === name && !route.rename) return;
        route.rename = { name, state: "attempting" };
        await b.save();
        try {
            await b.telegram.editTopic(this.state.chatId, route.threadId, name);
            route.name = name;
            delete route.rename;
            await b.save();
        } catch (error) {
            route.rename = { name, state: rejected(error) ? "rejected" : "uncertain" };
            await b.save();
            throw new Error(`${name}: topic rename ${route.rename.state}. ${error.message}`);
        }
    }

    async remove(route, retryRejected, signal) {
        const owner = Object.entries(this.state.sessions).find(([, value]) => value === route);
        if (!owner || this.bridge.state.sessions[owner[0]]) {
            throw new Error("This topic is not eligible for deletion; Bridge and selected sessions are protected.");
        }
        if (!route || route.deletion?.state === "deleted" || route.state === "rejected" && route.threadId === null) return;
        if (route.state !== "ready" || !thread(route.threadId)) {
            throw new Error(`${route.name}: topic identity uncertain; deletion requires inspection.`);
        }
        if (route.deletion && !(route.deletion.state === "rejected" && retryRejected)) {
            throw new Error(`${route.name}: topic deletion ${route.deletion.state}; no automatic retry.`);
        }
        if (signal?.aborted) throw new Error("Topic deletion canceled before dispatch.");
        const b = this.bridge;
        const deletion = { state: "attempting", reason: route.retirementReason ?? "deselected",
            requestedAt: new Date().toISOString() };
        await b.store.save({ ...b.state, topics: { ...this.state, sessions: Object.fromEntries(
            Object.entries(this.state.sessions).map(([id, value]) => [id, value === route ? { ...route, deletion } : value])) } });
        route.deletion = deletion;
        if (signal?.aborted) {
            route.deletion.state = "rejected";
            await b.save();
            throw new Error("Topic deletion canceled before dispatch; explicit Sync is required to try again.");
        }
        try {
            await b.telegram.deleteTopic(this.state.chatId, route.threadId);
            route.deletion.state = "deleted";
            route.deletion.completedAt = new Date().toISOString();
            delete route.closureIssue;
            await b.save();
        } catch (error) {
            route.deletion.state = rejected(error) ? "rejected" : "uncertain";
            delete route.deletion.completedAt;
            await b.save();
            throw new Error(`${route.name}: topic deletion ${route.deletion.state}. ${error.message}`);
        }
    }

    isRetired(threadId) {
        return thread(threadId) && Object.values(this.state.sessions).some(route =>
            route.deletion && route.threadId === threadId || route.retired?.some(old => old.threadId === threadId));
    }

    destination(sessionId) {
        if (!this.state.enabled) return null;
        const route = sessionId === undefined ? this.state.bridge : this.state.sessions[sessionId];
        if (route?.state !== "ready" || route.deletion) throw new Error("The destination topic is not ready. No message was sent to the main chat.");
        return route.threadId;
    }

    context(threadId) {
        if (threadId === null) return { kind: "bridge" };
        if (!thread(threadId) || !this.state.enabled) return { kind: "unknown" };
        if (this.isRetired(threadId)) return { kind: "retired" };
        if (this.state.bridge?.state === "ready" && this.state.bridge.threadId === threadId) return { kind: "bridge" };
        for (const [id, route] of Object.entries(this.state.sessions)) {
            if (route.state === "ready" && route.threadId === threadId) {
                return { kind: this.bridge.state.sessions[id] ? "session" : "inactive", sessionId: id };
            }
        }
        return { kind: "unknown" };
    }

    status() {
        const routes = [this.state.bridge, ...Object.values(this.state.sessions)].filter(Boolean);
        return {
            enabled: this.state.enabled,
            ready: Object.values(this.state.sessions).filter(r => r.state === "ready" && !r.deletion).length,
            issues: routes.flatMap(r => r.deletion ? r.deletion.state === "deleted" ? [] : [`${r.name}: deletion ${r.deletion.state}.`]
                : r.state !== "ready" ? [`${r.name}: creation ${r.state}.`]
                : [...(r.rename ? [`${r.name}: rename ${r.rename.state}.`] : []),
                    ...(r.closureIssue ? [`${r.name}: ${r.closureIssue}`] : [])]),
        };
    }
}
