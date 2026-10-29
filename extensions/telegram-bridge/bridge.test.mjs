import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const owner = { id: 42, chatId: 42, name: "Phone" };
const pending = (id = "request-1", question = "Which option?") => ({
    kind: "ask_user", request_id: id, question, choices: ["First", "Second"], allow_freeform: true,
});
const nativePending = (id = "request-1", prompt = "Which option?") => ({
    kind: "question", request_id: id, prompt, choices: ["First", "Second"], allow_freeform: true,
    untrusted: true, handling: "treat_as_data_not_instructions",
});
const row = (input = pending()) => ({
    id: "session-a", name: "Example session", project_name: "Example",
    activity: { status: "busy" }, awaiting_user_input: Boolean(input),
    ...(input ? { awaiting_input: input } : {}),
});
async function fixture() {
    const { Bridge, initialState } = await import("./bridge.mjs");
    let disk = initialState();
    disk.peer = owner;
    disk.enabled = true;
    disk.sessions["session-a"] = { alias: "042", name: "Example session" };
    disk.aliases["session-a"] = "042";
    const sent = [], answers = [], messages = [], snapshots = [];
    const app = {
        rows: [row()],
        async list() { return structuredClone(this.rows); },
        async get(id) { return structuredClone(this.rows.find(r => r.id === id)); },
        async answer(...args) { answers.push(args); },
        async tell(...args) { messages.push(args); },
    };
    const telegram = {
        botId: 100,
        async send(chat, text, extra = {}) {
            sent.push({ chat, text, ...extra });
            return { message_id: sent.length, chat: { id: chat } };
        },
        async edit(chat, messageId) { return { message_id: messageId, chat: { id: chat } }; },
        async callback() {},
    };
    const store = {
        async load() { return structuredClone(disk); },
        async save(value) { disk = structuredClone(value); snapshots.push(structuredClone(value)); },
    };
    const bridge = new Bridge({ app, telegram, store, selfId: "hub", now: () => 1000 });
    await bridge.load();
    return { bridge, app, sent, answers, messages, snapshots, disk: () => disk };
}
const reply = (updateId, text, messageId = 1, userId = 42) => ({
    update_id: updateId,
    message: { message_id: updateId + 100, from: { id: userId }, chat: { id: userId, type: "private" },
        text, reply_to_message: { message_id: messageId, from: { id: 100 } } },
});

test("opt-in inventory forwards only questions, never transcripts or tool arguments", async () => {
    const f = await fixture();
    f.app.rows.push({ ...row(), id: "excluded", name: "Private" });
    f.app.rows[0].transcript = "MUST NOT FORWARD";
    f.app.rows[0].tool_arguments = "MUST NOT FORWARD";
    await f.bridge.sync();
    await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /Which option/);
    assert.doesNotMatch(f.sent[0].text, /MUST NOT FORWARD|Private/);
    assert.equal(f.sent[0].reply_markup.inline_keyboard.length, 2);
});

test("unauthorized, group, bot and forwarded replies cannot control sessions", async () => {
    const f = await fixture();
    await f.bridge.sync();
    const foreign = reply(1, "First", 1, 99);
    const group = reply(2, "First"); group.message.chat.type = "group";
    const bot = reply(3, "First"); bot.message.from.is_bot = true;
    const forward = reply(4, "First"); forward.message.forward_origin = {};
    for (const update of [foreign, group, bot, forward]) await f.bridge.receive(update);
    assert.equal(f.answers.length, 0);
});

test("choice callback binds original chat, message, session and request exactly once", async () => {
    const f = await fixture();
    await f.bridge.sync();
    const data = f.sent[0].reply_markup.inline_keyboard[1][0].callback_data;
    const update = { update_id: 4, callback_query: { id: "click", from: { id: 42 },
        message: { message_id: 1, chat: { id: 42, type: "private" } }, data } };
    await f.bridge.receive(update);
    await f.bridge.receive(update);
    await f.bridge.receive({ ...update, update_id: 5 });
    assert.deepEqual(f.answers, [["session-a", "request-1", "Second"]]);
    assert.ok(f.snapshots.some(s => Object.values(s.requests).some(r => r.state === "attempting")));
});

