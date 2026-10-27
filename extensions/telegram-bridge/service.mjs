import { Bridge, initialState } from "./bridge.mjs";
import { Telegram } from "./telegram.mjs";
import { Store, Vault, acquireOwner } from "./storage.mjs";
import { randomUUID } from "node:crypto";
import { IdleReplyStore } from "./idle.mjs";
import { AnswerReceiptStore } from "./answers.mjs";
import { FirstReplyStore } from "./first-reply.mjs";

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
        this.bridge = new Bridge({ app, store: this.store, selfId, idleReplies: this.idleReplies,
            answerReceipts: this.answerReceipts, firstReplies: this.firstReplies });
        this.queue = Promise.resolve();
        this.error = null;
        this.connected = false;
        this.lastSync = null;
        this.initialized = false;
        this.releaseOwner = null;
        this.controller = null;
        this.firstReplyWatcher = null;
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

    serial(operation) {
        const next = this.queue.then(operation);
        this.queue = next.catch(error => this.report(error));
        return next;
    }

    report(error) {
        const message = error.message || "Telegram bridge operation failed.";
        if (message !== this.error) this.notify(`Telegram bridge: ${message}`);
        this.error = message;
    }

    async status() {
        await this.initialize();
        const b = this.bridge;
        return {
            configured: this.configured, connected: this.connected, started: Boolean(this.controller), enabled: b.state.enabled,
            bot: b.state.bot, peer: b.state.peer, ownerSessionId: this.selfId,
            error: this.error, lastSync: this.lastSync, notifyIdle: b.state.notifyIdle,
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
                .concat(Object.values(b.state.requests).filter(r => ["attempting", "uncertain"].includes(r.messageUpdate?.state))
                    .map(r => ({ sessionId: r.sessionId, state: "question-update-uncertain" })))
                .concat(Object.values(b.state.phoneInputs ?? {}).filter(input => ["attempting", "uncertain"].includes(input.state))
                    .map(input => ({ sessionId: input.sessionId, state: "phone-input-uncertain" })))
                .concat(Object.values(b.state.phoneInputs ?? {}).filter(input => ["attempting", "uncertain"].includes(input.delivery?.state))
                    .map(input => ({ sessionId: input.sessionId, state: "first-reply-uncertain" }))),
        };
    }

    async refresh(signal = this.controller?.signal) {
        await this.bridge.sync(signal);
        this.lastSync = new Date().toISOString();
    }

    async action(input) {
        await this.initialize();
        if (!input || typeof input.action !== "string") throw new Error("Select a valid panel action.");
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
                    this.error = null;
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
                    this.bridge.state.idleEpoch = randomUUID();
                    for (const signal of Object.values(this.bridge.state.signals)) delete signal.idlePending;
                    await this.bridge.save();
                    await this.idleReplies.clear(Object.keys(this.bridge.state.sessions));
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
            return this.status();
        });
    }

    async connect(existing) {
        if (this.controller) throw new Error("The bot is already connected.");
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
        for (const selected of Object.values(this.bridge.state.sessions)) selected.idleSelectionId ??= randomUUID();
        for (const signal of Object.values(this.bridge.state.signals)) {
            delete signal.activity; delete signal.busySince; delete signal.idlePending;
        }
        await this.bridge.save();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        try {
            this.firstReplyWatcher = await this.firstReplies.watch(() => {
                if (this.connected && !signal.aborted) {
                    void this.serial(() => this.bridge.forwardFirstReplies(signal)).catch(error => this.report(error));
                }
            }, error => this.report(error));
        } catch (error) {
            this.controller.abort(); this.controller = null;
            this.bridge.state.enabled = false;
            await this.bridge.save();
            throw error;
        }
        this.error = null;
        this.connected = true;
        this.polling = this.poll(signal);
        this.monitoring = this.monitor(signal);
    }

    async poll(signal) {
        while (!signal.aborted) {
            try {
                const offset = this.bridge.state.lastUpdate === null ? null : this.bridge.state.lastUpdate + 1;
                const updates = await this.bridge.telegram.updates(offset, signal);
                for (const update of updates) {
                    if (signal.aborted) break;
                    await this.serial(() => this.bridge.receive(update));
                }
            } catch (error) {
                if (signal.aborted) break;
                this.report(error);
                if (/\(409\)|\(401\)/.test(error.message)) {
                    this.controller?.abort();
                    this.firstReplyWatcher?.close(); this.firstReplyWatcher = null;
                    this.connected = false;
                    this.bridge.state.enabled = false;
                    await this.serial(async () => {
                        await this.bridge.save();
                        await this.idleReplies.clear(Object.keys(this.bridge.state.sessions));
                    }).catch(error => this.report(error));
                    break;
                }
                await wait((error.retryAfter ?? 5) * 1000, signal);
            }
        }
    }

    async monitor(signal) {
        while (!signal.aborted) {
            try { await this.serial(() => this.refresh()); }
            catch (error) { this.report(error); }
            await wait(15_000, signal);
        }
    }

    async stop() {
        this.controller?.abort();
        this.firstReplyWatcher?.close(); this.firstReplyWatcher = null;
        await Promise.all([this.polling, this.monitoring]);
        this.controller = null;
        this.connected = false;
        await this.serial(async () => {
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
