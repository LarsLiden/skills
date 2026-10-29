import { Bridge, initialState } from "./bridge.mjs";
import { Telegram } from "./telegram.mjs";
import { Store, Vault, acquireOwner } from "./storage.mjs";
import { randomUUID } from "node:crypto";
import { IdleReplyStore } from "./idle.mjs";
import { AnswerReceiptStore } from "./answers.mjs";
import { FirstReplyStore } from "./first-reply.mjs";
import { ActivityStore } from "./activity.mjs";

const wait = (ms, signal) => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
});

export class Service {
    constructor({ app, directory, selfId, notify = () => {} }) {
        Object.assign(this, { app, directory, selfId, notify });
        this.store = new Store(directory);
        this.vault = new Vault(directory);
        this.idleReplies = new IdleReplyStore(directory);
        this.answerReceipts = new AnswerReceiptStore(directory);
        this.firstReplies = new FirstReplyStore(directory);
        this.observations = new ActivityStore(directory);
        this.bridge = new Bridge({ app, store: this.store, selfId, idleReplies: this.idleReplies,
            answerReceipts: this.answerReceipts, firstReplies: this.firstReplies, observations: this.observations });
        this.queue = Promise.resolve();
        this.error = null;
        this.health = Object.fromEntries(["poll", "monitor", "inbound", "reply", "action"].map(name => [name, {
            error: null, lastAttempt: null, lastSuccess: null, lastFailure: null, lastError: null,
            consecutiveFailures: 0, recoveredAt: null,
        }]));
        this.connected = false;
        this.lastSync = null;
        this.initialized = false;
        this.releaseOwner = null;
        this.controller = null;
        this.firstReplyWatcher = null;
        this.finalReplyWatcher = null;
    }

    async initialize() {
        if (this.initialized) return;
        this.releaseOwner = await acquireOwner(this.directory);
        try {
            await this.bridge.load();
            this.bridge.state.enabled = false;
            for (const r of Object.values(this.bridge.state.requests)) {
                if (r.state === "pending") r.state = "revoked";
                if (r.state === "attempting") r.state = "uncertain";
                if (r.messageUpdate?.state === "attempting") r.messageUpdate.state = "uncertain";
            }
            for (const signal of Object.values(this.bridge.state.signals)) {
                if (signal.idleDelivery?.state === "notifying") signal.idleDelivery.state = "uncertain";
                if (signal.inactivityDelivery?.state === "notifying") signal.inactivityDelivery.state = "uncertain";
            }
            for (const input of Object.values(this.bridge.state.phoneInputs ?? {})) {
                if (input.state === "attempting") input.state = "uncertain";
                if (input.delivery?.state === "attempting") input.delivery.state = "uncertain";
            }
            for (const route of [this.bridge.state.topics.bridge, ...Object.values(this.bridge.state.topics.sessions)]) {
                if (route?.state === "creating") route.state = "uncertain";
                if (route?.rename?.state === "attempting") route.rename.state = "uncertain";
                if (route?.deletion?.state === "attempting") route.deletion.state = "uncertain";
            }
            await this.bridge.save();
            this.configured = (await this.vault.load()) !== null;
            this.initialized = true;
        } catch (error) {
            await this.releaseOwner(); this.releaseOwner = null;
            throw error;
        }
    }

    serial(operation, lane = "action") {
        const next = this.queue.then(operation);
        this.queue = next.catch(error => {
            if (lane) {
                this.report(error, lane);
                if (this.bridge.persistenceFailed) this.pauseReceiving();
            }
        });
        return next;
    }

    pauseReceiving() {
        this.bridge.expireDestinations("Receiving paused; buffered messages were discarded.");
        this.controller?.abort();
        this.firstReplyWatcher?.close(); this.firstReplyWatcher = null;
        this.finalReplyWatcher?.close(); this.finalReplyWatcher = null;
        this.bridge.quiet.clear();
        this.connected = false;
        this.bridge.state.enabled = false;
    }

    report(error, lane = "action") {
        const message = error.message || "Telegram bridge operation failed.";
        const health = this.health[lane];
        const diagnostic = error.diagnostic;
        const signature = diagnostic ? JSON.stringify([diagnostic.method, diagnostic.stage, diagnostic.code]) : message;
        if (!health.error || signature !== health.signature) this.notify(`Telegram bridge ${lane}: ${message}`);
        Object.assign(health, { error: message, lastError: message, signature,
            lastFailure: new Date().toISOString(), consecutiveFailures: health.consecutiveFailures + 1 });
        this.error = Object.values(this.health).filter(item => item.error).map(item => item.error).join("\n") || null;
    }