test("text replies support freeform while unaddressed text waits for a destination", async () => {
    const f = await fixture();
    f.bridge.state.bot = { id: 100 };
    f.bridge.state.sessions["session-a"].idleSelectionId = "selected-1";
    await f.bridge.sync();
    const unaddressed = reply(1, "First"); delete unaddressed.message.reply_to_message;
    await f.bridge.receive(unaddressed);
    assert.equal(f.answers.length, 0);
    assert.equal(f.messages.length, 0);
    assert.equal(f.bridge.state.inbound[1].destinationChoice.state, "pending");
    await f.bridge.receive(reply(2, "Use a third option."));
    assert.deepEqual(f.answers, [["session-a", "request-1", "Use a third option."]]);
});

test("free-text questions explain exact Reply without uneditable markup", async () => {
    for (const input of [pending(), nativePending()]) {
        const f = await fixture();
        f.app.rows = [row({ ...input, choices: [] })];
        await f.bridge.sync();
        assert.equal(f.sent[0].reply_markup, undefined);
        assert.match(f.sent[0].text, /Reply to this message with your answer/);
        assert.match(f.sent[0].text, /select this message and choose Reply/);
        assert.match(f.sent[0].text, /regular message does not answer this question/);
        assert.doesNotMatch(f.sent[0].text, /Tap a choice/);
        await f.bridge.receive(reply(1, "An exact free-text answer."));
        assert.deepEqual(f.answers, [["session-a", "request-1", "An exact free-text answer."]]);
        assert.equal(f.messages.length, 0);
    }
});

test("choice questions keep inline buttons without opening a free-text composer", async () => {
    for (const allow_freeform of [true, false]) {
        const f = await fixture();
        f.app.rows = [row({ ...nativePending(), allow_freeform })];
        await f.bridge.sync();
        assert.equal(f.sent[0].reply_markup.inline_keyboard.length, 2);
        assert.equal(f.sent[0].reply_markup.force_reply, undefined);
        assert.match(f.sent[0].text, /Tap a choice/);
    }
});

test("free-text question messages remain editable for confirmed answers", async () => {
    const f = await fixture();
    f.app.rows = [row({ ...nativePending(), choices: [] })];
    f.bridge.telegram.edit = async (chat, messageId) => {
        const markup = f.sent[messageId - 1].reply_markup;
        if (markup && !markup.inline_keyboard) {
            throw new Error("Telegram cannot edit messages with non-inline reply markup.");
        }
        return { message_id: messageId, chat: { id: chat } };
    };
    await f.bridge.sync();
    await f.bridge.receive(reply(1, "Keep the confirmed answer visible."));
    const request = Object.values(f.disk().requests)[0];
    assert.equal(request.state, "answered");
    assert.equal(request.messageUpdate.state, "sent");
});

test("long choices stay complete in the body while short numbered buttons submit exact original answers", async () => {
    const prefix = "A deliberately long option whose full explanation cannot fit on a single phone button. ";
    const choices = [
        `${prefix.repeat(2)}Keep the current configuration.`,
        `${prefix.repeat(2)}Replace the current configuration.`,
    ];
    for (const allow_freeform of [false, true]) {
        for (const index of [0, 1]) {
            const f = await fixture();
            const edits = [];
            f.app.rows = [row({ ...nativePending(), choices, allow_freeform })];
            f.bridge.telegram.edit = async (chat, messageId, text) => {
                edits.push({ chat, messageId, text });
                return { message_id: messageId, chat: { id: chat } };
            };
            await f.bridge.sync();
            const message = f.sent[0];
            assert.ok(message.text.includes(`1. ${choices[0]}\n2. ${choices[1]}`));
            assert.ok(message.text.length <= 3700);
            assert.match(message.text, /Read the full numbered choices above/);
            assert.match(message.text, /Choose 1, Choose 2, etc\.\) matching its number/);
            const buttons = message.reply_markup.inline_keyboard.map(row => row[0]);
            assert.deepEqual(buttons.map(button => button.text), ["Choose 1", "Choose 2"]);
            const request = Object.values(f.disk().requests)[0];
            assert.deepEqual(buttons.map(button => button.callback_data),
                [`a:${request.key}:0`, `a:${request.key}:1`]);
            await f.bridge.receive({ update_id: 1, callback_query: { id: "long-choice", from: { id: 42 },
                message: { message_id: 1, chat: { id: 42, type: "private" } },
                data: buttons[index].callback_data } });
            assert.deepEqual(f.answers, [["session-a", "request-1", choices[index]]]);
            assert.equal(edits.length, 1);
            assert.deepEqual([edits[0].chat, edits[0].messageId], [42, 1]);
            assert.ok(edits[0].text.endsWith(`Answered\nAnswer: ${choices[index]}`));
        }
    }
});

