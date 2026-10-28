import test from "node:test";
import assert from "node:assert/strict";
import { Bridge, initialState } from "./bridge.mjs";
import { Telegram } from "./telegram.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("topics accept commands with topic-root or unrecorded non-question reply metadata", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    const threadId = f.route("session-a");
    const root = { message_id: threadId, forum_topic_created: { name: "000 - First" } };
    await f.receive("/status", threadId, { reply_to_message: root });
    assert.match(f.sent.at(-1).text, /\[000\]/);
    await f.receive("/tell Continue", threadId, { reply_to_message: root });
    assert.deepEqual(f.messages, [["session-a", "Continue"]]);
    await f.receive("/tell Do not guess", threadId, { reply_to_message: { message_id: 9999 } });
    assert.deepEqual(f.messages, [["session-a", "Continue"], ["session-a", "Do not guess"]]);
});

test("topics restart retains ownership and fences interrupted creates and renames", async () => {
    const { Service } = await import("./service.mjs");
    const f = await fixture();
    await f.bridge.enableTopics();
    const directory = await mkdtemp(join(tmpdir(), "telegram-topics-restart-"));
    const service = new Service({ directory, app: f.app, selfId: "hub" });
    try {
        const saved = f.disk();
        saved.topics.sessions["session-a"].state = "creating";
        saved.topics.sessions["session-a"].threadId = null;
        saved.topics.sessions["session-b"].rename = { name: "New name", state: "attempting" };
        await service.store.save(saved);
        await service.initialize();
        assert.equal(service.bridge.state.enabled, false);
        assert.equal(service.bridge.state.topics.enabled, true);
        assert.equal(service.bridge.state.topics.sessions["session-a"].state, "uncertain");
        assert.equal(service.bridge.state.topics.sessions["session-b"].rename.state, "uncertain");
        assert.equal(service.bridge.state.topics.chatId, 42);
        assert.equal(service.bridge.state.topics.botId, 1000);
        assert.equal((await service.status()).topics.issues.length, 2);
    } finally { await service.close(); await rm(directory, { recursive: true }); }
});

test("topics cancellation stops remaining creations without losing the in-flight result", async () => {
    const f = await fixture(), controller = new AbortController();
    const create = f.telegram.createTopic;
    f.telegram.createTopic = async (...args) => {
        const result = await create(...args);
        controller.abort();
        return result;
    };
    await assert.rejects(f.bridge.enableTopics(controller.signal), /canceled/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.bridge.state.topics.bridge.state, "ready");
    assert.equal(Object.keys(f.bridge.state.topics.sessions).length, 0);
});

async function fixture() {
    let disk = initialState(), nextThread = 100, update = 0;
    const rows = [
        { id: "session-a", name: "First", activity: { status: "idle" } },
        { id: "session-b", name: "Second", activity: { status: "idle" } },
    ];
    const sent = [], calls = [], messages = [], answers = [], snapshots = [], edits = [];
    const store = {
        async load() { return structuredClone(disk); },
        async save(value) { disk = structuredClone(value); snapshots.push(structuredClone(value)); },
    };
    const telegram = {
        async identity() { return { id: 1000, username: "test_bot", hasTopicsEnabled: true }; },
        async createTopic(chatId, name) {
            calls.push({ method: "create", chatId, name });
            return { message_thread_id: nextThread++, name };
        },
        async editTopic(chatId, threadId, name) { calls.push({ method: "edit", chatId, threadId, name }); },
        async deleteTopic(chatId, threadId) { calls.push({ method: "delete", chatId, threadId }); },
        async send(chatId, text, extra = {}) {
            sent.push({ chatId, text, ...extra });
            return { message_id: sent.length, chat: { id: chatId },
                ...(extra.message_thread_id === undefined ? {} : { message_thread_id: extra.message_thread_id }) };
        },
        async edit(chatId, messageId, text) {
            edits.push({ chatId, messageId, text });
            return { chat: { id: chatId }, message_id: messageId,
                message_thread_id: sent[messageId - 1].message_thread_id };
        },
        async callback() {},
    };
    const app = {
        async list() { return structuredClone(rows); },
        async get(id) { return structuredClone(rows.find(row => row.id === id)); },
        async tell(...args) { messages.push(args); },
        async answer(...args) { answers.push(args); },
    };
    disk.enabled = true;
    disk.peer = { id: 42, chatId: 42, name: "Phone" };
    disk.bot = { id: 1000, username: "test_bot" };
    const bridge = new Bridge({ app, telegram, store, selfId: "hub" });
    await bridge.load();
    await bridge.setOptIn("session-a", true);
    await bridge.setOptIn("session-b", true);
    const receive = (text, threadId, extra = {}) => bridge.receive({
        update_id: ++update,
        message: { message_id: update + 500, from: { id: 42 }, chat: { id: 42, type: "private" },
            text, ...(threadId === undefined ? {} : { message_thread_id: threadId }), ...extra },
    });
    return { bridge, app, telegram, store, rows, sent, calls, messages, answers, snapshots, edits, receive,
        disk: () => structuredClone(disk), route: id => bridge.state.topics.sessions[id].threadId };
}

function pending(row) {
    row.awaiting_user_input = true;
    row.awaiting_input = { kind: "question", request_id: `q-${row.id}`, prompt: "Which option?",
        choices: ["First", "Second"], allow_freeform: true };
}

test("topic messages send plain text to the bound session without a prefix or numeric-code guessing", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    await f.receive("Please continue", f.route("session-a"));
    await f.receive("005 is the example number\nKeep it verbatim", f.route("session-b"));
    await f.receive("yes", f.route("session-a"));
    assert.deepEqual(f.messages, [
        ["session-a", "Please continue"], ["session-b", "005 is the example number\nKeep it verbatim"], ["session-a", "yes"],
    ]);
    assert.equal(f.answers.length, 0);
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-a"));
});

test("topic messages accept old and unrecorded non-question replies using only the current topic", async () => {
    const f = await idleNotice();
    await f.receive("Follow up on this", f.route("session-a"),
        { reply_to_message: { message_id: 9999, text: "untrusted quote; do not send this", from: { id: 1000 } } });
    delete f.bridge.state.signals["session-a"].idleReply;
    await f.reply("No recorded idle target needed");
    await f.receive("/tell Explicit text", f.route("session-a"), { reply_to_message: { message_id: 9998 } });
    assert.deepEqual(f.messages, [
        ["session-a", "Follow up on this"], ["session-a", "No recorded idle target needed"], ["session-a", "Explicit text"],
    ]);
});