    succeeded(lane) {
        const health = this.health[lane], at = new Date().toISOString();
        if (health.error) health.recoveredAt = at;
        Object.assign(health, { error: null, lastSuccess: at, consecutiveFailures: 0 });
        this.error = Object.values(this.health).filter(item => item.error).map(item => item.error).join("\n") || null;
    }

    async status() {
        await this.initialize();
        const b = this.bridge;
        return {
            configured: this.configured, connected: this.connected, started: Boolean(this.controller), enabled: b.state.enabled,
            bot: b.state.bot, peer: b.state.peer, ownerSessionId: this.selfId,
            error: this.error, lastSync: this.lastSync, notifyIdle: b.state.notifyIdle,
            health: structuredClone(this.health),
            inbound: {
                lastUpdate: b.state.lastUpdate, paused: b.persistenceFailed,
                pendingDestinations: [...b.pendingDestinations.values()]
                    .filter(input => b.state.inbound[input.sourceUpdateId]?.destinationChoice?.state === "pending").length,
                recent: Object.values(b.state.inbound ?? {}).sort((a, b) => b.updateId - a.updateId).slice(0, 20),
            },
            topics: b.topics.status(),
            questionUpdates: { supported: true,
                updated: Object.values(b.state.requests).filter(r => r.messageUpdate?.state === "sent").length,
                unresolved: Object.values(b.state.requests).filter(r => ["attempting", "uncertain"].includes(r.messageUpdate?.state)).length },
            pairing: b.pairing ? { expires: b.pairing.expires, candidate: b.pairing.candidate,
                link: b.state.bot ? `https://t.me/${b.state.bot.username}?start=${b.pairing.code}` : null } : null,
            sessions: b.rows.filter(r => r.id !== this.selfId).map(r => ({
                id: r.id, name: String(r.name ?? r.id), project: String(r.project_name ?? "Chat"),
                activity: r.awaiting_user_input || r.awaiting_plan_approval ? "needs input" : r.activity?.status ?? "unknown",
                selected: Boolean(b.state.sessions[r.id]), alias: b.state.sessions[r.id]?.alias ?? null,
            })),
            selectedMissing: Object.entries(b.state.sessions).filter(([id]) => !b.rows.some(r => r.id === id))
                .map(([id, selected]) => ({ id, name: selected.name || id, alias: selected.alias })),
            unresolved: Object.values(b.state.requests).filter(r => ["uncertain", "notification-uncertain", "notifying"].includes(r.state))
                .map(r => ({ sessionId: r.sessionId, state: r.state }))
                .concat(Object.entries(b.state.signals).filter(([, s]) => ["notifying", "uncertain"].includes(s.idleDelivery?.state))
                    .map(([sessionId]) => ({ sessionId, state: "idle-notification-uncertain" })))
                .concat(Object.entries(b.state.signals).filter(([, s]) => ["notifying", "uncertain"].includes(s.inactivityDelivery?.state))
                    .map(([sessionId]) => ({ sessionId, state: "inactivity-notification-uncertain" })))
                .concat(Object.values(b.state.requests).filter(r => ["attempting", "uncertain"].includes(r.messageUpdate?.state))
                    .map(r => ({ sessionId: r.sessionId, state: "question-update-uncertain" })))
                .concat(Object.values(b.state.phoneInputs ?? {}).filter(input => ["attempting", "uncertain"].includes(input.state))
                    .map(input => ({ sessionId: input.sessionId, state: "phone-input-uncertain" })))
                .concat(Object.values(b.state.phoneInputs ?? {}).filter(input => ["attempting", "uncertain"].includes(input.delivery?.state))
                    .map(input => ({ sessionId: input.sessionId, state: "first-reply-uncertain" })))
                .concat(Object.values(b.state.inbound ?? {}).filter(input => input.failure ||
                    ["received", "attempting", "uncertain", "interrupted"].includes(input.state))
                    .map(input => ({ sessionId: input.sessionId ?? null, updateId: input.updateId,
                        state: `inbound-${input.state}` }))),
        };
    }

    async refresh(signal = this.controller?.signal) {
        if (this.bridge.persistenceFailed) throw new Error("Incoming receiving is paused after a storage failure; inspect the saved state before restarting.");
        this.health.monitor.lastAttempt = new Date().toISOString();
        await this.bridge.sync(signal);
        this.lastSync = new Date().toISOString();
        this.succeeded("monitor");
    }

