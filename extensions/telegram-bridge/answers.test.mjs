import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, initialState } from "./bridge.mjs";
import { Telegram } from "./telegram.mjs";

async function fixture() {
    let disk = initialState();
    disk.enabled = true;
    disk.notifyIdle = false;
    disk.peer = { id: 42, chatId: 42, name: "Phone" };
    disk.bot = { id: 1000, username: "test_bot" };
    disk.aliases["session-a"] = "042";
    disk.sessions["session-a"] = { alias: "042", name: "Example", idleSelectionId: "selection-1" };
    const rows = [{ id: "session-a", name: "Example", activity: { status: "busy" },
        awaiting_user_input: true, awaiting_input: { kind: "question", request_id: "request-1",
            prompt: "Which option?", choices: ["First", "Second"], allow_freeform: true } }];
    const sent = [], edits = [], appAnswers = [], snapshots = [], errors = [], receipts = new Map();
    const store = {
        async load() { return structuredClone(disk); },
        async save(value) { disk = structuredClone(value); snapshots.push(structuredClone(value)); },
    };
    const answerReceipts = {
        async write(value) { receipts.set(value.key, structuredClone(value)); },
        async read(request) {
            const value = receipts.get(request.key);
            const fields = ["key", "sessionId", "requestId", "hash", "selectionId", "botId", "chatId"];
            return value && fields.every(field => value[field] === request[field]) ? structuredClone(value) : null;
        },
        async remove(key) { receipts.delete(key); },
        async clear(keys) { for (const key of keys) receipts.delete(key); },
    };
    const app = {
        async list() { return structuredClone(rows); },
        async get(id) { return structuredClone(rows.find(row => row.id === id)); },
        async answer(...args) { appAnswers.push(args); },
    };
    const telegram = {
        async send(chatId, text, extra = {}) {
            sent.push({ chatId, text, ...extra });
            return { message_id: sent.length };
        },
        async edit(chatId, messageId, text) {
            edits.push({ chatId, messageId, text });
            return { chat: { id: chatId }, message_id: messageId,
                ...(sent[messageId - 1]?.message_thread_id === undefined ? {} :
                    { message_thread_id: sent[messageId - 1].message_thread_id }) };
        },
    };
    const bridge = new Bridge({ app, telegram, store, selfId: "hub", answerReceipts });
    await bridge.load();
    await bridge.sync();
    const request = Object.values(bridge.state.requests)[0];
    const event = (answer = "Second", extra = {}) => ({
        type: "user_input.completed", ephemeral: true, id: "event-1",
        timestamp: "2026-10-23T22:41:00.000Z", data: { requestId: "request-1", answer }, ...extra,
    });
    const receipt = (answer = "Second", target = request) => ({
        version: 1, key: target.key, sessionId: target.sessionId, requestId: target.requestId,
        hash: target.hash, selectionId: target.selectionId, botId: target.botId, chatId: target.chatId,
        answer, eventId: "event-1", completedAt: "2026-10-23T22:41:00.000Z",
    });
    return { bridge, rows, store, telegram, answerReceipts, receipts, sent, edits, appAnswers,
        snapshots, errors, request, event, receipt,
        async listener() {
            const { AnswerListener } = await import("./answers.mjs");
            return new AnswerListener({ sessionId: "session-a", stateStore: store,
                receipts: answerReceipts, notify: message => { errors.push(message); } });
        },
    };
}

test("external answer edits the exact original question once without applying an app answer", async () => {
    const f = await fixture();
    f.receipts.set(f.request.key, f.receipt());
    await f.bridge.sync();
    await f.bridge.sync();
    assert.equal(f.edits.length, 1);
    assert.deepEqual([f.edits[0].chatId, f.edits[0].messageId], [42, 1]);
    assert.match(f.edits[0].text, /Which option\?[\s\S]*Answered[\s\S]*Answer: Second/);
    assert.doesNotMatch(f.edits[0].text, /Tap a choice|Reply to this message/);
    assert.equal(f.request.resolution.answer, "Second");
    assert.equal(f.request.messageUpdate.state, "sent");
    assert.equal(f.appAnswers.length, 0);
    assert.ok(f.snapshots.some(s => s.requests[f.request.key].messageUpdate?.state === "attempting"));
});