test("topic messages preserve exact question answers and reject stale or cross-topic question replies", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    pending(f.rows[0]); await f.bridge.sync();
    const request = Object.values(f.bridge.state.requests)[0];
    await f.receive("First", f.route("session-b"), { reply_to_message: { message_id: request.messageId } });
    await f.receive("First", f.route("session-a"));
    assert.equal(f.messages.length, 0); assert.equal(f.answers.length, 0);
    await f.receive("First", f.route("session-a"), { reply_to_message: { message_id: request.messageId } });
    assert.deepEqual(f.answers, [["session-a", "q-session-a", "First"]]);
    f.rows[0].awaiting_user_input = false;
    delete f.rows[0].awaiting_input;
    await f.receive("Stale reply", f.route("session-a"), { reply_to_message: { message_id: request.messageId } });
    assert.equal(f.messages.length, 0);
    await f.receive("New request", f.route("session-a"));
    assert.deepEqual(f.messages, [["session-a", "New request"]]);
});

test("free-text topic answers reject older replies with actionable question instructions", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    pending(f.rows[0]);
    f.rows[0].awaiting_input.choices = [];
    await f.bridge.sync();
    const request = Object.values(f.bridge.state.requests)[0];
    const question = f.sent[request.messageId - 1];
    assert.equal(question.message_thread_id, f.route("session-a"));
    assert.equal(question.reply_markup, undefined);

    await f.receive("Plain answer", f.route("session-a"));
    assert.match(f.sent.at(-1).text, /select that question and choose Reply/);
    await f.receive("Older-message answer", f.route("session-a"),
        { reply_to_message: { message_id: 9999 } });
    assert.match(f.sent.at(-1).text, /older message does not answer the question/);
    await f.receive("Cross-topic answer", f.route("session-b"),
        { reply_to_message: { message_id: request.messageId } });
    assert.equal(f.answers.length, 0);
    assert.equal(f.messages.length, 0);

    await f.receive("Bound free-text answer", f.route("session-a"),
        { reply_to_message: { message_id: request.messageId } });
    assert.deepEqual(f.answers, [["session-a", "q-session-a", "Bound free-text answer"]]);
    assert.equal(f.messages.length, 0);

    await f.receive("Do not replay", f.route("session-a"),
        { reply_to_message: { message_id: request.messageId } });
    assert.equal(f.answers.length, 1);
    f.rows[0].awaiting_input.request_id = "replacement";
    await f.bridge.sync();
    const replacement = Object.values(f.bridge.state.requests).find(r => r.requestId === "replacement");
    f.rows[0].awaiting_input.request_id = "newer-replacement";
    await f.receive("Changed question", f.route("session-a"),
        { reply_to_message: { message_id: replacement.messageId } });
    assert.equal(f.answers.length, 1);
    assert.equal(f.messages.length, 0);
    assert.equal(replacement.state, "stale");
});

test("topic messages keep Bridge commands explicit and do not send unsupported slash commands to an agent", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    await f.receive("Unaddressed", f.bridge.state.topics.bridge.threadId);
    await f.receive("Unaddressed main chat", undefined);
    await f.receive("/approve", f.route("session-a"));
    await f.receive("/tell", f.route("session-a"));
    await f.receive("/tell 001 Wrong topic", f.route("session-a"));
    assert.equal(f.messages.length, 0);
    await f.receive("/status", f.route("session-a"), { reply_to_message: { message_id: 9999 } });
    assert.match(f.sent.at(-1).text, /\[000\]/);
    await f.receive("/help", f.route("session-a"));
    assert.match(f.sent.at(-1).text, /no.*\/tell.*required/i);
    await f.receive("/tell 001 From Bridge", f.bridge.state.topics.bridge.threadId);
    assert.deepEqual(f.messages, [["session-b", "From Bridge"]]);
});

test("topic messages refuse foreign senders, retired topics and contradictory reply thread metadata", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    const a = f.route("session-a");
    await f.receive("Unknown", 999);
    await f.receive("Foreign", a, { from: { id: 99 } });
    await f.receive("Bot", a, { from: { id: 42, is_bot: true } });
    await f.receive("Group", a, { chat: { id: 42, type: "supergroup" } });
    await f.receive("Forwarded", a, { forward_origin: { type: "user" } });
    await f.receive("Other thread", a, { reply_to_message: { message_id: 9999, message_thread_id: f.route("session-b") } });
    assert.equal(f.messages.length, 0);
    await f.receive("Valid", a);
    assert.deepEqual(f.messages, [["session-a", "Valid"]]);
    await f.bridge.setOptIn("session-a", false); await f.bridge.sync();
    await f.receive("Retired", a);
    assert.equal(f.messages.length, 1);
});

test("topic messages preserve update deduplication, uncertain app writes and saved attempt ordering", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    f.app.tell = async (...args) => { f.messages.push(args); throw new Error("app result lost"); };
    const input = { update_id: 100, message: { message_id: 501, from: { id: 42 }, chat: { id: 42, type: "private" },
        message_thread_id: f.route("session-a"), text: "Plain message" } };
    await f.bridge.receive(input);
    await f.bridge.receive(input); await f.bridge.load(); await f.bridge.receive(input);
    assert.deepEqual(f.messages, [["session-a", "Plain message"]]);
    assert.equal(f.bridge.state.commands[100].state, "uncertain");
    assert.match(f.sent.at(-1).text, /uncertain/);
    const g = await fixture();
    await g.bridge.enableTopics();
    const save = g.store.save;
    g.store.save = async state => {
        if (Object.values(state.commands).some(c => c.state === "attempting")) throw new Error("save failed");
        await save(state);
    };
    await assert.rejects(g.receive("Never dispatch", g.route("session-a")), /save failed/);
    assert.equal(g.messages.length, 0);
});

async function idleNotice(content = "Ready for your next instruction.", topics = true) {
    const f = await fixture();
    if (topics) await f.bridge.enableTopics();
    f.bridge.state.idleEpoch = "connection-1";
    f.bridge.idleReplies = { async read(id) { return id === "session-a"
        ? { eventId: "idle-1", idleAt: new Date().toISOString(), content } : null; } };
    await f.bridge.sync();
    f.reply = (text, messageId = 1, threadId = topics ? f.route("session-a") : undefined, extra = {}) =>
        f.receive(text, threadId, { reply_to_message: { message_id: messageId,
            from: { id: 1000, is_bot: true } }, ...extra });
    return f;
}