test("replaced, changed and resolved questions reject stale answers", async () => {
    for (const input of [pending("request-2"), pending("request-1", "Changed?"), null]) {
        const f = await fixture();
        await f.bridge.sync();
        f.app.rows = [row(input)];
        await f.bridge.receive(reply(1, "First"));
        assert.equal(f.answers.length, 0);
        assert.match(f.sent.at(-1).text, /changed|resolved|stale/i);
    }
});

test("fixed choices and callback message identity are enforced", async () => {
    const f = await fixture();
    f.app.rows[0].awaiting_input.allow_freeform = false;
    await f.bridge.sync();
    await f.bridge.receive(reply(1, "Not an option"));
    const data = f.sent[0].reply_markup.inline_keyboard[0][0].callback_data;
    await f.bridge.receive({ update_id: 2, callback_query: { id: "wrong", from: { id: 42 },
        message: { message_id: 999, chat: { id: 42, type: "private" } }, data } });
    assert.equal(f.answers.length, 0);
});

test("uncertain app writes are retained and never automatically replayed", async () => {
    const f = await fixture();
    await f.bridge.sync();
    let attempted = 0;
    f.app.answer = async () => { attempted++; throw new Error("connection lost"); };
    await f.bridge.receive(reply(1, "First"));
    await f.bridge.receive(reply(2, "First"));
    assert.equal(attempted, 1);
    assert.equal(Object.values(f.disk().requests)[0].state, "uncertain");
    assert.match(f.sent.at(-1).text, /already|uncertain|attempt/i);
});

test("opting out revokes old phone actions; plan and elicitation prompts are alert-only", async () => {
    const f = await fixture();
    await f.bridge.sync();
    await f.bridge.setOptIn("session-a", false);
    await f.bridge.receive(reply(1, "First"));
    assert.equal(f.answers.length, 0);
    await f.bridge.setOptIn("session-a", true);
    f.app.rows = [{ ...row({ kind: "elicitation", request_id: "form", question: "Sensitive form" }),
        awaiting_plan_approval: true }];
    await f.bridge.sync();
    assert.doesNotMatch(f.sent.at(-1).text, /Sensitive form/);
    assert.equal(f.sent.at(-1).reply_markup, undefined);
});

test("pairing requires an expiring challenge, private sender and local confirmation", async () => {
    const f = await fixture();
    f.bridge.state.peer = null;
    f.bridge.state.sessions = {};
    const challenge = await f.bridge.beginPairing();
    await f.bridge.receive(reply(1, "/start wrong"));
    assert.equal(f.bridge.pairing.candidate, null);
    const start = reply(2, `/start ${challenge.code}`); delete start.message.reply_to_message;
    await f.bridge.receive(start);
    assert.equal(f.bridge.state.peer, null);
    assert.equal(f.bridge.pairing.candidate.id, 42);
    await f.bridge.confirmPairing(42);
    assert.equal(f.bridge.state.peer.id, 42);
    assert.equal(f.bridge.pairing, null);
    const g = await fixture();
    g.bridge.state.peer = null;
    const expired = await g.bridge.beginPairing();
    g.bridge.now = () => 1_000_000;
    await g.bridge.receive(reply(1, `/start ${expired.code}`));
    assert.equal(g.bridge.pairing.candidate, null);
});

test("explicit new messages require opted-in alias and no pending input", async () => {
    const f = await fixture();
    await f.bridge.receive(reply(1, "/tell 042 Continue"));
    assert.equal(f.messages.length, 0);
    f.app.rows = [row(null)];
    await f.bridge.receive(reply(2, "/tell 042 Please report progress"));
    await f.bridge.receive(reply(2, "/tell 042 Please report progress"));
    await f.bridge.receive(reply(3, "/tell unknown Continue"));
    assert.deepEqual(f.messages, [["session-a", "Please report progress"]]);
});

test("oversized or unrecognized prompts are not truncated into answerable questions", async () => {
    const f = await fixture();
    f.app.rows = [row(pending("large", "x".repeat(5000)))];
    await f.bridge.sync();
    assert.equal(f.sent[0].reply_markup, undefined);
    assert.ok(f.sent[0].text.length < 4096);
    assert.equal(Object.values(f.bridge.state.requests).length, 0);
});