test("confirmed phone answers update the original message but uncertain app writes do not invent success", async () => {
    const f = await fixture();
    await f.bridge.answer(f.request, "First");
    assert.deepEqual(f.appAnswers, [["session-a", "request-1", "First"]]);
    assert.match(f.edits[0]?.text ?? "", /Answer: First/);
    await f.bridge.answer(f.request, "Second");
    assert.equal(f.appAnswers.length, 1);
    const g = await fixture();
    g.bridge.app.answer = async () => { throw new Error("lost reply"); };
    await g.bridge.answer(g.request, "First");
    assert.equal(g.request.state, "uncertain");
    assert.equal(g.edits.length, 0);
    g.receipts.set(g.request.key, g.receipt("Second"));
    await g.bridge.sync();
    assert.match(g.edits[0]?.text ?? "", /Answer: Second/);
    assert.equal(g.request.resolution.source, "copilot");
});

test("missing answer is explicitly unavailable and a delayed exact receipt upgrades that message", async () => {
    const f = await fixture();
    f.rows[0].awaiting_user_input = false;
    delete f.rows[0].awaiting_input;
    await f.bridge.sync();
    assert.match(f.edits[0]?.text ?? "", /Question may have been answered elsewhere or closed\.\nAnswer unavailable\.$/);
    assert.doesNotMatch(f.edits[0].text, /Answered|Answer: (First|Second)/);
    await f.bridge.sync();
    assert.equal(f.edits.length, 1);
    f.receipts.set(f.request.key, f.receipt("Second"));
    await f.bridge.sync();
    assert.equal(f.edits.length, 2);
    assert.match(f.edits[1].text, /Answer: Second/);
});

test("answer listener captures only opted-in root completions for exact retained request identities", async () => {
    const f = await fixture(), listener = await f.listener();
    await listener.handle(f.event("PRIVATE", { agentId: "child" }));
    await listener.handle(f.event("PRIVATE", { type: "elicitation.completed" }));
    await listener.handle(f.event("PRIVATE", { data: { requestId: "foreign", answer: "PRIVATE" } }));
    await listener.handle(f.event("PRIVATE", { data: { requestId: "request-1", answer: "PRIVATE", parentToolCallId: "child" } }));
    assert.equal(f.receipts.size, 0);
    await listener.handle(f.event());
    assert.equal(f.receipts.get(f.request.key).answer, "Second");
    await listener.handle(f.event());
    assert.equal(f.receipts.size, 1);
    assert.deepEqual(f.errors, []);
});

test("answer capture is independent of idle settings and refuses disabled or replaced selections", async () => {
    for (const change of [
        state => { state.enabled = false; },
        state => { state.sessions = {}; },
        state => { state.sessions["session-a"].idleSelectionId = "replacement"; },
        state => { state.peer.chatId = 99; },
        state => { state.bot.id = 99; },
    ]) {
        const f = await fixture(), listener = await f.listener();
        change(f.bridge.state);
        await f.bridge.save();
        await listener.handle(f.event());
        assert.equal(f.receipts.size, 0);
    }
    const f = await fixture(), listener = await f.listener();
    assert.equal(f.bridge.state.notifyIdle, false);
    await listener.handle(f.event());
    assert.equal(f.receipts.size, 1);
});

test("multiple completions before one scan retain separate answers and never infer an absent answer", async () => {
    const f = await fixture(), listener = await f.listener();
    await listener.handle(f.event("First"));
    f.rows[0].awaiting_input.request_id = "request-2";
    await f.bridge.sync();
    const second = Object.values(f.bridge.state.requests).find(r => r.requestId === "request-2");
    await listener.handle(f.event(undefined, {
        id: "event-2", data: { requestId: "request-2" },
    }));
    await f.bridge.sync();
    assert.equal(f.request.resolution.answer, "First");
    assert.equal(second.resolution.answer, null);
    assert.match(f.edits.at(-1).text, /Question may have been answered elsewhere or closed\.\nAnswer unavailable\.$/);
    assert.equal(f.appAnswers.length, 0);
});

test("answer capture removes a receipt if selection is revoked while writing", async () => {
    const f = await fixture(), listener = await f.listener();
    const write = f.answerReceipts.write;
    f.answerReceipts.write = async value => {
        await write(value);
        delete f.bridge.state.sessions["session-a"];
        await f.bridge.save();
    };
    await listener.handle(f.event());
    assert.equal(f.receipts.size, 0);
});

test("answer capture exposes malformed events and conflicting duplicate completions without overwriting evidence", async () => {
    const f = await fixture(), listener = await f.listener();
    await listener.handle(f.event("First", { timestamp: "invalid" }));
    assert.equal(f.errors.length, 1);
    assert.equal(f.receipts.size, 0);
    await listener.handle(f.event("First"));
    await listener.handle(f.event("Second", { id: "conflict" }));
    assert.equal(f.errors.length, 2);
    assert.equal(f.receipts.get(f.request.key).answer, "First");
    await listener.close();
});