test("idle replies submit a new instruction to the exact session once and survive receipt reload", async () => {
    const f = await idleNotice("x".repeat(7500));
    const delivery = f.bridge.state.signals["session-a"].idleDelivery;
    assert.deepEqual(delivery.replyTarget, { botId: 1000, chatId: 42, threadId: f.route("session-a"),
        selectionId: f.bridge.state.sessions["session-a"].idleSelectionId, messageIds: [1, 2, 3] });
    await f.bridge.load();
    await f.reply("Please continue", 2);
    assert.deepEqual(f.messages, [["session-a", "Please continue"]]);
    assert.equal(f.answers.length, 0);
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-a"));
    const update = { update_id: 100, message: { message_id: 501, from: { id: 42 },
        chat: { id: 42, type: "private" }, message_thread_id: f.route("session-a"), text: "One more thing",
        reply_to_message: { message_id: 3, from: { id: 1000, is_bot: true } } } };
    await f.bridge.receive(update);
    await f.bridge.receive(update);
    assert.deepEqual(f.messages, [["session-a", "Please continue"], ["session-a", "One more thing"]]);
});

test("idle replies return Copilot's next public reply to the same Telegram topic", async () => {
    const { IdleListener } = await import("./idle.mjs");
    const f = await fixture();
    await f.bridge.enableTopics();
    f.bridge.state.idleEpoch = "connection-1";
    await f.bridge.save();
    const replies = new Map();
    f.bridge.idleReplies = {
        async write(value) { replies.set(value.sessionId, value); },
        async read(id, epoch, selectionId) {
            const value = replies.get(id);
            return value?.epoch === epoch && value.selectionId === selectionId ? value : null;
        },
        async remove(id) { replies.delete(id); },
    };
    const listener = new IdleListener({ sessionId: "session-a", stateStore: f.store,
        replies: f.bridge.idleReplies, notify: error => { throw new Error(error); } });
    let sequence = 0;
    const event = (type, data) => ({ type, data, id: `event-${++sequence}`,
        timestamp: new Date(Date.now() + 1000).toISOString() });
    const complete = async text => {
        await listener.handle(event("assistant.message", { content: text, messageId: `message-${sequence}`, phase: "final_answer" }));
        await listener.handle(event("session.idle", { aborted: false }));
        f.rows[0].activity.status = "idle";
        await f.bridge.sync();
    };
    await complete("Initial result");
    f.app.tell = async (id, text) => {
        f.messages.push([id, text]);
        await listener.handle(event("user.message", { content: text }));
        f.rows[0].activity.status = "busy";
    };
    await f.receive("Explain the result", f.route("session-a"),
        { reply_to_message: { message_id: 1, from: { id: 1000, is_bot: true } } });
    assert.deepEqual(f.messages, [["session-a", "Explain the result"]]);
    await f.bridge.sync();
    await complete("Here is the explanation.");
    await f.bridge.sync();
    const returned = f.sent.filter(m => m.text.includes("Here is the explanation."));
    assert.equal(returned.length, 1);
    assert.equal(returned[0].message_thread_id, f.route("session-a"));
    assert.equal(returned[0].text, "First\n* IDLE *\n\nHere is the explanation.");
    await f.receive("A fresh message without Reply", f.route("session-a"));
    assert.deepEqual(f.messages.at(-1), ["session-a", "A fresh message without Reply"]);
    await f.bridge.sync();
    await complete("Reply to your fresh message.");
    await f.bridge.sync();
    const plainResponse = f.sent.filter(m => m.text.includes("Reply to your fresh message."));
    assert.equal(plainResponse.length, 1);
    assert.equal(plainResponse[0].message_thread_id, f.route("session-a"));
});

test("idle replies reject contradictory thread metadata and unauthorized senders", async () => {
    const f = await idleNotice();
    await f.reply("Wrong topic", 1, f.route("session-b"),
        { reply_to_message: { message_id: 1, message_thread_id: f.route("session-a") } });
    await f.reply("Wrong sender", 1, f.route("session-a"), { from: { id: 99 } });
    await f.reply("Forwarded", 1, f.route("session-a"), { forward_origin: { type: "user" } });
    assert.equal(f.messages.length, 0);
    await f.reply("Correct reply");
    assert.deepEqual(f.messages, [["session-a", "Correct reply"]]);
});

test("idle replies preserve current question, plan, permission and session identity gates", async () => {
    const changes = [
        row => { pending(row); },
        row => { row.awaiting_plan_approval = true; },
        row => { row.awaiting_permission = true; },
        row => { row.archived_at = new Date().toISOString(); },
        row => { row.deleted = true; },
        row => { row.id = "different-session"; },
    ];
    for (const change of changes) {
        const f = await idleNotice();
        const row = structuredClone(f.rows[0]);
        change(row);
        f.app.get = async () => row;
        await f.reply("Continue");
        assert.equal(f.messages.length, 0);
        assert.equal(f.answers.length, 0);
        assert.match(f.sent.at(-1).text, /unavailable|decision/);
    }
});

test("non-topic idle replies require valid receipts and retired topics stay protected", async () => {
    const changes = [
        f => { f.bridge.state.signals["session-a"].idleReply.state = "uncertain"; },
        f => { f.bridge.state.signals["session-a"].idleReply.partsSent = 0; },
        f => { delete f.bridge.state.signals["session-a"].idleReply.replyTarget; },
        f => { f.bridge.state.sessions["session-a"].idleSelectionId = "new-selection"; },
        f => { f.bridge.state.signals["session-a"].idleReply.replyTarget.messageIds.push(1); },
        f => { f.bridge.state.signals["session-a"].idleReply.replyTarget.chatId = 99; },
        f => { f.bridge.state.signals["session-a"].idleReply.replyTarget.botId = 99; },
    ];
    for (const change of changes) {
        const f = await idleNotice(undefined, false);
        change(f);
        await f.reply("Continue");
        assert.equal(f.messages.length, 0);
    }
    const f = await idleNotice();
    await f.bridge.setOptIn("session-a", false);
    await f.bridge.sync();
    await f.bridge.setOptIn("session-a", true);
    await f.bridge.sync();
    await f.reply("Old topic reply", 1, f.disk().topics.sessions["session-a"].retired[0].threadId);
    assert.equal(f.messages.length, 0);
});