test("app adapter distinguishes returned failures from unknown envelopes without exposing content", async () => {
    const { AppAdapter } = await import("./app.mjs");
    for (const resultType of ["failure", "rejected", "denied", "timeout"]) {
        const app = new AppAdapter(async () => ({
            resultType, textResultForLlm: "private response", error: "private error",
        }));
        await assert.rejects(app.list(), error => {
            assert.match(error.message, new RegExp(`resultType=${resultType}`));
            assert.doesNotMatch(error.message, /private response|private error/);
            return true;
        });
    }
    for (const value of [
        { result: { resultType: "success", textResultForLlm: "private nested text" } },
        { textResultForLlm: "private direct text" },
        { resultType: "private unknown value", content: "private content" },
        null,
    ]) {
        const app = new AppAdapter(async () => value);
        await assert.rejects(app.list(), error => {
            assert.match(error.message, /unsupported response/);
            assert.match(error.message, /resultType=(missing|unrecognized)/);
            assert.doesNotMatch(error.message, /private|permission/);
            if (value?.result) assert.match(error.message, /fields=result\b/);
            return true;
        });
    }
});

test("app adapter rejects failed/malformed reads and preserves exact tool arguments", async () => {
    const { AppAdapter } = await import("./app.mjs");
    const calls = [];
    const app = new AppAdapter(async call => {
        calls.push(call);
        return { resultType: "success", textResultForLlm: JSON.stringify({ sessions: [row()] }) };
    });
    assert.equal((await app.list())[0].id, "session-a");
    await app.answer("session-a", "request-1", "First");
    assert.deepEqual(calls[1], { name: "answer_session_input",
        arguments: { project_session_id: "session-a", request_id: "request-1", answer: "First" } });
    for (const result of [{ resultType: "failure", textResultForLlm: "private error" },
        { resultType: "success", textResultForLlm: "not JSON" }]) {
        const broken = new AppAdapter(async () => result);
        await assert.rejects(broken.list());
    }
});

test("native app questions render choices and round-trip an exact answer through the app adapter", async () => {
    const { AppAdapter } = await import("./app.mjs");
    const f = await fixture();
    f.app.rows = [row(nativePending())];
    const calls = [];
    f.bridge.app = new AppAdapter(async call => {
        calls.push(call);
        let value;
        if (call.name === "get_sessions_status") value = { sessions: await f.app.list() };
        else if (call.name === "get_session") value = await f.app.get(call.arguments.project_session_id);
        else if (call.name === "answer_session_input") {
            const { project_session_id, request_id, answer } = call.arguments;
            await f.app.answer(project_session_id, request_id, answer);
            return { resultType: "success", textResultForLlm: "Answer accepted." };
        } else throw new Error(`Unexpected app call: ${call.name}`);
        return { resultType: "success", textResultForLlm: JSON.stringify(value) };
    });
    await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /Which option\?/);
    assert.match(f.sent[0].text, /1\. First\n2\. Second/);
    assert.equal(f.sent[0].reply_markup.inline_keyboard[1][0].text, "Choose 2");
    const data = f.sent[0].reply_markup.inline_keyboard[1][0].callback_data;
    await f.bridge.receive({ update_id: 1, callback_query: { id: "click", from: { id: 42 },
        message: { message_id: 1, chat: { id: 42, type: "private" } }, data } });
    assert.deepEqual(f.answers, [["session-a", "request-1", "Second"]]);
    assert.deepEqual(calls.at(-1), { name: "answer_session_input",
        arguments: { project_session_id: "session-a", request_id: "request-1", answer: "Second" } });
});

test("native app question text replies preserve freeform and fixed-choice rules", async () => {
    for (const allowFreeform of [true, false]) {
        const f = await fixture();
        f.app.rows = [row({ ...nativePending(), allow_freeform: allowFreeform })];
        await f.bridge.sync();
        assert.ok(f.sent[0].reply_markup);
        await f.bridge.receive(reply(1, "A custom answer"));
        if (allowFreeform) assert.deepEqual(f.answers, [["session-a", "request-1", "A custom answer"]]);
        else {
            assert.equal(f.answers.length, 0);
            await f.bridge.receive(reply(2, "First"));
            assert.deepEqual(f.answers, [["session-a", "request-1", "First"]]);
        }
    }
});

test("native app question changes and resolution reject stale Telegram answers", async () => {
    for (const input of [nativePending("replacement"), nativePending("request-1", "A changed question?"),
        { ...nativePending(), choices: ["First", "Third"] }, null]) {
        const f = await fixture();
        f.app.rows = [row(nativePending())];
        await f.bridge.sync();
        assert.ok(f.sent[0].reply_markup);
        f.app.rows = [row(input)];
        await f.bridge.receive(reply(1, "First"));
        assert.equal(f.answers.length, 0);
        assert.match(f.sent.at(-1).text, /changed|resolved|stale/i);
    }
});