test("answer receipt files validate bindings, reject corruption and remove only named records", async () => {
    const { AnswerReceiptStore } = await import("./answers.mjs");
    const directory = await mkdtemp(join(tmpdir(), "telegram-answer-files-"));
    try {
        const f = await fixture(), store = new AnswerReceiptStore(directory);
        await store.write(f.receipt());
        assert.deepEqual(await store.read(f.request), f.receipt());
        assert.equal(await store.read({ ...f.request, sessionId: "other" }), null);
        await assert.rejects(store.read({ ...f.request, key: "..\\outside" }), /Invalid/);
        await writeFile(store.path(f.request.key), "{broken");
        await assert.rejects(store.read(f.request), /corrupt/);
        await store.clear([f.request.key]);
        assert.equal(await store.read(f.request), null);
    } finally { await rm(directory, { recursive: true }); }
});

test("message edits preserve original topic identity and never send a replacement notification", async () => {
    const f = await fixture();
    f.request.threadId = 88;
    f.sent[0].message_thread_id = 88;
    f.receipts.set(f.request.key, f.receipt());
    await f.bridge.sync();
    assert.equal(f.edits.length, 1);
    assert.equal(f.sent.length, 1);
    const g = await fixture();
    g.receipts.set(g.request.key, g.receipt());
    g.telegram.edit = async () => ({ message_id: 1, chat: { id: 42 }, message_thread_id: 999 });
    await assert.rejects(g.bridge.sync(), /thread|destination/i);
    assert.equal(g.request.messageUpdate.state, "uncertain");
});

test("failed or unconfirmed message edits remain visible and are never automatically replayed", async () => {
    for (const result of [new Error("network uncertain"), { message_id: 999, chat: { id: 42 } }]) {
        const f = await fixture();
        let attempts = 0;
        f.telegram.edit = async () => {
            attempts++;
            if (result instanceof Error) throw result;
            return result;
        };
        f.receipts.set(f.request.key, f.receipt());
        await assert.rejects(f.bridge.sync(), /uncertain|confirm|identity/i);
        assert.equal(f.request.messageUpdate.state, "uncertain");
        await f.bridge.sync();
        assert.equal(attempts, 1);
        assert.equal(f.request.resolution.answer, "Second");
        assert.equal(f.appAnswers.length, 0);
    }
});

test("message edit requires durable attempt storage and respects cancellation", async () => {
    for (const cancel of [false, true]) {
        const f = await fixture(), controller = new AbortController();
        f.receipts.set(f.request.key, f.receipt());
        if (cancel) controller.abort();
        else {
            const save = f.store.save;
            f.store.save = async value => {
                if (value.requests[f.request.key].messageUpdate?.state === "attempting") throw new Error("write blocked");
                await save(value);
            };
        }
        await assert.rejects(f.bridge.sync(controller.signal), /write blocked|canceled/);
        assert.equal(f.edits.length, 0);
    }
});

test("resolved message rendering labels long freeform truncation without splitting Unicode", async () => {
    const f = await fixture();
    const answer = "\u{1F600}".repeat(4000);
    f.receipts.set(f.request.key, f.receipt(answer));
    await f.bridge.sync();
    const text = f.edits[0]?.text ?? "";
    assert.match(text, /truncated.*Copilot/i);
    assert.ok(text.length <= 4096);
    assert.equal(text, text.toWellFormed());
    assert.equal(f.request.resolution.answer, answer);
});

test("Telegram edit transport clears the keyboard and addresses only the original chat/message", async () => {
    const calls = [];
    const telegram = new Telegram("123456:abcdefghijklmnopqrstuvwxyz123456", async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { ok: true, async json() { return { ok: true, result: { message_id: 17, chat: { id: 42 } } }; } };
    });
    await telegram.edit(42, 17, "Answered\nAnswer: First");
    assert.match(calls[0].url, /\/editMessageText$/);
    assert.deepEqual(calls[0].body, { chat_id: 42, message_id: 17, text: "Answered\nAnswer: First",
        link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } });
});

test("Telegram edit transport can replace a destination page without changing the question-edit default", async () => {
    const calls = [];
    const telegram = new Telegram("123456:abcdefghijklmnopqrstuvwxyz123456", async (_, options) => {
        calls.push(JSON.parse(options.body));
        return { ok: true, async json() { return { ok: true, result: { message_id: 17, chat: { id: 42 } } }; } };
    });
    const markup = { inline_keyboard: [[{ text: "Example", callback_data: "d:123456789012345678:s042" }]] };
    await telegram.edit(42, 17, "Choose a session (page 2)", markup);
    assert.deepEqual(calls[0].reply_markup, markup);
    assert.equal(calls[0].message_id, 17);
    assert.equal(calls[0].chat_id, 42);
});