test("idle replies preserve uncertain app sends and never replay a duplicate update", async () => {
    const f = await idleNotice();
    f.app.tell = async (...args) => { f.messages.push(args); throw new Error("lost app reply"); };
    await f.reply("Continue");
    assert.deepEqual(f.messages, [["session-a", "Continue"]]);
    assert.equal(Object.values(f.bridge.state.commands)[0].state, "uncertain");
    assert.match(f.sent.at(-1).text, /uncertain/);
    await f.bridge.receive({ update_id: 1 });
    await f.bridge.sync();
    assert.equal(f.messages.length, 1);
});

test("idle replies retain the last visible confirmed notification across a silent turn", async () => {
    const f = await idleNotice();
    f.bridge.idleReplies = { async read(id) { return id === "session-a" ? {
        eventId: "silent-2", idleAt: new Date().toISOString(), content: null, aborted: false,
        capture: { version: 2, deltas: 0, taskCompletions: 0, lastTerminal: {
            disposition: "empty", hadStart: true, contentLength: 0, streamedLength: 0, toolCalls: 0, ephemeral: false,
        } },
    } : null; } };
    await f.bridge.sync();
    assert.equal(f.bridge.state.signals["session-a"].idleDelivery.state, "quiet");
    assert.equal(f.sent.length, 1);
    await f.bridge.load();
    await f.reply("Follow up on the visible result");
    assert.deepEqual(f.messages, [["session-a", "Follow up on the visible result"]]);
});

test("non-topic idle replies require the latest unambiguous receipt and topic sends require a saved attempt", async () => {
    const f = await idleNotice(undefined, false);
    f.bridge.idleReplies = { async read(id) { return id === "session-a"
        ? { eventId: "idle-2", idleAt: new Date().toISOString(), content: "Newer result" } : null; } };
    await f.bridge.sync();
    await f.reply("Old reply", 1);
    assert.equal(f.messages.length, 0);
    await f.reply("Latest reply", 2);
    assert.deepEqual(f.messages, [["session-a", "Latest reply"]]);

    const g = await idleNotice(undefined, false);
    g.bridge.state.signals["session-b"] = { idleReply: structuredClone(g.bridge.state.signals["session-a"].idleReply) };
    await g.reply("Ambiguous receipt");
    assert.equal(g.messages.length, 0);

    const h = await idleNotice(), save = h.store.save;
    h.store.save = async state => {
        if (Object.values(state.commands).some(command => command.state === "attempting")) {
            throw new Error("command receipt failed");
        }
        await save(state);
    };
    await assert.rejects(h.reply("Do not dispatch"), /command receipt failed/);
    assert.equal(h.messages.length, 0);
});

test("idle deliveries retain unconfirmed destinations and failed receipts without blocking a new topic instruction", async () => {
    for (const kind of ["wrong-chat", "wrong-thread", "missing-message", "receipt-failure"]) {
        const f = await fixture();
        await f.bridge.enableTopics();
        f.bridge.state.idleEpoch = "connection-1";
        f.bridge.idleReplies = { async read(id) { return id === "session-a"
            ? { eventId: "idle-1", idleAt: new Date().toISOString(), content: "Result" } : null; } };
        const send = f.telegram.send, save = f.store.save;
        f.telegram.send = async (...args) => {
            const result = await send(...args);
            if (kind === "wrong-chat") result.chat.id = 99;
            if (kind === "wrong-thread") result.message_thread_id = f.route("session-b");
            if (kind === "missing-message") delete result.message_id;
            return result;
        };
        let failed = false;
        f.store.save = async state => {
            if (kind === "receipt-failure" && !failed && state.signals["session-a"]?.idleDelivery?.state === "sent") {
                failed = true; throw new Error("sent receipt failed");
            }
            await save(state);
        };
        await assert.rejects(f.bridge.sync(), /confirm|receipt/);
        assert.equal(f.bridge.state.signals["session-a"].idleDelivery.state, "uncertain");
        const sends = f.sent.length;
        await f.bridge.sync();
        assert.equal(f.sent.length, sends);
        await f.receive("Continue", f.route("session-a"),
            { reply_to_message: { message_id: 1, from: { id: 1000, is_bot: true } } });
        assert.deepEqual(f.messages, [["session-a", "Continue"]]);
        assert.equal(f.bridge.state.signals["session-a"].idleDelivery.state, "uncertain");
    }
});

test("topic cleanup deletes only deselected topics, once, with a durable exact-thread receipt", async () => {
    const f = await fixture(); await f.bridge.enableTopics();
    const a = f.route("session-a"), b = f.route("session-b"), bridge = f.bridge.state.topics.bridge.threadId;
    await f.bridge.setOptIn("session-a", false);
    await f.bridge.sync(); await f.bridge.sync(); await f.bridge.load(); await f.bridge.sync();
    assert.deepEqual(f.calls.filter(c => c.method === "delete"), [{ method: "delete", chatId: 42, threadId: a }]);
    assert.ok(f.snapshots.some(s => s.topics.sessions["session-a"]?.deletion?.state === "attempting"));
    assert.equal(f.bridge.state.topics.sessions["session-a"].deletion.state, "deleted");
    assert.equal(f.bridge.state.topics.sessions["session-a"].deletion.reason, "deselected");
    assert.equal(f.route("session-b"), b); assert.equal(f.bridge.state.topics.bridge.threadId, bridge);
    assert.equal(f.bridge.topics.status().ready, 1);
    assert.deepEqual(f.bridge.topics.status().issues, []);
    assert.throws(() => f.bridge.topics.destination("session-a"), /not ready/);
});

test("topic cleanup accepts exact archived or deleted evidence but never missing, idle or unavailable status", async () => {
    for (const kind of ["archived", "deleted", "metadata-archived", "missing", "unavailable", "wrong-id", "idle"]) {
        const f = await fixture(); await f.bridge.enableTopics(); const a = f.route("session-a");
        if (kind === "archived") f.rows[0].archived_at = "2026-10-24T16:00:00Z";
        if (kind === "deleted") f.rows[0].deleted = true;
        if (["metadata-archived", "missing", "unavailable", "wrong-id"].includes(kind)) {
            f.rows.shift();
            f.app.get = async () => {
                if (kind === "unavailable") throw new Error("App status unavailable");
                if (kind === "metadata-archived") return { id: "session-a", archived_at: "2026-10-24T16:00:00Z" };
                if (kind === "wrong-id") return { id: "different-session", archived: true };
                return undefined;
            };
        }
        await f.bridge.sync();
        const retired = ["archived", "deleted", "metadata-archived"].includes(kind);
        assert.equal(f.calls.some(c => c.method === "delete" && c.threadId === a), retired, kind);
        assert.equal(Boolean(f.bridge.state.sessions["session-a"]), !retired, kind);
        if (["missing", "unavailable", "wrong-id"].includes(kind)) assert.match(f.bridge.topics.status().issues.join(" "), /unverified/, kind);
    }
});