test("native app plans, permissions, forms and unsupported questions stay app-only", async () => {
    const input = nativePending("request-1", "DO NOT FORWARD THIS PROMPT");
    const rows = [
        { ...row(input), awaiting_plan_approval: true },
        { ...row(input), awaiting_permission: true },
        row({ ...input, kind: "elicitation" }),
        row({ ...input, kind: "permission" }),
        row({ ...input, kind: "unknown" }),
        row({ ...input, kind: undefined }),
        row({ ...input, schema: {} }),
        row({ ...input, requestedSchema: {} }),
        row({ ...input, fields: [] }),
        row({ ...input, choices: [{ label: "First" }] }),
        row({ ...input, allow_freeform: "true" }),
        row({ ...input, prompt: undefined }),
        row({ ...input, prompt: " " }),
        row({ ...input, request_id: "" }),
        row({ ...input, prompt: input.prompt.repeat(200) }),
        row({ ...input, choices: Array.from({ length: 13 }, (_, i) => `Choice ${i}`) }),
    ];
    for (const item of rows) {
        const f = await fixture();
        f.app.rows = [item];
        await f.bridge.sync();
        assert.equal(f.sent.length, 1);
        assert.match(f.sent[0].text, /Needs input in the Copilot app/);
        assert.doesNotMatch(f.sent[0].text, /DO NOT FORWARD/);
        assert.equal(f.sent[0].reply_markup, undefined);
        assert.equal(Object.keys(f.bridge.state.requests).length, 0);
        assert.equal(f.answers.length, 0);
    }
});

test("Telegram transport uses outbound POST, cancellation and redacted API errors", async () => {
    const { Telegram } = await import("./telegram.mjs");
    const requests = [];
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";
    const t = new Telegram(token, async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ ok: true, result: { id: 100, is_bot: true, username: "test_bot" } }) };
    });
    await t.identity();
    assert.equal(requests[0].init.method, "POST");
    assert.ok(requests[0].init.signal);
    const broken = new Telegram(token, async () => { throw new Error(`token leaked ${token}`); });
    await assert.rejects(broken.identity(), error => !error.message.includes(token) && /network/i.test(error.message));
    const limited = new Telegram(token, async () => ({ ok: false, json: async () => ({
        ok: false, error_code: 429, description: token, parameters: { retry_after: 7 },
    }) }));
    await assert.rejects(limited.identity(), error => error.retryAfter === 7 && !error.message.includes(token));
    const longLimit = new Telegram(token, async () => ({ ok: false, json: async () => ({
        ok: false, error_code: 429, parameters: { retry_after: 7200 },
    }) }));
    await assert.rejects(longLimit.identity(), error => error.retryAfter === 7200);
});

test("state persistence is atomic and corrupt state never becomes empty success", async () => {
    const { Store } = await import("./storage.mjs");
    const { initialState } = await import("./bridge.mjs");
    const dir = await mkdtemp(join(tmpdir(), "telegram-state-"));
    try {
        const store = new Store(dir);
        assert.equal((await store.load()).version, 2);
        const state = initialState(); state.peer = owner;
        await store.save(state);
        assert.equal((await store.load()).peer.id, 42);
        await writeFile(join(dir, "state.json"), "broken");
        await assert.rejects(store.load(), /state/i);
    } finally { await rm(dir, { recursive: true }); }
});

test("local HTTP setup requires capability, same origin and bounded JSON bodies", async () => {
    const { startPanel } = await import("./panel.mjs");
    const service = { async status() { return { configured: false }; }, async action() { return { ok: true }; } };
    const panel = await startPanel(service);
    try {
        assert.equal((await fetch(`${panel.origin}/api/status`)).status, 401);
        const headers = { "X-Bridge-Key": panel.key };
        assert.equal((await fetch(`${panel.origin}/api/status`, { headers })).status, 200);
        assert.equal((await fetch(`${panel.origin}/api/status`, {
            headers: { ...headers, Origin: "https://attacker.example" },
        })).status, 403);
        assert.equal((await fetch(`${panel.origin}/api/action`, { method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "x", padding: "x".repeat(20_000) }),
        })).status, 413);
        assert.doesNotMatch(await (await fetch(panel.origin)).text(), new RegExp(panel.key));
    } finally { await panel.close(); }
});