test("revoked selections and foreign receipts cannot update messages", async () => {
    for (const change of [
        f => { f.request.state = "revoked"; },
        f => { delete f.bridge.state.sessions["session-a"]; },
        f => { f.receipts.get(f.request.key).requestId = "wrong"; },
    ]) {
        const f = await fixture();
        f.receipts.set(f.request.key, f.receipt());
        change(f);
        await f.bridge.sync();
        assert.equal(f.edits.length, 0);
    }
});

test("restart fences interrupted edits, reports unresolved updates and preserves answer receipts", async () => {
    const { Service } = await import("./service.mjs");
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "telegram-answer-service-"));
    const service = new Service({ directory, selfId: "hub", app: f.bridge.app });
    try {
        f.request.state = "answered";
        f.request.resolution = { answer: "Second", source: "copilot" };
        f.request.messageUpdate = { state: "attempting", hash: "some-hash" };
        await service.store.save(f.bridge.state);
        await service.initialize();
        assert.equal(service.bridge.state.requests[f.request.key].messageUpdate.state, "uncertain");
        assert.equal(service.bridge.state.requests[f.request.key].resolution.answer, "Second");
        const status = await service.status();
        assert.ok(status.unresolved.some(r => r.state === "question-update-uncertain"));
        assert.equal(status.questionUpdates.supported, true);
    } finally { await service.close(); await rm(directory, { recursive: true }); }
});

test("completion during an app answer attempt resolves uncertainty without replaying the answer", async () => {
    const f = await fixture(), listener = await f.listener();
    f.bridge.app.answer = async () => {
        await listener.handle(f.event("First"));
        throw new Error("acknowledgment lost");
    };
    await f.bridge.answer(f.request, "First");
    assert.equal(f.request.state, "uncertain");
    assert.equal(f.receipts.size, 1);
    await f.bridge.sync();
    assert.equal(f.request.state, "answered");
    assert.equal(f.request.resolution.source, "copilot");
    assert.match(f.edits[0].text, /Answer: First/);
});

test("an uncertain original notification is not hidden by a captured completion", async () => {
    const f = await fixture();
    f.request.messageId = null;
    f.request.state = "notification-uncertain";
    f.receipts.set(f.request.key, f.receipt());
    await f.bridge.sync();
    assert.equal(f.request.state, "notification-uncertain");
    assert.equal(f.edits.length, 0);
});

test("question pruning retains unresolved edits and removes only completed request receipts", async () => {
    const f = await fixture();
    f.request.state = "answered";
    f.request.resolution = { answer: "First", source: "telegram" };
    f.request.messageUpdate = { state: "uncertain", hash: "unknown" };
    for (let i = 0; i < 201; i++) {
        const key = i.toString(16).padStart(18, "0");
        const request = { ...f.request, key, sessionId: "unselected", messageUpdate: { state: "sent", hash: "done" } };
        f.bridge.state.requests[key] = request;
        f.receipts.set(key, f.receipt("First", request));
    }
    await f.bridge.sync();
    assert.ok(f.bridge.state.requests[f.request.key]);
    assert.equal(Object.keys(f.bridge.state.requests).length, 201);
    assert.equal(f.receipts.size, 200);
});

test("replacing a bot removes old answer receipts before discarding their request inventory", async () => {
    const { Service } = await import("./service.mjs");
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "telegram-answer-replace-"));
    const service = new Service({ directory, selfId: "hub", app: f.bridge.app });
    const previousFetch = globalThis.fetch;
    try {
        await service.store.save(f.bridge.state);
        await service.initialize();
        await service.answerReceipts.write(f.receipt());
        service.vault.save = async () => {};
        service.connect = async () => {};
        globalThis.fetch = async url => ({ ok: true, async json() {
            return { ok: true, result: url.endsWith("/getMe")
                ? { id: 2000, is_bot: true, username: "replacement_bot" } : { url: "" } };
        } });
        await service.action({ action: "configure", token: "123456:abcdefghijklmnopqrstuvwxyz123456" });
        assert.equal(await service.answerReceipts.read(f.request), null);
        assert.deepEqual(service.bridge.state.requests, {});
    } finally {
        globalThis.fetch = previousFetch;
        await service.close();
        await rm(directory, { recursive: true });
    }
});