test("topic cleanup keeps uncertain deletions fenced and continues other ready sessions", async () => {
    const f = await fixture(); await f.bridge.enableTopics();
    let deletes = 0;
    f.telegram.deleteTopic = async () => { deletes++; throw new Error("reply lost"); };
    await f.bridge.setOptIn("session-a", false); pending(f.rows[1]);
    await assert.rejects(f.bridge.sync(), /deletion uncertain/);
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-b"));
    await f.bridge.load();
    await assert.rejects(f.bridge.enableTopics(), /deletion uncertain/);
    assert.equal(deletes, 1);
    await assert.rejects(f.bridge.setOptIn("session-a", true), /deletion/);
});

test("topic cleanup retries definitive rejection only on explicit sync and never after a lost saved receipt", async () => {
    for (const kind of ["rejected", "receipt"]) {
        const f = await fixture(); await f.bridge.enableTopics();
        const save = f.store.save;
        let deletes = 0, fail = true;
        f.telegram.deleteTopic = async () => {
            deletes++;
            if (kind === "rejected" && fail) { fail = false; throw Object.assign(new Error("forbidden"), { apiCode: 403 }); }
        };
        f.store.save = async state => {
            if (kind === "receipt" && fail && state.topics.sessions["session-a"].deletion?.state === "deleted") {
                fail = false; throw new Error("receipt save failed");
            }
            return save(state);
        };
        await f.bridge.setOptIn("session-a", false);
        await assert.rejects(f.bridge.sync(), /deletion (rejected|uncertain)/);
        await assert.rejects(f.bridge.sync(), /deletion (rejected|uncertain)/);
        assert.equal(deletes, 1);
        if (kind === "rejected") { await f.bridge.enableTopics(); assert.equal(deletes, 2); }
        else { await assert.rejects(f.bridge.enableTopics(), /deletion uncertain/); assert.equal(deletes, 1); }
    }
});

test("topic cleanup cannot dispatch without a saved attempt and stops between canceled deletions", async () => {
    const f = await fixture(); await f.bridge.enableTopics();
    await f.bridge.setOptIn("session-a", false); await f.bridge.setOptIn("session-b", false);
    const save = f.store.save;
    f.store.save = async state => {
        if (Object.values(state.topics.sessions).some(r => r.deletion?.state === "attempting")) throw new Error("disk full");
        return save(state);
    };
    await assert.rejects(f.bridge.sync(), /disk full/);
    assert.equal(f.calls.filter(c => c.method === "delete").length, 0);

    const canceled = await fixture(); await canceled.bridge.enableTopics();
    await canceled.bridge.setOptIn("session-a", false); await canceled.bridge.setOptIn("session-b", false);
    const controller = new AbortController(), remove = canceled.telegram.deleteTopic;
    canceled.telegram.deleteTopic = async (...args) => { await remove(...args); controller.abort(); };
    await assert.rejects(canceled.bridge.sync(controller.signal), /canceled/);
    assert.equal(canceled.calls.filter(c => c.method === "delete").length, 1);
    assert.equal(canceled.bridge.state.topics.sessions["session-a"].deletion.state, "deleted");
    assert.equal(canceled.bridge.state.topics.sessions["session-b"].deletion, undefined);
});

test("topic cleanup re-selection creates a new topic and rejects stale controls without editing deleted messages", async () => {
    const f = await fixture(); await f.bridge.enableTopics(); pending(f.rows[0]); await f.bridge.sync();
    const old = f.route("session-a"), alias = f.bridge.state.sessions["session-a"].alias;
    const request = Object.values(f.bridge.state.requests)[0];
    request.state = "answered"; request.resolution = { answer: "First", source: "telegram" };
    let edits = 0; f.telegram.edit = async () => { edits++; throw new Error("old message deleted"); };
    await f.bridge.setOptIn("session-a", false); await f.bridge.sync();
    f.rows[0].awaiting_input.request_id = "new-request";
    await f.bridge.setOptIn("session-a", true); await f.bridge.sync();
    assert.notEqual(f.route("session-a"), old);
    assert.equal(f.bridge.state.sessions["session-a"].alias, alias);
    assert.equal(edits, 0);
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-a"));
    assert.equal(Object.values(f.bridge.state.requests).filter(r => r.sessionId === "session-a").length, 2);
    const sentBefore = f.sent.length;
    await f.receive("/tell OLD TOPIC", old);
    await f.receive("First", old, { reply_to_message: { message_id: request.messageId } });
    assert.equal(f.sent.length, sentBefore); assert.equal(f.messages.length, 0); assert.equal(f.answers.length, 0);
    assert.equal(f.bridge.topics.context(old).kind, "retired");
});

test("topic cleanup retains uncertain action evidence during deselection and service restart", async () => {
    const { Service } = await import("./service.mjs");
    const f = await fixture(); await f.bridge.enableTopics();
    f.bridge.state.signals["session-a"] = { idleDelivery: { eventId: "idle-x", state: "uncertain" } };
    f.bridge.state.requests.x = { key: "x", sessionId: "session-a", state: "notification-uncertain", messageUpdate: { state: "uncertain" } };
    await f.bridge.setOptIn("session-a", false);
    assert.equal(f.bridge.state.signals["session-a"].idleDelivery.state, "uncertain");
    assert.equal(f.bridge.state.requests.x.state, "notification-uncertain");
    const directory = await mkdtemp(join(tmpdir(), "telegram-deletion-restart-"));
    const service = new Service({ directory, app: f.app, selfId: "hub" });
    try {
        const saved = f.disk();
        saved.topics.sessions["session-a"].deletion = { state: "attempting", reason: "deselected", requestedAt: "2026-10-24T16:00:00Z" };
        await service.store.save(saved); await service.initialize();
        assert.equal(service.bridge.state.topics.sessions["session-a"].deletion.state, "uncertain");
        assert.match((await service.status()).topics.issues.join(" "), /deletion uncertain/);
    } finally { await service.close(); await rm(directory, { recursive: true }); }
});