    async action(input) {
        await this.initialize();
        if (!input || typeof input.action !== "string") throw new Error("Select a valid panel action.");
        if (this.bridge.persistenceFailed && input.action !== "stop") {
            throw new Error("Incoming receiving is paused after a storage failure; inspect the saved state before restarting.");
        }
        if (input.action === "stop" || input.action === "forget" || input.action === "configure") await this.stop();
        return this.serial(async () => {
            switch (input.action) {
                case "refresh": await this.refresh(); break;
                case "configure": {
                    if (typeof input.token !== "string") throw new Error("Enter the token locally.");
                    const telegram = new Telegram(input.token.trim());
                    const bot = await telegram.identity();
                    await telegram.checkWebhook();
                    await this.answerReceipts.clear(Object.keys(this.bridge.state.requests));
                    await this.firstReplies.clear(Object.keys(this.bridge.state.phoneInputs ?? {}));
                    await this.vault.save(input.token.trim());
                    this.bridge.state = { ...initialState(), aliases: this.bridge.state.aliases };
                    this.bridge.state.bot = bot;
                    this.bridge.pairing = null;
                    await this.bridge.save();
                    this.configured = true;
                    await this.connect(telegram);
                    break;
                }
                case "connect": await this.connect(); break;
                case "topics":
                    if (!this.connected || !this.bridge.state.enabled) throw new Error("Connect and pair your phone before enabling topics.");
                    await this.bridge.enableTopics(this.controller?.signal);
                    await this.refresh();
                    break;
                case "pair":
                    if (!this.connected) throw new Error("Connect a dedicated bot first.");
                    await this.bridge.beginPairing(); break;
                case "confirm":
                    if (!this.connected) throw new Error("Reconnect the bot before confirming its phone account.");
                    await this.bridge.confirmPairing(input.userId);
                    this.bridge.state.enabled = true;
                    await this.bridge.save();
                    await this.bridge.say("Phone paired. Select sessions in the local panel. Use /help for commands.");
                    break;
                case "optIn":
                    if (typeof input.enabled !== "boolean") throw new Error("Session selection must be explicit.");
                    await this.bridge.setOptIn(input.sessionId, input.enabled);
                    if (!input.enabled) await this.idleReplies.remove(input.sessionId);
                    if (!input.enabled) await this.answerReceipts.clear(Object.values(this.bridge.state.requests)
                        .filter(r => r.sessionId === input.sessionId).map(r => r.key));
                    await this.refresh();
                    break;
                case "idle":
                    if (typeof input.enabled !== "boolean") throw new Error("Idle notification preference must be explicit.");
                    this.bridge.state.notifyIdle = input.enabled;
                    this.bridge.quiet.clear();
                    await this.bridge.save();
                    break;
                case "stop": break;
                case "forget":
                    await this.vault.clear();
                    await this.idleReplies.clear(Object.keys(this.bridge.state.aliases));
                    await this.answerReceipts.clear(Object.keys(this.bridge.state.requests));
                    await this.firstReplies.clear(Object.keys(this.bridge.state.phoneInputs ?? {}));
                    this.bridge.state = initialState();
                    this.bridge.pairing = null;
                    await this.bridge.save();
                    this.configured = false;
                    break;
                default: throw new Error("Unsupported panel action.");
            }
            this.succeeded("action");
            return this.status();
        });
    }

