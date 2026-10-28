import { createHash, randomBytes } from "node:crypto";
import { initialTopics, validateTopics, TopicRouter } from "./topics.mjs";
import { phoneInputHash, firstReplyEligible } from "./first-reply.mjs";

export function initialState() {
    return { version: 2, enabled: false, peer: null, bot: null, sessions: {}, aliases: {}, requests: {},
        signals: {}, commands: {}, inbound: {}, lastUpdate: null, notifyIdle: true, idleEpoch: null, topics: initialTopics() };
}
const key = () => randomBytes(9).toString("hex");
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const label = value => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100);
const sessionHeading = (selected, threadId) => threadId == null
    ? `[${selected.alias}] ${selected.name}` : selected.name;
export const safeId = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const dated = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const retirement = row => row?.deleted === true || dated(row?.deleted_at) ? "deleted"
    : row?.archived === true || dated(row?.archived_at) ? "archived" : null;

function truncate(text, maximum) {
    const suffix = "\n[truncated; full answer in Copilot]";
    let end = Math.max(0, maximum - suffix.length);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return text.slice(0, end) + suffix;
}

function reserveAlias(aliases, id) {
    if (Object.hasOwn(aliases, id)) return aliases[id];
    const reserved = new Set(Object.values(aliases));
    for (let n = 0; n < 1000; n++) {
        const alias = String(n).padStart(3, "0");
        if (!reserved.has(alias)) {
            aliases[id] = alias;
            return alias;
        }
    }
    throw new Error("All 1,000 three-digit session codes are reserved. No new session was selected.");
}

function validateAliases(state) {
    if (!record(state.aliases) || !record(state.sessions)) {
        throw new Error("Saved session-code records are invalid; repair bridge state before starting.");
    }
    const reserved = new Set();
    for (const [id, alias] of Object.entries(state.aliases)) {
        if (!safeId(id) || typeof alias !== "string" || !/^[0-9]{3}$/.test(alias) || reserved.has(alias)) {
            throw new Error("Saved session codes are invalid or duplicated; repair bridge state before starting.");
        }
        reserved.add(alias);
    }
    for (const [id, selected] of Object.entries(state.sessions)) {
        if (!safeId(id) || !record(selected) || !Object.hasOwn(state.aliases, id) || selected.alias !== state.aliases[id]) {
            throw new Error("A saved session does not match its reserved code; repair bridge state before starting.");
        }
    }
}

export function questionOf(row) {
    const p = row?.awaiting_input;
    if (!row?.awaiting_user_input || row.awaiting_plan_approval || row.awaiting_permission ||
        !p || typeof p.request_id !== "string" || !p.request_id) return null;
    const kind = p.kind ?? p.type ?? p.source;
    if (kind !== undefined && kind !== "question" && kind !== "ask_user") return null;
    const question = kind === "question" ? p.prompt : p.question;
    if (typeof question !== "string" || !question.trim()) return null;
    if (p.schema || p.requestedSchema || p.fields) return null;
    if (p.choices !== undefined && (!Array.isArray(p.choices) || p.choices.some(c => typeof c !== "string"))) return null;
    if (p.allow_freeform !== undefined && typeof p.allow_freeform !== "boolean") return null;
    if (kind === undefined && typeof p.allow_freeform !== "boolean") return null;
    return { requestId: p.request_id, question, choices: p.choices ?? [],
        allowFreeform: p.allow_freeform === true || !p.choices?.length };
}

export class Bridge {
    constructor({ app, telegram, store, selfId, idleReplies, answerReceipts, firstReplies, now = Date.now }) {
        Object.assign(this, { app, telegram, store, selfId, idleReplies, answerReceipts, firstReplies, now });
        this.state = initialState();
        this.pairing = null;
        this.rows = [];
        this.persistenceFailed = false;
        this.topics = new TopicRouter(this);
    }
    async load() {
        let state = await this.store.load();
        if (state.version === 1) {
            if (!record(state.sessions)) throw new Error("Saved sessions are invalid; session-code migration was not applied.");
            const migrated = { ...state, version: 2, aliases: {}, sessions: {} };
            for (const [id, selected] of Object.entries(state.sessions)) {
                if (!safeId(id) || !record(selected)) throw new Error("A saved session is invalid; session-code migration was not applied.");
                migrated.sessions[id] = { ...selected, alias: reserveAlias(migrated.aliases, id) };
            }
            validateAliases(migrated);
            await this.store.save(migrated);
            state = migrated;
        } else {
            validateAliases(state);
        }
        if (state.topics === undefined) state.topics = initialTopics();
        validateTopics(state, safeId);
        state.inbound ??= {};
        if (!record(state.inbound) || Object.entries(state.inbound).some(([id, receipt]) =>
            !record(receipt) || String(receipt.updateId) !== id || !Number.isSafeInteger(receipt.updateId) ||
            !["received", "attempting", "accepted", "uncertain", "not-sent", "handled", "interrupted"].includes(receipt.state))) {
            throw new Error("Saved inbound receipts are invalid; preserve state before restarting.");
        }
        let interrupted = false;
        for (const receipt of Object.values(state.inbound)) {
            if (receipt.state === "received" || receipt.state === "attempting") {
                receipt.state = receipt.state === "received" ? "interrupted" : "uncertain";
                receipt.reason = "Processing was interrupted; no automatic replay.";
                interrupted = true;
            }
        }
        if (interrupted) await this.persist(state);
        this.state = state;
    }
    async persist(state) {
        try { await this.store.save(state); }
        catch (error) { this.persistenceFailed = true; throw error; }
    }
    async save() { await this.persist(this.state); }