test("topic cleanup transport deletes the exact private-chat topic and requires positive confirmation", async () => {
    const calls = [];
    const t = new Telegram("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk");
    t.paced = async (...args) => { calls.push(args); return true; };
    await t.deleteTopic(42, 77);
    assert.deepEqual(calls, [["deleteForumTopic", { chat_id: 42, message_thread_id: 77 }]]);
    t.paced = async () => false;
    await assert.rejects(t.deleteTopic(42, 77), /confirm.*deletion/);
});

test("topic cleanup never invents an uncertain topic identity or deletes without ownership", async () => {
    const f = await fixture(); await f.bridge.enableTopics();
    f.bridge.state.topics.sessions["session-a"].state = "uncertain";
    f.bridge.state.topics.sessions["session-a"].threadId = null;
    await f.bridge.setOptIn("session-a", false);
    await assert.rejects(f.bridge.enableTopics(), /identity uncertain/);
    assert.equal(f.calls.filter(c => c.method === "delete").length, 0);
    assert.equal(f.calls.filter(c => c.method === "create").length, 3);
    f.bridge.state.topics.chatId = 99;
    await assert.rejects(f.bridge.sync(), /ownership/);
    assert.equal(f.calls.filter(c => c.method === "delete").length, 0);
});

test("topic cleanup validates deleted receipts and retired-thread uniqueness before routing", async () => {
    const f = await fixture(); await f.bridge.enableTopics();
    await f.bridge.setOptIn("session-a", false); await f.bridge.sync();
    const saved = f.disk();
    delete saved.topics.sessions["session-a"].deletion.completedAt;
    await f.store.save(saved);
    await assert.rejects(f.bridge.load(), /deletion receipt/);
    saved.topics.sessions["session-a"].deletion.completedAt = new Date().toISOString();
    saved.topics.sessions["session-b"].retired = [{
        threadId: saved.topics.sessions["session-a"].threadId,
        deletion: saved.topics.sessions["session-a"].deletion,
    }];
    await f.store.save(saved);
    await assert.rejects(f.bridge.load(), /duplicated/);
});

test("topic cleanup refuses Bridge and still-selected topics even at the deletion boundary", async () => {
    const f = await fixture(); await f.bridge.enableTopics();
    await assert.rejects(f.bridge.topics.remove(f.bridge.state.topics.bridge, false), /not eligible/);
    await assert.rejects(f.bridge.topics.remove(f.bridge.state.topics.sessions["session-a"], false), /not eligible/);
    assert.equal(f.calls.filter(c => c.method === "delete").length, 0);
});

test("topic cleanup does not reissue an uncertain app answer in a replacement topic", async () => {
    const f = await fixture(); await f.bridge.enableTopics(); pending(f.rows[0]); await f.bridge.sync();
    const request = Object.values(f.bridge.state.requests)[0];
    request.state = "uncertain";
    await f.bridge.setOptIn("session-a", false); await f.bridge.sync();
    await f.bridge.setOptIn("session-a", true); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.equal(f.answers.length, 0);
    assert.equal(Object.values(f.bridge.state.requests).length, 1);
    assert.equal(f.bridge.state.requests[request.key].state, "uncertain");
});
test("topics require explicit activation and confirmed private-topic capability", async () => {
    const f = await fixture();
    await f.bridge.sync();
    assert.equal(f.calls.length, 0);
    f.telegram.identity = async () => ({ id: 1000, hasTopicsEnabled: false });
    await assert.rejects(f.bridge.enableTopics(), /BotFather/);
    assert.equal(f.bridge.state.topics.enabled, false);
    f.telegram.identity = async () => ({ id: 9999, hasTopicsEnabled: true });
    await assert.rejects(f.bridge.enableTopics(), /identity/i);
    assert.equal(f.calls.length, 0);
    f.bridge.state.peer = null;
    await assert.rejects(f.bridge.enableTopics(), /pair/i);
});

test("topics create Bridge and one durable topic per selection and survive rename/restart", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    assert.deepEqual(f.calls.map(c => c.name), ["Bridge", "First", "Second"]);
    assert.ok(f.snapshots.some(s => s.topics.bridge?.state === "creating"));
    const before = f.route("session-a");
    await f.bridge.load();
    f.rows[0].name = "Renamed";
    await f.bridge.sync();
    assert.equal(f.route("session-a"), before);
    assert.equal(f.calls.filter(c => c.method === "create").length, 3);
    assert.deepEqual(f.calls.at(-1), { method: "edit", chatId: 42, threadId: before, name: "Renamed" });
    await f.bridge.sync();
    assert.equal(f.calls.length, 4);
});

test("topics simplify saved numbered titles without changing aliases or duplicate-name routing", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    const a = f.route("session-a"), b = f.route("session-b");
    f.bridge.state.topics.sessions["session-a"].name = "000 - First";
    f.bridge.state.topics.sessions["session-b"].name = "001 - Second";
    await f.bridge.save();
    await f.bridge.load();
    const aliases = structuredClone(f.bridge.state.aliases);
    f.rows[1].name = "First";
    await f.bridge.sync();
    assert.deepEqual(f.calls.slice(-2), [
        { method: "edit", chatId: 42, threadId: a, name: "First" },
        { method: "edit", chatId: 42, threadId: b, name: "First" },
    ]);
    assert.notEqual(a, b);
    assert.deepEqual(f.bridge.state.aliases, aliases);
    assert.equal(f.calls.filter(c => c.method === "create").length, 3);
    await f.receive("/tell Continue", b);
    await f.receive("/tell 000 Continue from Bridge", f.bridge.state.topics.bridge.threadId);
    assert.deepEqual(f.messages, [["session-b", "Continue"], ["session-a", "Continue from Bridge"]]);
    await f.receive("/status", f.bridge.state.topics.bridge.threadId);
    assert.match(f.sent.at(-1).text, /\[000\] First: idle\n\[001\] First: idle/);
    const calls = f.calls.length;
    await f.bridge.sync();
    assert.equal(f.calls.length, calls);
});

test("topics reject empty display names without creating invalid routes and recover after naming", async () => {
    const f = await fixture();
    f.bridge.state.sessions["session-a"].name = " ";
    await assert.rejects(f.bridge.enableTopics(), /name.*empty/i);
    assert.equal(f.bridge.state.topics.sessions["session-a"], undefined);
    assert.ok(f.route("session-b"));
    await f.bridge.load();
    await f.bridge.sync();
    assert.equal(f.bridge.state.topics.sessions["session-a"].name, "First");
});