    async connect(existing) {
        if (this.controller) throw new Error("The bot is already connected.");
        if (this.bridge.persistenceFailed) throw new Error("Inbound receiving is paused after a storage failure; inspect the saved state before restarting.");
        this.bridge.expireDestinations("New connection; old destination choices cannot send messages.");
        let telegram = existing;
        if (!telegram) {
            const token = await this.vault.load();
            if (!token) throw new Error("Configure a dedicated Telegram bot first.");
            telegram = new Telegram(token);
            const bot = await telegram.identity();
            if (this.bridge.state.bot?.id !== bot.id) throw new Error("Saved bot identity changed; configure and pair again.");
            if (this.bridge.state.topics.enabled && !bot.hasTopicsEnabled) {
                throw new Error("Private-chat topics were disabled in BotFather. Re-enable them before reconnecting; messages will not be rerouted.");
            }
            this.bridge.state.bot = bot;
            await telegram.checkWebhook();
        }
        // Discard updates from before this explicit connection; old control messages are never replayed.
        const tail = await telegram.call("getUpdates", { offset: -1, timeout: 0, limit: 1,
            allowed_updates: ["message", "callback_query"] });
        if (!Array.isArray(tail) || tail.some(u => !Number.isSafeInteger(u.update_id))) {
            throw new Error("Telegram could not establish a fresh update boundary.");
        }
        if (tail.length) this.bridge.state.lastUpdate = tail.at(-1).update_id;
        await this.bridge.clearFirstReplies();
        this.bridge.telegram = telegram;
        this.bridge.state.enabled = Boolean(this.bridge.state.peer);
        this.bridge.state.idleEpoch = randomUUID();
        this.bridge.quiet.clear();
        for (const selected of Object.values(this.bridge.state.sessions)) selected.idleSelectionId ??= randomUUID();
        for (const signal of Object.values(this.bridge.state.signals)) {
            delete signal.activity; delete signal.busySince; delete signal.busyReplyEventId; delete signal.idlePending;
        }
        await this.bridge.save();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        try {
            this.firstReplyWatcher = await this.firstReplies.watch(() => {
                if (this.connected && !signal.aborted) {
                    void this.serial(async () => {
                        await this.bridge.forwardFirstReplies(signal);
                        this.succeeded("reply");
                    }, "reply").catch(() => {});
                }
            }, error => this.report(error, "reply"));
            this.finalReplyWatcher = await this.idleReplies.watch(() => {
                if (!this.connected || signal.aborted || this.finalRefreshPending) return;
                this.finalRefreshPending = true;
                void this.serial(async () => {
                    try {
                        if (!signal.aborted) {
                            await this.refresh(signal);
                            this.succeeded("reply");
                        }
                    } finally { this.finalRefreshPending = false; }
                }, "reply").catch(() => {});
            }, error => this.report(error, "reply"));
        } catch (error) {
            this.firstReplyWatcher?.close(); this.firstReplyWatcher = null;
            this.finalReplyWatcher?.close(); this.finalReplyWatcher = null;
            this.controller.abort(); this.controller = null;
            this.bridge.state.enabled = false;
            await this.bridge.save();
            throw error;
        }
        this.connected = true;
        this.polling = this.poll(signal);
        this.monitoring = this.monitor(signal);
    }

    async poll(signal) {
        while (!signal.aborted) {
            let lane = "poll";
            try {
                if (this.bridge.persistenceFailed) throw new Error("Inbound receiving is paused after a storage failure; inspect the saved state before restarting.");
                const offset = this.bridge.state.lastUpdate === null ? null : this.bridge.state.lastUpdate + 1;
                Object.assign(this.health.poll, { lastAttempt: new Date().toISOString(), lastOffset: offset });
                const updates = await this.bridge.telegram.updates(offset, signal);
                if (signal.aborted) break;
                this.health.poll.lastBatchSize = updates.length;
                this.succeeded("poll");
                lane = "inbound";
                for (const update of updates) {
                    if (signal.aborted) break;
                    // The catch below reports this failure once, with its inbound scope.
                    await this.serial(() => this.bridge.receive(update), null);
                    this.succeeded("inbound");
                }
            } catch (error) {
                if (signal.aborted) break;
                this.report(error, lane);
                if (this.bridge.persistenceFailed || error.apiCode === 409 || error.apiCode === 401) {
                    this.pauseReceiving();
                    if (!this.bridge.persistenceFailed) {
                        await this.serial(async () => {
                            await this.bridge.save();
                            await this.idleReplies.clear(Object.keys(this.bridge.state.sessions));
                        }, "inbound").catch(() => {});
                    }
                    break;
                }
                await wait((error.retryAfter ?? 5) * 1000, signal);
            }
        }
    }

    async monitor(signal) {
        while (!signal.aborted) {
            try { await this.serial(() => this.refresh(signal), "monitor"); }
            catch { /* serial records the scoped failure. */ }
            await wait(15_000, signal);
        }
    }

    async stop() {
        this.controller?.abort();
        this.firstReplyWatcher?.close(); this.firstReplyWatcher = null;
        this.finalReplyWatcher?.close(); this.finalReplyWatcher = null;
        this.bridge.quiet.clear();
        await Promise.all([this.polling, this.monitoring]);
        this.controller = null;
        this.connected = false;
        if (this.bridge.persistenceFailed) {
            this.bridge.expireDestinations("Disconnected; buffered messages were discarded.");
            this.bridge.state.enabled = false;
            return;
        }
        await this.serial(async () => {
            this.bridge.expireDestinations("Disconnected; buffered messages were discarded.");
            this.bridge.state.enabled = false;
            for (const r of Object.values(this.bridge.state.requests)) if (r.state === "pending") r.state = "revoked";
            await this.bridge.save();
            await this.idleReplies.clear(Object.keys(this.bridge.state.sessions));
            await this.bridge.clearFirstReplies();
            await this.bridge.save();
        });
    }

    async close() {
        if (this.initialized) await this.stop();
        if (this.releaseOwner) { await this.releaseOwner(); this.releaseOwner = null; }
        this.initialized = false;
    }
}