    async setOptIn(id, enabled, reason = "deselected") {
        if (!safeId(id) || id === this.selfId) throw new Error("Select a different, valid session; the hub does not monitor itself.");
        if (enabled) {
            const deletion = this.state.topics.sessions[id]?.deletion;
            if (deletion && deletion.state !== "deleted") throw new Error("Inspect the pending topic deletion before selecting this session again.");
            const row = await this.app.get(id);
            if (!row || row.id !== id || retirement(row)) throw new Error("Session is unavailable, archived or deleted.");
            const next = { ...this.state, aliases: { ...this.state.aliases }, sessions: { ...this.state.sessions } };
            next.sessions[id] ??= { alias: reserveAlias(next.aliases, id), name: label(row.name), idleSelectionId: key() };
            await this.store.save(next);
            this.state = next;
        } else {
            delete this.state.sessions[id];
            await this.clearFirstReplies(id);
            const delivery = this.state.signals[id]?.idleDelivery;
            if (["notifying", "uncertain"].includes(delivery?.state)) this.state.signals[id] = { idleDelivery: delivery };
            else delete this.state.signals[id];
            const route = this.state.topics.sessions[id];
            if (route) route.retirementReason ??= reason;
            for (const r of Object.values(this.state.requests)) {
                if (r.sessionId === id && r.state === "pending") r.state = "revoked";
            }
            await this.save();
        }
    }

    async beginPairing() {
        if (this.state.peer) throw new Error("Disconnect and forget the existing pairing before pairing another account.");
        this.pairing = { code: key(), expires: this.now() + 5 * 60_000, candidate: null };
        return { code: this.pairing.code, expires: this.pairing.expires };
    }

    async confirmPairing(id) {
        if (!this.pairing || this.now() >= this.pairing.expires || this.pairing.candidate?.id !== id) {
            throw new Error("Pairing confirmation is expired or does not match the phone account.");
        }
        this.state.peer = this.pairing.candidate;
        this.pairing = null;
        await this.save();
    }

    async enableTopics(signal) { await this.topics.enable(signal); }

    async say(text, extra = {}, threadId = this.topics.destination()) {
        if (!this.state.peer) throw new Error("No phone is paired.");
        return this.telegram.send(this.state.peer.chatId, text, {
            ...extra, ...(threadId === null ? {} : { message_thread_id: threadId }),
        });
    }

    async saySession(id, text, extra = {}) {
        return this.say(text, extra, this.topics.destination(id));
    }

    async sync(signal) {
        const rows = await this.app.list();
        this.rows = rows;
        if (!this.state.enabled || !this.state.peer) return;
        const errors = [];
        try { await this.forwardFirstReplies(signal); }
        catch (error) { errors.push(error.message); }
        for (const [id, selected] of Object.entries(this.state.sessions)) {
            if (signal?.aborted) { errors.push("Session lifecycle scan canceled."); break; }
            let row = rows.find(r => r.id === id);
            const route = this.state.topics.sessions[id];
            if (!row && this.state.topics.enabled && route) {
                try { row = await this.app.get(id); }
                catch (error) {
                    route.closureIssue = `Copilot closure unverified; topic retained. ${error.message}`;
                }
                if (!row || row.id !== id) {
                    route.closureIssue ??= "Copilot closure unverified; topic retained. Deselect it to delete its topic.";
                    continue;
                }
            }
            if (route && row) delete route.closureIssue;
            const reason = row?.id === id ? retirement(row) : null;
            if (reason && this.state.topics.enabled) {
                try {
                    await this.setOptIn(id, false, reason);
                    await this.idleReplies?.remove(id);
                    await this.answerReceipts?.clear(Object.values(this.state.requests).filter(r => r.sessionId === id).map(r => r.key));
                } catch (error) { errors.push(error.message); }
                continue;
            }
            if (row) selected.name = label(row.name);
        }
        try { await this.topics.sync(false, signal); }
        catch (error) { errors.push(error.message); }
        for (const [id, selected] of Object.entries(this.state.sessions)) {
            if (signal?.aborted) {
                errors.push("Session notification scan canceled.");
                break;
            }
            const row = rows.find(r => r.id === id);
            if (!row || retirement(row)) continue;
            if (this.state.topics.enabled && (this.state.topics.sessions[id]?.state !== "ready" || this.state.topics.sessions[id]?.deletion)) continue;
            try { await this.syncSession(id, selected, row, signal); }
            catch (error) { errors.push(error.message); }
        }
        const entries = Object.entries(this.state.requests);
        for (const [, r] of entries) {
            if (signal?.aborted) {
                errors.push("Question update scan canceled.");
                break;
            }
            const row = rows.find(item => item.id === r.sessionId);
            try { await this.syncQuestionResult(r, row, signal); }
            catch (error) { errors.push(error.message); }
        }
        const old = Object.entries(this.state.requests).filter(([, r]) =>
            !["pending", "attempting", "uncertain", "notifying", "notification-uncertain"].includes(r.state) &&
            !["attempting", "uncertain"].includes(r.messageUpdate?.state));
        for (const [id] of old.slice(0, Math.max(0, old.length - 200))) {
            await this.answerReceipts?.remove(id);
            delete this.state.requests[id];
        }
        await this.save();
        if (errors.length) throw new Error(errors.join("\n"));
    }