test("single-owner guard rejects a second hub and releases without deleting another owner", async () => {
    const { acquireOwner } = await import("./storage.mjs");
    const key = `test-${process.pid}-${Date.now()}`;
    const first = await acquireOwner(key);
    await assert.rejects(acquireOwner(key), /already/i);
    await first();
    const second = await acquireOwner(key);
    await second();
});

test("Windows credential vault round-trips without plaintext on disk", async () => {
    const { Vault } = await import("./storage.mjs");
    const dir = await mkdtemp(join(tmpdir(), "telegram-vault-"));
    try {
        const vault = new Vault(dir);
        const secret = "synthetic-test-secret-not-a-real-token";
        await vault.save(secret);
        assert.equal(await vault.load(), secret);
        assert.doesNotMatch(await readFile(join(dir, "bot.dpapi"), "utf8"), /synthetic-test-secret/);
        await vault.clear();
        assert.equal(await vault.load(), null);
    } finally { await rm(dir, { recursive: true }); }
});

test("an explicit reply takes precedence over command-like answer text", async () => {
    const f = await fixture();
    await f.bridge.sync();
    await f.bridge.receive(reply(1, "/status"));
    assert.deepEqual(f.answers, [["session-a", "request-1", "/status"]]);
});

test("explicit re-opt-in reissues a revoked question without reviving its old button", async () => {
    const f = await fixture();
    await f.bridge.sync();
    await f.bridge.setOptIn("session-a", false);
    await f.bridge.setOptIn("session-a", true);
    await f.bridge.sync();
    assert.equal(f.sent.length, 2);
    await f.bridge.receive(reply(1, "First", 1));
    assert.equal(f.answers.length, 0);
    await f.bridge.receive(reply(2, "Second", 2));
    assert.equal(f.answers.length, 1);
});

test("service starts only explicitly and drains its poll and monitor on disconnect", async () => {
    const { Service } = await import("./service.mjs");
    const dir = await mkdtemp(join(tmpdir(), "telegram-service-"));
    let polls = 0;
    const service = new Service({ directory: dir, selfId: "hub", app: { async list() { return []; } } });
    const telegram = {
        async call() { return []; },
        async updates(offset, signal) {
            polls++;
            return new Promise(resolve => signal.addEventListener("abort", () => resolve([]), { once: true }));
        },
    };
    try {
        await service.initialize();
        assert.equal(polls, 0);
        await service.connect(telegram);
        assert.equal(service.connected, true);
        assert.equal(polls, 1);
        await service.stop();
        assert.equal(service.connected, false);
        assert.equal(service.bridge.state.enabled, false);
    } finally { await service.close(); await rm(dir, { recursive: true }); }
});

test("service status identifies unavailable selections by saved name and alias without changing them", async () => {
    const { Service } = await import("./service.mjs");
    const service = new Service({ directory: join(tmpdir(), "unused-telegram-status-fixture"), selfId: "hub", app: {} });
    service.initialized = true;
    service.configured = true;
    service.bridge.rows = [row(null)];
    service.bridge.state.sessions = {
        "session-a": { name: "Example session", alias: "live" },
        "missing-a": { name: "Saved session", alias: "lost" },
        "missing-b": { name: "", alias: "empty" },
    };
    const original = structuredClone(service.bridge.state.sessions);
    const status = await service.status();
    assert.deepEqual(status.selectedMissing, [
        { id: "missing-a", name: "Saved session", alias: "lost" },
        { id: "missing-b", name: "missing-b", alias: "empty" },
    ]);
    assert.equal(status.sessions[0].selected, true);
    assert.deepEqual(service.bridge.state.sessions, original);
    service.bridge.rows.push({ ...row(null), id: "missing-a", name: "Returned session" });
    const returned = await service.status();
    assert.deepEqual(returned.selectedMissing, [{ id: "missing-b", name: "missing-b", alias: "empty" }]);
    assert.equal(returned.sessions.find(item => item.id === "missing-a").selected, true);
    assert.deepEqual(service.bridge.state.sessions, original);
});

test("Telegram outbound messages are paced and failed sends are not replayed", async () => {
    const { Telegram } = await import("./telegram.mjs");
    const times = [];
    const telegram = new Telegram("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk", async () => {
        times.push(Date.now());
        if (times.length === 1) throw new Error("uncertain send");
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 2 } }) };
    });
    const first = telegram.send(42, "one");
    const second = telegram.send(42, "two");
    await assert.rejects(first);
    await second;
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 1000);
});