test("topics route questions and original-question acknowledgments to the same thread", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    pending(f.rows[0]); pending(f.rows[1]);
    await f.bridge.sync();
    assert.equal(f.sent[0].message_thread_id, f.route("session-a"));
    assert.equal(f.sent[1].message_thread_id, f.route("session-b"));
    assert.equal(f.sent[0].text.split("\n")[0], "First");
    assert.equal(f.sent[1].text.split("\n")[0], "Second");
    await f.receive("First", f.route("session-a"), { reply_to_message: { message_id: 1 } });
    assert.deepEqual(f.answers, [["session-a", "q-session-a", "First"]]);
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-a"));
    assert.equal(f.edits[0].text, "First\n\nWhich option?\n\nAnswered\nAnswer: First");
});

test("topics reject cross-thread question replies and callback forgeries", async () => {
    const f = await fixture();
    await f.bridge.enableTopics(); pending(f.rows[0]); await f.bridge.sync();
    await f.receive("First", f.route("session-b"), { reply_to_message: { message_id: 1 } });
    assert.equal(f.answers.length, 0);
    await f.bridge.receive({ update_id: 50, callback_query: {
        id: "wrong-thread", from: { id: 42 }, data: f.sent[0].reply_markup.inline_keyboard[0][0].callback_data,
        message: { message_id: 1, message_thread_id: f.route("session-b"), chat: { id: 42, type: "private" } },
    } });
    assert.equal(f.answers.length, 0);
    assert.equal(Object.values(f.bridge.state.requests)[0].state, "pending");
    await f.bridge.receive({ update_id: 51, callback_query: {
        id: "right-thread", from: { id: 42 }, data: f.sent[0].reply_markup.inline_keyboard[0][0].callback_data,
        message: { message_id: 1, message_thread_id: f.route("session-a"), chat: { id: 42, type: "private" } },
    } });
    assert.deepEqual(f.answers, [["session-a", "q-session-a", "First"]]);
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-a"));
});

test("topics support local tell but refuse cross-session, inactive, unknown and ambiguous routing", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    const a = f.route("session-a"), b = f.route("session-b");
    await f.receive("/tell Continue now", a);
    await f.receive("/tell 000 Same target", a);
    await f.receive("/tell 001 Wrong target", a);
    await f.receive("/tell 000 Unknown topic", 999);
    await f.receive("/tell Unaddressed", f.bridge.state.topics.bridge.threadId);
    await f.receive("yes", a);
    assert.deepEqual(f.messages, [["session-a", "Continue now"], ["session-a", "Same target"], ["session-a", "yes"]]);
    await f.receive("/tell 001 From Bridge", f.bridge.state.topics.bridge.threadId);
    assert.deepEqual(f.messages.at(-1), ["session-b", "From Bridge"]);
    await f.bridge.setOptIn("session-a", false); await f.bridge.sync();
    await f.receive("/tell Continue", a);
    assert.equal(f.messages.length, 4);
    assert.equal(f.route("session-a"), a);
    assert.equal(f.calls.at(-1).method, "delete");
    await f.bridge.setOptIn("session-a", true); await f.bridge.sync();
    assert.notEqual(f.route("session-a"), a);
    assert.equal(f.route("session-b"), b);
    assert.equal(f.calls.filter(c => c.method === "create").length, 4);
    pending(f.rows[0]);
    await f.receive("/tell Continue", f.route("session-a"));
    assert.equal(f.messages.length, 4);
});

test("topics keep old pending questions in their original chat without copying history", async () => {
    const f = await fixture();
    pending(f.rows[0]); await f.bridge.sync();
    assert.equal(f.sent[0].message_thread_id, undefined);
    await f.bridge.enableTopics(); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    await f.receive("Second", undefined, { reply_to_message: { message_id: 1 } });
    assert.deepEqual(f.answers, [["session-a", "q-session-a", "Second"]]);
    assert.equal(f.sent.at(-1).message_thread_id, undefined);
    assert.equal(f.edits[0].text.split("\n")[0], "[000] First");
});

test("topics never replay uncertain creation after restart and continue independent sessions", async () => {
    const f = await fixture();
    const create = f.telegram.createTopic;
    f.telegram.createTopic = async (chat, name) => {
        if (name === "First") { f.calls.push({ method: "uncertain-create" }); throw new Error("connection lost"); }
        return create(chat, name);
    };
    await assert.rejects(f.bridge.enableTopics(), /uncertain/i);
    assert.equal(f.bridge.state.topics.sessions["session-a"].state, "uncertain");
    assert.ok(f.route("session-b"));
    await f.bridge.load();
    pending(f.rows[0]); pending(f.rows[1]);
    await assert.rejects(f.bridge.sync(), /uncertain/i);
    assert.equal(f.calls.filter(c => c.method === "uncertain-create").length, 1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].message_thread_id, f.route("session-b"));
    await assert.rejects(f.bridge.enableTopics(), /uncertain/i);
    assert.equal(f.calls.filter(c => c.method === "uncertain-create").length, 1);
});

test("topics retry definitive rejections only through explicit activation and never send to the main chat", async () => {
    const f = await fixture();
    const create = f.telegram.createTopic;
    let rejected = true;
    f.telegram.createTopic = async (chat, name) => {
        if (name === "First" && rejected) {
            f.calls.push({ method: "rejected-create" });
            throw Object.assign(new Error("Telegram API rejected createForumTopic (429)"), { apiCode: 429 });
        }
        return create(chat, name);
    };
    await assert.rejects(f.bridge.enableTopics(), /rejected/i);
    rejected = false; pending(f.rows[0]);
    await assert.rejects(f.bridge.sync(), /rejected/i);
    assert.equal(f.sent.length, 0);
    await f.bridge.enableTopics(); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].message_thread_id, f.route("session-a"));
});

test("topics reject duplicate or malformed persisted bindings before control can start", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    const state = f.disk();
    state.topics.sessions["session-a"].threadId = state.topics.bridge.threadId;
    await f.store.save(state);
    await assert.rejects(f.bridge.load(), /topic/i);
    state.topics.sessions["session-a"].threadId = "100";
    await f.store.save(state);
    await assert.rejects(f.bridge.load(), /topic/i);
});