    async syncQuestionResult(request, row, signal) {
        if (!this.state.sessions[request.sessionId] || request.state === "revoked") return;
        if (this.topics.isRetired(request.threadId)) return;
        if (["notifying", "notification-uncertain"].includes(request.state)) return;
        const receipt = await this.answerReceipts?.read(request);
        if (receipt) {
            if (request.resolution && request.resolution.source !== "unavailable" &&
                request.resolution.answer !== receipt.answer) {
                throw new Error("Conflicting question answer; the original resolution was preserved.");
            }
            if (!request.resolution || request.resolution.source === "unavailable") {
                request.resolution = { answer: receipt.answer, source: "copilot",
                    eventId: receipt.eventId, completedAt: receipt.completedAt };
                request.state = receipt.answer === null ? "resolved" : "answered";
                await this.save();
            }
        }
        if (!request.resolution && (request.state === "stale" ||
            request.state === "pending" && (!row || fingerprint(questionOf(row)) !== request.hash))) {
            request.state = "stale";
            request.resolution = { answer: null, source: "unavailable" };
            await this.save();
        }
        if (request.resolution) await this.updateQuestionMessage(request, signal);
    }

    async updateQuestionMessage(request, signal) {
        if (signal?.aborted) throw new Error("Question message update canceled.");
        if (!Number.isSafeInteger(request.messageId)) throw new Error("The original question message identity is unavailable.");
        const selected = this.state.sessions[request.sessionId];
        if (!selected || !this.state.peer || !this.state.enabled || request.state === "revoked") return;
        if (this.topics.isRetired(request.threadId)) return;
        const answer = request.resolution.answer;
        const heading = `${sessionHeading(selected, request.threadId)}\n\n${request.question.question}\n\n`;
        const result = answer === null
            ? "No longer active in the bridge.\nAnswer unavailable."
            : `Answered\nAnswer: ${answer}`;
        const text = answer === null || (heading + result).length <= 4096
            ? heading + result : heading + truncate(result, 4096 - heading.length);
        const hash = fingerprint(text);
        if (request.messageUpdate && (request.messageUpdate.state !== "sent" || request.messageUpdate.hash === hash)) return;
        request.messageUpdate = { state: "attempting", hash };
        await this.save();
        try {
            if (signal?.aborted) throw new Error("Question message update canceled.");
            const chatId = request.chatId ?? this.state.peer.chatId;
            const edited = await this.telegram.edit(chatId, request.messageId, text);
            if (edited?.message_id !== request.messageId || edited.chat?.id !== chatId) {
                throw new Error("Telegram did not confirm the edited message identity.");
            }
            if ((edited.message_thread_id ?? null) !== (request.threadId ?? null)) {
                throw new Error("Telegram did not confirm the original question thread destination.");
            }
            request.messageUpdate.state = "sent";
            await this.save();
        } catch (error) {
            request.messageUpdate.state = "uncertain";
            await this.save();
            throw error;
        }
    }

    async syncSession(id, selected, row, abortSignal) {
        const question = questionOf(row);
        const text = question ? this.questionText(selected, question, this.topics.destination(id)) : "";
        const answerable = question && text.length <= 3700 && question.choices.length <= 12;
        if (answerable) {
            const hash = fingerprint(question);
            const existing = Object.values(this.state.requests).find(r => r.sessionId === id &&
                r.requestId === question.requestId && r.hash === hash && r.state !== "revoked");
            if (!existing) {
                const requestKey = key();
                const request = { key: requestKey, sessionId: id, requestId: question.requestId,
                    hash, question, state: "notifying", messageId: null, created: this.now(),
                    threadId: this.topics.destination(id), selectionId: selected.idleSelectionId,
                    botId: this.state.bot?.id, chatId: this.state.peer.chatId };
                this.state.requests[requestKey] = request;
                await this.save();
                try {
                    const buttons = question.choices.map((choice, index) => [{
                        text: `${index + 1}. ${choice}`.slice(0, 60), callback_data: `a:${requestKey}:${index}`,
                    }]);
                    const message = await this.saySession(id, text, buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
                    if (!Number.isSafeInteger(message?.message_id)) throw new Error("Telegram did not confirm a message ID.");
                    request.messageId = message.message_id;
                    request.state = "pending";
                } catch (error) {
                    request.state = "notification-uncertain";
                    await this.save();
                    throw error;
                }
                await this.save();
            }
        } else if (row.awaiting_user_input || row.awaiting_plan_approval || row.awaiting_permission) {
            const signal = fingerprint([row.awaiting_input?.request_id, row.awaiting_plan_approval,
                row.awaiting_permission, "app-only"]);
            if (this.state.signals[id]?.alert !== signal) {
                this.state.signals[id] = { ...this.state.signals[id], alert: signal };
                await this.save();
                await this.saySession(id, `${sessionHeading(selected, this.topics.destination(id))}\nNeeds input in the Copilot app. ` +
                    "This prompt is a plan, permission, form, oversized or unsupported question; phone approval is disabled.");
            }
        } else if (this.state.signals[id]?.alert) {
            delete this.state.signals[id].alert;
        }
        const previous = this.state.signals[id]?.activity;
        const current = row.activity?.status;
        this.state.signals[id] = { ...this.state.signals[id], activity: current };
        if (current === "busy") {
            if (previous !== "busy") this.state.signals[id].busySince = this.now();
            delete this.state.signals[id].idlePending;
        }
        await this.save();
        if (this.state.notifyIdle && this.state.idleEpoch && current === "idle" &&
            !row.awaiting_user_input && !row.awaiting_plan_approval && !row.awaiting_permission) {
            await this.notifyIdle(id, selected, previous, abortSignal);
        }
    }

    async notifyIdle(id, selected, previous, abortSignal) {
        if (!this.idleReplies) throw new Error("The idle-reply source is not configured.");
        const signal = this.state.signals[id];
        if (previous === "busy" && !signal.idlePending) {
            signal.idlePending = { since: this.now() };
            await this.save();
        }
        const reply = await this.idleReplies.read(id, this.state.idleEpoch, selected.idleSelectionId);
        const fresh = reply && (!signal.busySince || Date.parse(reply.idleAt) >= signal.busySince);
        if (fresh && signal.idleDelivery?.eventId === reply.eventId) {
            delete signal.idlePending;
            return;
        }
        if (!fresh && (!signal.idlePending || this.now() - signal.idlePending.since < 30_000)) return;
        const capture = reply?.capture, terminal = capture?.lastTerminal;
        if (fresh && reply.content === null && !reply.aborted &&
            capture?.version === 2 && capture.deltas === 0 && capture.taskCompletions === 0 &&
            terminal?.disposition === "empty" && terminal.hadStart === true &&
            terminal.contentLength === 0 && terminal.streamedLength === 0 &&
            terminal.toolCalls === 0 && terminal.ephemeral === false) {
            signal.idleDelivery = { eventId: reply.eventId, state: "quiet", reason: "no-public-reply",
                partsSent: 0, partCount: 0 };
            delete signal.idlePending;
            await this.save();
            return;
        }
        const eventId = fresh ? reply.eventId : `missing:${signal.idlePending.since}`;
        const content = fresh ? reply.content : null;
        const prefix = `${sessionHeading(selected, this.topics.destination(id))}\n* IDLE *\n`;
        const parts = [];
        if (content !== null) {
            for (let start = 0; start < content.length;) {
                let end = Math.min(start + 3500, content.length);
                const last = content.charCodeAt(end - 1);
                if (end < content.length && last >= 0xd800 && last <= 0xdbff) end--;
                parts.push(content.slice(start, end)); start = end;
            }
        }
        const texts = parts.length ? parts.map((part, i) =>
            `${prefix}${parts.length > 1 ? `(part ${i + 1}/${parts.length})\n` : ""}\n${part}`)
            : [`${prefix}${!fresh
                ? "The last assistant reply was not captured. Reload extensions in this session, or restart the app, to enable its listener."
                : reply.aborted ? "The run was canceled; no final assistant reply was captured."
                : "No final assistant reply was captured for this idle transition."}`];
        const replyTarget = { botId: this.state.bot?.id ?? null, chatId: this.state.peer.chatId,
            threadId: this.topics.destination(id), selectionId: selected.idleSelectionId, messageIds: [] };
        signal.idleDelivery = { eventId, state: "notifying", partsSent: 0, partCount: texts.length, replyTarget };
        delete signal.idlePending;
        await this.save();
        try {
            for (const text of texts) {
                if (abortSignal?.aborted) throw new Error("Idle notification canceled; unsent parts will not be retried.");
                const sent = await this.saySession(id, text);
                if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0 ||
                    sent.chat?.id !== replyTarget.chatId ||
                    (sent.message_thread_id ?? null) !== replyTarget.threadId ||
                    replyTarget.messageIds.includes(sent.message_id)) {
                    throw new Error("Telegram did not confirm the idle notification message and destination.");
                }
                replyTarget.messageIds.push(sent.message_id);
                signal.idleDelivery.partsSent++;
                await this.save();
            }
            signal.idleDelivery.state = "sent";
            const confirmedReply = structuredClone(signal.idleDelivery);
            await this.store.save({ ...this.state, signals: { ...this.state.signals,
                [id]: { ...signal, idleReply: confirmedReply } } });
            signal.idleReply = confirmedReply;
        } catch (error) {
            signal.idleDelivery.state = "uncertain";
            await this.save();
            throw error;
        }
    }