test("topics route every idle reply part and app-only alert to the session thread", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    f.bridge.state.idleEpoch = "epoch";
    f.bridge.idleReplies = { async read(id) { return id === "session-a"
        ? { eventId: "idle-1", idleAt: new Date().toISOString(), content: "x".repeat(7500) } : null; } };
    await f.bridge.sync();
    assert.equal(f.sent.length, 3);
    assert.ok(f.sent.every(m => m.message_thread_id === f.route("session-a")));
    assert.ok(f.sent.every((m, i) => m.text.startsWith(`First\n* IDLE *\n(part ${i + 1}/3)\n\n`)));
    f.rows[1].awaiting_plan_approval = true;
    await f.bridge.sync();
    assert.match(f.sent.at(-1).text, /Needs input in the Copilot app/);
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-b"));
    assert.equal(f.sent.at(-1).text.split("\n")[0], "Second");
});

test("topics scope status/help responses and never expose control through foreign senders or groups", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    await f.receive("/status", f.route("session-a"));
    assert.match(f.sent.at(-1).text, /\[000\]/);
    assert.doesNotMatch(f.sent.at(-1).text, /\[001\]/);
    await f.receive("/help", f.route("session-a"));
    assert.equal(f.sent.at(-1).message_thread_id, f.route("session-a"));
    await f.receive("/status", f.bridge.state.topics.bridge.threadId);
    assert.match(f.sent.at(-1).text, /\[000\].*\n\[001\]/);
    await f.receive("/tell Continue", f.route("session-a"), { from: { id: 99 } });
    await f.receive("/tell Continue", f.route("session-a"), { chat: { id: 42, type: "supergroup" } });
    assert.equal(f.messages.length, 0);
});

test("topics transport preserves capability, exact thread parameters and safe rejection codes", async () => {
    const calls = [];
    const t = new Telegram("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk", async (url, init) => {
        calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ ok: true, result: calls.length === 1
            ? { id: 1000, is_bot: true, username: "test_bot", has_topics_enabled: true }
            : calls.length === 2 ? { message_thread_id: 77, name: "Topic" } : true }) };
    });
    assert.equal((await t.identity()).hasTopicsEnabled, true);
    assert.equal((await t.createTopic(42, "Topic")).message_thread_id, 77);
    await t.editTopic(42, 77, "Renamed");
    await t.send(42, "Hello", { message_thread_id: 77 });
    assert.deepEqual(calls.slice(1, 3), [
        { method: "createForumTopic", body: { chat_id: 42, name: "Topic" } },
        { method: "editForumTopic", body: { chat_id: 42, message_thread_id: 77, name: "Renamed" } },
    ]);
    assert.equal(calls[3].body.message_thread_id, 77);
    const rejected = new Telegram("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk", async () => ({
        ok: false, json: async () => ({ ok: false, error_code: 400, description: "private provider detail" }),
    }));
    await assert.rejects(rejected.createTopic(42, "Topic"), e =>
        e.apiCode === 400 && !e.message.includes("private provider detail"));
});

test("topics never create before a durable activation/attempt record or replay a lost creation receipt", async () => {
    const f = await fixture();
    const save = f.store.save;
    f.store.save = async () => { throw new Error("disk full"); };
    await assert.rejects(f.bridge.enableTopics(), /disk full/);
    assert.equal(f.bridge.state.topics.enabled, false);
    assert.equal(f.calls.length, 0);
    f.store.save = save;
    await f.bridge.enableTopics();
    f.rows.push({ id: "session-c", name: "Third", activity: { status: "idle" } });
    await f.bridge.setOptIn("session-c", true);
    let fail = true;
    f.store.save = async state => {
        if (fail && state.topics.sessions["session-c"]?.state === "ready") {
            fail = false; throw new Error("receipt disk error");
        }
        await save(state);
    };
    await assert.rejects(f.bridge.sync(), /uncertain.*receipt disk error/);
    await f.bridge.load();
    await assert.rejects(f.bridge.sync(), /uncertain/);
    assert.equal(f.calls.filter(c => c.method === "create" && c.name === "Third").length, 1);
    assert.equal(f.bridge.state.topics.sessions["session-c"].state, "uncertain");
});

test("topics retain routing when a rename is uncertain without replaying the rename", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    const id = f.route("session-a");
    f.rows[0].name = "New name";
    let edits = 0;
    f.telegram.editTopic = async () => { edits++; throw new Error("lost rename response"); };
    pending(f.rows[0]);
    await assert.rejects(f.bridge.sync(), /rename uncertain/);
    assert.equal(f.sent[0].message_thread_id, id);
    await f.bridge.load();
    await assert.rejects(f.bridge.sync(), /rename uncertain/);
    assert.equal(edits, 1);
    assert.equal(f.route("session-a"), id);
});

test("topics isolate failed destination sends without rerouting or blocking other sessions", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    pending(f.rows[0]); pending(f.rows[1]);
    const send = f.telegram.send;
    f.telegram.send = async (chatId, text, extra) => {
        if (extra.message_thread_id === f.route("session-a")) throw new Error("Topic no longer exists");
        return send(chatId, text, extra);
    };
    await assert.rejects(f.bridge.sync(), /Topic no longer exists/);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].message_thread_id, f.route("session-b"));
    assert.equal(Object.values(f.bridge.state.requests).find(r => r.sessionId === "session-a").state, "notification-uncertain");
});

test("topics do not route instructions or old answers to an archived app session", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    f.rows[0].archived_at = new Date().toISOString();
    await f.receive("/tell Continue", f.route("session-a"));
    assert.equal(f.messages.length, 0);
    f.rows[0].archived_at = null;
    pending(f.rows[0]); await f.bridge.sync();
    const question = Object.values(f.bridge.state.requests)[0];
    f.rows[0].archived_at = new Date().toISOString();
    await f.receive("First", f.route("session-a"), { reply_to_message: { message_id: question.messageId } });
    assert.equal(f.answers.length, 0);
});

test("topics service gates local activation and exposes saved route health", async () => {
    const { Service } = await import("./service.mjs");
    const f = await fixture();
    const service = new Service({ directory: "unused-test-directory", app: f.app, selfId: "hub" });
    service.initialized = true;
    service.bridge = f.bridge;
    await assert.rejects(service.action({ action: "topics" }), /Connect and pair/);
    service.connected = true;
    await service.action({ action: "topics" });
    assert.equal((await service.status()).topics.enabled, true);
    assert.equal((await service.status()).topics.ready, 2);
    service.connected = false;
    await assert.rejects(service.action({ action: "topics" }), /Connect and pair/);
    assert.equal(f.calls.filter(c => c.method === "create").length, 3);
});