    questionText(selected, q, threadId) {
        const instructions = !q.choices.length
            ? "\nReply to this message with your answer: in Telegram, select this message and choose Reply, then type and send. " +
                "Typing a regular message does not answer this question."
            : q.allowFreeform ? "\nTap a choice or Reply to this message with your answer."
                : "\nTap a choice or Reply with the exact choice text.";
        return `${sessionHeading(selected, threadId)}\n\n${q.question}\n` +
            (q.choices.length ? "\n" + q.choices.map((c, i) => `${i + 1}. ${c}`).join("\n") + "\n" : "") +
            instructions;
    }

    async receive(update) {
        if (this.persistenceFailed) throw new Error("Inbound receiving is paused after a storage failure; inspect the saved state before restarting.");
        if (!Number.isSafeInteger(update?.update_id) ||
            (this.state.lastUpdate !== null && update.update_id <= this.state.lastUpdate)) return;
        if (this.state.inbound?.[update.update_id]) return;
        const callback = update.callback_query;
        const message = callback?.message ?? update.message;
        const sender = callback?.from ?? message?.from;
        const authorized = message && Number.isSafeInteger(sender?.id) && !sender.is_bot &&
            message.chat?.type === "private" && message.chat.id === sender.id && !message.forward_origin &&
            sender.id === this.state.peer?.id && message.chat.id === this.state.peer?.chatId;
        const receipt = authorized ? {
            updateId: update.update_id, messageId: message.message_id ?? null,
            receivedAt: new Date(this.now()).toISOString(), telegramDate: message.date ?? null,
            botId: this.state.bot?.id ?? null, chatId: message.chat.id,
            threadId: message.message_thread_id ?? null, replyMessageId: message.reply_to_message?.message_id ?? null,
            kind: callback ? "callback" : "message",
            contentHash: phoneInputHash(String(callback?.data ?? message.text ?? "")),
            state: "received", stage: "routing",
        } : null;
        const next = { ...this.state, lastUpdate: update.update_id,
            inbound: { ...this.state.inbound, ...(receipt ? { [update.update_id]: receipt } : {}) } };
        // The polling offset may advance only after the receipt and watermark commit together.
        await this.persist(next);
        this.state = next;
        try {
            await this.routeUpdate(update, receipt);
            if (receipt) {
                if (receipt.state === "received") {
                    receipt.state = "not-sent";
                    receipt.reason ??= "No app instruction was dispatched.";
                }
                receipt.completedAt = new Date(this.now()).toISOString();
                await this.save();
                if (callback) {
                    receipt.stage = "callback-acknowledgment";
                    await this.telegram.callback(callback.id);
                }
                const completed = Object.values(this.state.inbound).filter(r =>
                    ["accepted", "handled", "not-sent"].includes(r.state) && !r.failure);
                for (const old of completed.slice(0, Math.max(0, completed.length - 200))) {
                    delete this.state.inbound[old.updateId];
                }
                await this.save();
            }
        } catch (error) {
            if (receipt && !this.persistenceFailed) {
                const beforeDispatch = receipt.state === "received";
                if (beforeDispatch) receipt.state = "not-sent";
                receipt.failure = { at: new Date(this.now()).toISOString(), stage: receipt.stage,
                    message: "Processing failed; inspect the bridge operation log. No automatic replay." };
                await this.save();
                if (beforeDispatch && receipt.stage === "preflight") {
                    try {
                        await this.say("The bridge could not check the target session. Nothing was sent to Copilot. " +
                            "Check the bridge panel before sending a new message.", {}, receipt.threadId);
                    } catch {
                        receipt.failure.phoneNotice = "The failure notice was not confirmed; no automatic retry.";
                        await this.save();
                    }
                }
            }
            throw error;
        }
    }

    inputResponse(receipt, threadId) {
        return text => {
            if (receipt?.state === "received") {
                receipt.reason = text;
                receipt.stage = "phone-response";
            }
            return this.say(text, {}, threadId);
        };
    }

    async routeUpdate(update, receipt) {
        const callback = update.callback_query;
        const message = callback?.message ?? update.message;
        const sender = callback?.from ?? message?.from;
        if (!message || !Number.isSafeInteger(sender?.id) || sender.is_bot ||
            message.chat?.type !== "private" || message.chat.id !== sender.id || message.forward_origin) return;
        if (!this.state.peer) {
            if (this.pairing && this.now() < this.pairing.expires &&
                message.text === `/start ${this.pairing.code}` && !this.pairing.candidate) {
                this.pairing.candidate = { id: sender.id, chatId: message.chat.id,
                    name: label([sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.username || "Telegram user") };
                await this.telegram.send(sender.id, "Return to the local Telegram bridge panel and confirm this account. No sessions are shared yet.");
            }
            return;
        }
        if (!this.state.enabled || sender.id !== this.state.peer.id || message.chat.id !== this.state.peer.chatId) return;
        const threadId = message.message_thread_id ?? null;
        const context = this.topics.context(threadId);
        if (receipt) { receipt.route = context.kind; receipt.sessionId = context.sessionId ?? null; }
        const respond = this.inputResponse(receipt, threadId);
        if (context.kind === "retired") return;
        if (context.kind === "unknown" || context.kind === "inactive") {
            await respond(context.kind === "inactive"
                ? "This session topic is inactive. Select its session in the setup panel before sending instructions."
                : "This topic is not linked to a session. Use a topic created by the bridge. Nothing was sent to Copilot.");
            return;
        }
        if (callback) {
            const parts = /^a:([a-f0-9]{18}):(\d{1,2})$/.exec(callback.data ?? "");
            if (!parts) return;
            const request = this.state.requests[parts[1]];
            if (!request || request.messageId !== message.message_id) return;
            if ((request.threadId ?? null) !== threadId ||
                (context.kind === "session" && request.sessionId !== context.sessionId)) {
                await respond("This button does not belong to this topic. Nothing was sent to Copilot."); return;
            }
            const answer = request.question.choices[Number(parts[2])];
            if (answer !== undefined) await this.answer(request, answer, receipt);
            return;
        }
        const text = message.text?.trim();
        if (!text) return;
        const messageId = message.reply_to_message?.message_id;
        if (messageId !== undefined) {
            if (context.kind === "session" && message.reply_to_message.message_thread_id !== undefined &&
                message.reply_to_message.message_thread_id !== threadId) {
                await respond("This reply refers to another topic. Nothing was sent to Copilot.");
                return;
            }
            const request = Object.values(this.state.requests).find(r => r.messageId === messageId);
            if (request) {
                if ((request.threadId ?? null) !== threadId ||
                    (context.kind === "session" && request.sessionId !== context.sessionId)) {
                    await respond("This question belongs to another topic. Nothing was sent to Copilot."); return;
                }
                await this.answer(request, text, receipt); return;
            }
            const idleMatches = context.kind === "session" ? [] : Object.entries(this.state.signals).filter(([, s]) =>
                Array.isArray(s.idleReply?.replyTarget?.messageIds) &&
                s.idleReply.replyTarget.messageIds.includes(messageId));
            if (idleMatches.length) {
                const [id, signal] = idleMatches[0];
                const delivery = signal.idleReply, target = delivery.replyTarget;
                const selected = this.state.sessions[id];
                if (idleMatches.length !== 1 || !selected || delivery.state !== "sent" ||
                    delivery.partsSent !== delivery.partCount || target.messageIds.length !== delivery.partCount ||
                    !target.messageIds.every(id => Number.isSafeInteger(id) && id > 0) ||
                    new Set(target.messageIds).size !== target.messageIds.length ||
                    !Number.isSafeInteger(target.botId) || target.botId !== this.state.bot?.id ||
                    message.reply_to_message.from?.id !== target.botId ||
                    message.reply_to_message.from?.is_bot !== true ||
                    target.chatId !== this.state.peer.chatId || target.threadId !== threadId ||
                    typeof selected.idleSelectionId !== "string" || target.selectionId !== selected.idleSelectionId ||
                    (context.kind === "session" && context.sessionId !== id)) {
                    await respond("This idle notification is stale, uncertain or belongs to another session. Nothing was sent; use /tell for a new instruction.");
                    return;
                }
                await this.tell(update.update_id, selected.alias, text, threadId, receipt);
                return;
            }
            const topicRoot = threadId !== null && messageId === threadId &&
                Boolean(message.reply_to_message?.forum_topic_created);
            if (this.state.topics.enabled && context.kind !== "session" && !topicRoot) {
                await respond("This reply does not match a retained question or confirmed idle notification. Cancel Reply and send /tell followed by your instruction; nothing was sent.");
                return;
            }
        }
        if (text === "/start" || text === "/help") {
            if (receipt) receipt.state = "handled";
            await respond("In a session topic, type a message or reply to an idle notification: no /tell prefix is required. After a phone message or answer, the first public reply is forwarded as soon as captured; the final result follows at idle.\n" +
                "Reply to the exact question or tap its choice button to answer it. New messages cannot answer a pending decision.\n/status lists opted-in sessions, or this topic's session.\n" +
                "In Bridge: /tell 042 Your message sends a new instruction when that session is not awaiting a decision. " +
                "Replace 042 with its three-digit code from /status, including leading zeros.\n" +
                "Plans, permissions and forms stay in the app.");
            return;
        }
        if (text === "/status") {
            if (receipt) receipt.state = "handled";
            const rows = await this.app.list();
            const lines = Object.entries(this.state.sessions)
                .filter(([id]) => context.kind !== "session" || id === context.sessionId).map(([id, selected]) => {
                const r = rows.find(item => item.id === id);
                const state = !r ? "unavailable" : r.awaiting_user_input || r.awaiting_plan_approval ? "needs input" : r.activity?.status ?? "unknown";
                return `[${selected.alias}] ${label(r?.name ?? selected.name)}: ${state}`;
            });
            await respond((lines.join("\n") || "No sessions opted in. Select sessions in the local panel.").slice(0, 3900));
            return;
        }
        const tell = /^\/tell\s+([0-9]{3})\s+([\s\S]+)$/.exec(text);
        if (tell) {
            if (context.kind === "session" && this.state.sessions[context.sessionId].alias !== tell[1]) {
                await respond("That code belongs to another session. Use its topic or the Bridge topic. Nothing was sent."); return;
            }
            await this.tell(update.update_id, tell[1], tell[2], threadId, receipt); return;
        }
        const local = /^\/tell\s+([\s\S]+)$/.exec(text);
        if (context.kind === "session" && local) {
            if (/^\d+(?:\s|$)/.test(local[1])) {
                await respond("Use an exact three-digit code or omit the code entirely. Nothing was sent."); return;
            }
            await this.tell(update.update_id, this.state.sessions[context.sessionId].alias, local[1], threadId, receipt); return;
        }
        if (context.kind === "session") {
            if (text.startsWith("/")) {
                await respond("Unknown or incomplete bridge command. Type an ordinary message without a prefix, or use /tell followed by literal text beginning with /.");
                return;
            }
            await this.tell(update.update_id, this.state.sessions[context.sessionId].alias, text, threadId, receipt);
            return;
        }
        await respond("This message has no session destination. For a new instruction, select a non-question bot message " +
            "in the intended session topic and choose Reply, or use /tell CODE Your message with the exact three-digit code from /status. " +
            "To answer a pending question, Reply to that exact question. Nothing was sent to Copilot.");
    }

    async answer(request, answer, receipt) {
        const respond = this.inputResponse(receipt, request.threadId ?? null);
        if (receipt) Object.assign(receipt, { sessionId: request.sessionId, requestId: request.requestId, stage: "preflight" });
        if (!this.state.sessions[request.sessionId] || request.state !== "pending") {
            await respond("This question is stale, revoked or already attempted. Check the app; no answer was replayed.");
            return;
        }
        if (receipt) await this.save();
        const row = await this.app.get(request.sessionId);
        const current = questionOf(row);
        if (retirement(row) || !current || fingerprint(current) !== request.hash || current.requestId !== request.requestId) {
            request.state = "stale"; await this.save();
            await respond("The question changed or was resolved. This stale answer was not applied.");
            return;
        }
        if (!answer.trim() || answer.length > 8000 || (!current.allowFreeform && !current.choices.includes(answer))) {
            await respond("Choose one of the exact offered answers. Nothing was sent to Copilot.");
            return;
        }
        const firstReply = this.armFirstReply(request.sessionId, "answer", answer, request.requestId);
        if (receipt) Object.assign(receipt, { state: "attempting", stage: "app-answer", attemptedAt: new Date(this.now()).toISOString() });
        request.state = "attempting"; await this.save();
        try {
            await this.app.answer(request.sessionId, request.requestId, answer);
        } catch {
            if (receipt) receipt.state = "uncertain";
            if (firstReply) firstReply.state = "uncertain";
            request.state = "uncertain"; await this.save();
            await respond("The app did not confirm this answer. Its outcome is uncertain; inspect the app before retrying. It will not be automatically replayed.");
            return;
        }
        request.state = "answered";
        if (receipt) { receipt.state = "accepted"; receipt.stage = "answer-confirmation"; }
        if (firstReply) firstReply.state = "accepted";
        request.resolution = { answer, source: "telegram" };
        await this.save();
        await this.updateQuestionMessage(request);
        await respond("Copilot accepted the answer to that question.");
    }

    async tell(updateId, alias, message, threadId = null, receipt) {
        const respond = this.inputResponse(receipt, threadId);
        const selected = Object.entries(this.state.sessions).find(([, item]) => item.alias === alias);
        if (!selected) { await respond("Unknown or unselected session code; use /status. Nothing was sent."); return; }
        const [id] = selected;
        if (receipt) Object.assign(receipt, { sessionId: id, stage: "preflight" });
        if (receipt) await this.save();
        const row = await this.app.get(id);
        if (!row || row.id !== id || retirement(row) || row.awaiting_user_input || row.awaiting_plan_approval || row.awaiting_permission) {
            await respond("That session is unavailable or awaiting a decision. To answer a question shown in Telegram, " +
                "select that question and choose Reply, then type and send your answer. " +
                "Replying to an older message does not answer the question. Otherwise use the Copilot app; no new prompt was sent.");
            return;
        }
        const firstReply = this.armFirstReply(id, "message", message);
        this.state.commands[updateId] = { sessionId: id, state: "attempting" };
        if (receipt) Object.assign(receipt, { state: "attempting", stage: "app-message", attemptedAt: new Date(this.now()).toISOString() });
        await this.save();
        try { await this.app.tell(id, message); }
        catch {
            if (receipt) receipt.state = "uncertain";
            if (firstReply) firstReply.state = "uncertain";
            this.state.commands[updateId].state = "uncertain"; await this.save();
            await respond("The app did not confirm the new message; delivery may be uncertain. Check the app before resending.");
            return;
        }
        this.state.commands[updateId].state = "sent";
        if (receipt) { receipt.state = "accepted"; receipt.stage = "message-confirmation"; }
        if (firstReply) firstReply.state = "accepted";
        const completed = Object.keys(this.state.commands).filter(k => this.state.commands[k].state === "sent");
        for (const k of completed.slice(0, Math.max(0, completed.length - 200))) delete this.state.commands[k];
        await this.save();
        await respond(`The app accepted your message for [${alias}]. This is not a task-completion confirmation.`);
    }

    armFirstReply(sessionId, kind, content, requestId = null) {
        if (!this.firstReplies) return null;
        const selected = this.state.sessions[sessionId];
        if (!this.state.idleEpoch || !selected?.idleSelectionId || !Number.isSafeInteger(this.state.bot?.id)) {
            throw new Error("First-reply capture is not initialized; reconnect the bridge before sending.");
        }
        const input = { id: key(), sessionId, kind, requestId, inputHash: phoneInputHash(content),
            senderId: this.selfId, createdAt: this.now(), state: "attempting",
            epoch: this.state.idleEpoch, selectionId: selected.idleSelectionId,
            botId: this.state.bot.id, chatId: this.state.peer.chatId, threadId: this.topics.destination(sessionId) };
        this.state.phoneInputs ??= {};
        this.state.phoneInputs[input.id] = input;
        return input;
    }

    async clearFirstReplies(sessionId) {
        for (const input of Object.values(this.state.phoneInputs ?? {})) {
            if (sessionId !== undefined && input.sessionId !== sessionId) continue;
            if (["attempting", "uncertain"].includes(input.delivery?.state)) continue;
            if (["attempting", "uncertain"].includes(input.state)) continue;
            await this.firstReplies?.remove(input.id);
            delete this.state.phoneInputs[input.id];
        }
    }

    async forwardFirstReplies(abortSignal) {
        if (!this.firstReplies || !this.state.enabled) return;
        const errors = [], inputs = Object.values(this.state.phoneInputs ?? {});
        for (const input of inputs) {
            if (abortSignal?.aborted) break;
            if (input.state !== "accepted" || input.delivery || !firstReplyEligible(this.state, input)) continue;
            try {
                if (this.topics.destination(input.sessionId) !== input.threadId || this.topics.isRetired(input.threadId)) continue;
                const reply = await this.firstReplies.read(input);
                if (!reply) continue;
                const row = await this.app.get(input.sessionId);
                if (!row || row.id !== input.sessionId || retirement(row)) {
                    throw new Error("First reply withheld: its Copilot session is unavailable or retired.");
                }
                const shared = inputs.find(other => other.id !== input.id &&
                    other.sessionId === input.sessionId && other.epoch === input.epoch &&
                    other.selectionId === input.selectionId && other.threadId === input.threadId &&
                    other.delivery?.eventId === reply.eventId);
                if (shared) {
                    input.delivery = { state: shared.delivery.state === "sent" ? "shared" : "uncertain",
                        eventId: reply.eventId, sharedWith: shared.id };
                    await this.save();
                    continue;
                }
                const parts = [];
                for (let start = 0; start < reply.content.length;) {
                    let end = Math.min(start + 3500, reply.content.length);
                    if (end < reply.content.length && /[\uD800-\uDBFF]/.test(reply.content[end - 1])) end--;
                    parts.push(reply.content.slice(start, end)); start = end;
                }
                input.delivery = { state: "attempting", eventId: reply.eventId, partCount: parts.length, messageIds: [] };
                await this.save();
                try {
                    for (let i = 0; i < parts.length; i++) {
                        if (abortSignal?.aborted) throw new Error("First-reply delivery canceled; unsent parts will not be retried.");
                        const prefix = `${sessionHeading(this.state.sessions[input.sessionId], input.threadId)}\n* REPLY *\n` +
                            (parts.length > 1 ? `(part ${i + 1}/${parts.length})\n` : "");
                        const sent = await this.say(prefix + "\n" + parts[i], {}, input.threadId);
                        if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0 ||
                            sent.chat?.id !== input.chatId || (sent.message_thread_id ?? null) !== input.threadId ||
                            input.delivery.messageIds.includes(sent.message_id)) {
                            throw new Error("Telegram did not confirm the first reply's message and destination.");
                        }
                        input.delivery.messageIds.push(sent.message_id);
                        await this.save();
                    }
                    input.delivery.state = "sent";
                    await this.save();
                } catch (error) {
                    input.delivery.state = "uncertain";
                    await this.save();
                    throw error;
                }
            } catch (error) { errors.push(error.message); }
        }
        const completed = inputs.filter(input => ["sent", "shared"].includes(input.delivery?.state));
        for (const input of completed.slice(0, Math.max(0, completed.length - 200))) {
            await this.firstReplies.remove(input.id);
            delete this.state.phoneInputs[input.id];
        }
        if (completed.length > 200) await this.save();
        if (errors.length) throw new Error(errors.join("\n"));
    }
}
