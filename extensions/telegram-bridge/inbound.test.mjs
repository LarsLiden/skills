import test from "node:test";
import assert from "node:assert/strict";
import { Bridge, initialState } from "./bridge.mjs";
import { Service } from "./service.mjs";
import { Telegram } from "./telegram.mjs";

const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";
const input = (id = 1, text = "/tell 042 Harmless test") => ({
    update_id: id,
    message: { message_id: 100 + id, date: 1793153880, text,
        from: { id: 42 }, chat: { id: 42, type: "private" } },
});
async function fixture() {
    let disk = initialState();
    Object.assign(disk, { enabled: true, peer: { id: 42, chatId: 42 }, bot: { id: 100 } });
    disk.sessions["session-a"] = { alias: "042", name: "Test" };
    disk.aliases["session-a"] = "042";
    const calls = [], sent = [], snapshots = [];
    const app = {
        async get(id) { return { id, activity: { status: "busy" } }; },
        async list() { return []; },
        async tell(...args) { calls.push(["tell", ...args]); },
        async answer(...args) { calls.push(["answer", ...args]); },
    };
    const telegram = {
        async send(chat, text, extra) { sent.push(text); return { message_id: sent.length, chat: { id: chat }, ...extra }; },
        async callback() {},
    };
    const store = {
        async load() { return structuredClone(disk); },
        async save(value) { disk = structuredClone(value); snapshots.push(structuredClone(value)); },
    };
    const bridge = new Bridge({ app, telegram, store, selfId: "hub" });
    await bridge.load();
    return { bridge, app, telegram, store, calls, sent, snapshots, disk: () => disk };
}
function serviceFor(f) {
    const service = new Service({ app: f.app, directory: "unused-inbound-test", selfId: "hub" });
    service.bridge = f.bridge;
    service.initialized = true;
    service.configured = true;
    service.connected = true;
    return service;
}

test("inbound receipt is durable before app preflight and excludes message text", async () => {
    const f = await fixture();
    f.app.get = async id => {
        const receipt = f.disk().inbound[1];
        assert.equal(receipt.state, "received");
        assert.equal(receipt.sessionId, id);
        assert.equal(receipt.stage, "preflight");
        assert.equal(receipt.messageId, 101);
        assert.match(receipt.contentHash, /^[0-9a-f]{64}$/);
        assert.doesNotMatch(JSON.stringify(receipt), /Harmless test/);
        return { id };
    };
    await f.bridge.receive(input());
    assert.equal(f.calls.length, 1);
    assert.equal(f.disk().inbound[1].state, "accepted");
    assert.equal(f.disk().inbound[1].sessionId, "session-a");
});

test("preflight failure records not-sent, explains it on the phone and does not replay", async () => {
    const f = await fixture();
    f.app.get = async () => { throw new Error("App read unavailable"); };
    await assert.rejects(f.bridge.receive(input()), /App read unavailable/);
    assert.equal(f.disk().inbound[1].state, "not-sent");
    assert.ok(f.disk().inbound[1].failure);
    assert.match(f.sent.at(-1), /Nothing was sent to Copilot/);
    await f.bridge.load();
    await f.bridge.receive(input());
    assert.equal(f.calls.length, 0);
});

test("failed initial checkpoint cannot advance memory or acknowledge later updates", async () => {
    const f = await fixture();
    f.store.save = async () => { throw new Error("Receipt storage unavailable"); };
    await assert.rejects(f.bridge.receive(input()), /Receipt storage unavailable/);
    assert.equal(f.bridge.state.lastUpdate, null);
    assert.equal(f.disk().lastUpdate, null);
    await assert.rejects(f.bridge.receive(input(2)), /paused|storage/i);
    assert.equal(f.calls.length, 0);
});

test("poll stops after persistence failure without fetching an acknowledging offset", async () => {
    const f = await fixture(), service = serviceFor(f), controller = new AbortController();
    service.controller = controller;
    const offsets = [];
    f.telegram.updates = async offset => {
        offsets.push(offset);
        if (offsets.length > 1) controller.abort();
        return [input(), input(2)];
    };
    // Avoid a real retry delay even on the pre-fix implementation.
    f.store.save = async () => { throw Object.assign(new Error("Receipt storage unavailable"), { retryAfter: 0 }); };
    await service.poll(controller.signal);
    assert.deepEqual(offsets, [null]);
    assert.equal(service.connected, false);
    assert.equal(f.calls.length, 0);
});

test("uncertain app dispatch stays distinct from a failed Telegram acknowledgment", async () => {
    for (const uncertain of [false, true]) {
        const f = await fixture();
        f.app.tell = async () => { f.calls.push("tell"); if (uncertain) throw new Error("App reply lost"); };
        f.telegram.send = async () => { throw new Error("Telegram response lost"); };
        await assert.rejects(f.bridge.receive(input()), /Telegram response lost/);
        assert.equal(f.disk().inbound[1].state, uncertain ? "uncertain" : "accepted");
        assert.ok(f.disk().inbound[1].failure);
        await f.bridge.receive(input());
        assert.equal(f.calls.length, 1);
    }
});

test("callback acknowledgment failure cannot prevent a valid exact answer", async () => {
    const f = await fixture();
    const question = { kind: "question", prompt: "Pick one", request_id: "q1", choices: ["First", "Second"] };
    f.app.get = async id => ({ id, awaiting_user_input: true, awaiting_input: question });
    f.app.list = async () => [await f.app.get("session-a")];
    f.telegram.edit = async (chat, id) => ({ message_id: id, chat: { id: chat } });
    await f.bridge.sync();
    const request = Object.values(f.bridge.state.requests)[0];
    f.telegram.callback = async () => { throw new Error("Callback acknowledgment failed"); };
    const update = { update_id: 2, callback_query: { id: "callback-1", from: { id: 42 },
        message: { message_id: request.messageId, chat: { id: 42, type: "private" } },
        data: `a:${request.key}:0` } };
    await assert.rejects(f.bridge.receive(update), /Callback acknowledgment failed/);
    assert.deepEqual(f.calls, [["answer", "session-a", "q1", "First"]]);
    assert.equal(f.disk().inbound[2].state, "accepted");
    assert.ok(f.disk().inbound[2].failure);
    await f.bridge.receive(update);
    assert.equal(f.calls.length, 1);
});

test("unaddressed input has an explicit non-dispatch receipt and unauthorized data is not retained", async () => {
    const f = await fixture();
    await f.bridge.receive(input(1, "No destination"));
    assert.equal(f.disk().inbound[1].state, "not-sent");
    assert.match(f.disk().inbound[1].reason, /\/tell|Reply/);
    const foreign = input(2, "PRIVATE FOREIGN TEXT");
    foreign.message.from.id = 77; foreign.message.chat.id = 77;
    await f.bridge.receive(foreign);
    assert.equal(f.disk().inbound[2], undefined);
    assert.doesNotMatch(JSON.stringify(f.disk()), /PRIVATE FOREIGN TEXT/);
});

test("interrupted receipt is fenced on load and cannot be replayed", async () => {
    const f = await fixture();
    f.bridge.state.lastUpdate = 2;
    f.bridge.state.inbound = {
        1: { updateId: 1, state: "received", sessionId: "session-a" },
        2: { updateId: 2, state: "attempting", sessionId: "session-a" },
    };
    await f.bridge.save();
    await f.bridge.load();
    assert.equal(f.bridge.state.inbound[1].state, "interrupted");
    assert.equal(f.bridge.state.inbound[2].state, "uncertain");
    await f.bridge.receive(input(2));
    assert.equal(f.calls.length, 0);
    const status = await serviceFor(f).status();
    assert.ok(status.unresolved.some(item => item.state === "inbound-interrupted"));
});

test("completed inbound history is bounded while failures remain visible", async () => {
    const f = await fixture();
    f.bridge.state.inbound = { 0: { updateId: 0, state: "not-sent", failure: { stage: "preflight" } } };
    for (let id = 1; id <= 205; id++) await f.bridge.receive(input(id, "/help"));
    assert.ok(f.disk().inbound[0].failure);
    assert.equal(Object.keys(f.disk().inbound).length, 201);
    assert.equal(f.disk().inbound[205].state, "handled");
    const status = await serviceFor(f).status();
    assert.equal(status.inbound.recent[0].updateId, 205);
    assert.equal(status.inbound.recent.length, 20);
});

test("Telegram network failures expose safe method, stage, time and cause without URLs or payloads", async () => {
    const telegram = new Telegram(token, async () => {
        throw new TypeError(`private URL /bot${token}/getUpdates`, {
            cause: Object.assign(new Error("private details"), { code: "ECONNRESET" }),
        });
    });
    await assert.rejects(telegram.updates(123), error => {
        assert.match(error.message, /getUpdates.*ECONNRESET/);
        assert.match(error.message, /poll|receiv/i);
        assert.equal(error.diagnostic.stage, "network");
        assert.ok(Number.isFinite(Date.parse(error.diagnostic.at)));
        assert.doesNotMatch(JSON.stringify(error) + error.message, /private|ABCDEFGHIJKLMNOPQRSTUVWXYZ|https:/);
        return true;
    });
});

test("invalid Telegram JSON is distinguished from send failure and never retried", async () => {
    let calls = 0;
    const telegram = new Telegram(token, async () => {
        calls++;
        return { ok: true, status: 502, json: async () => { throw new Error(token); } };
    });
    await assert.rejects(telegram.call("sendMessage", { text: "private payload" }), error => {
        assert.equal(error.diagnostic.stage, "response-json");
        assert.equal(error.diagnostic.httpStatus, 502);
        assert.match(error.message, /sendMessage.*uncertain/);
        assert.doesNotMatch(error.message, /private payload|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
        return true;
    });
    assert.equal(calls, 1);
});

test("app scan success never clears polling failure; poll recovery retains last failure evidence", async () => {
    const f = await fixture(), service = serviceFor(f), notices = [];
    service.notify = text => notices.push(text);
    service.report(new Error("Polling unavailable"), "poll");
    service.report(new Error("Polling unavailable"), "poll");
    await service.refresh();
    let status = await service.status();
    assert.match(status.error, /Polling unavailable/);
    assert.equal(status.health.poll.consecutiveFailures, 2);
    assert.equal(status.health.poll.lastSuccess, null);
    service.succeeded("poll");
    status = await service.status();
    assert.equal(status.error, null);
    assert.equal(status.health.poll.lastError, "Polling unavailable");
    assert.ok(status.health.poll.lastFailure);
    assert.ok(status.health.poll.recoveredAt);
    service.report(new Error("Polling unavailable"), "poll");
    assert.equal(notices.length, 2, "A new failure after recovery must be reported again.");
});

test("poll success is recorded independently before processing the received batch", async () => {
    const f = await fixture(), service = serviceFor(f), controller = new AbortController();
    service.controller = controller;
    f.telegram.updates = async () => [input()];
    f.app.tell = async () => { controller.abort(); f.calls.push("tell"); };
    await service.poll(controller.signal);
    const status = await service.status();
    assert.ok(status.health.poll.lastSuccess);
    assert.equal(status.health.poll.lastBatchSize, 1);
    assert.equal(status.lastSync, null);
    assert.equal(status.inbound.recent[0].state, "accepted");
});

test("accepted state survives acknowledgment failure and restart with unresolved evidence", async () => {
    const f = await fixture();
    f.telegram.send = async () => { throw new Error("Confirmation failed"); };
    await assert.rejects(f.bridge.receive(input()), /Confirmation failed/);
    await f.bridge.load();
    assert.equal(f.bridge.state.inbound[1].state, "accepted");
    assert.equal(f.bridge.state.commands[1].state, "sent");
    const status = await serviceFor(f).status();
    assert.ok(status.unresolved.some(item => item.state === "inbound-accepted"));
    assert.equal(f.calls.length, 1);
});

test("app-attempt checkpoint failure prevents dispatch and leaves an interrupted receipt on disk", async () => {
    const f = await fixture(), save = f.store.save;
    f.store.save = async value => {
        if (value.inbound[1]?.state === "attempting") throw new Error("Attempt checkpoint failed");
        await save(value);
    };
    await assert.rejects(f.bridge.receive(input()), /Attempt checkpoint failed/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.disk().inbound[1].state, "received");
    assert.equal(f.bridge.persistenceFailed, true);
});

test("a malformed saved inbound receipt fails closed rather than forgetting history", async () => {
    const f = await fixture();
    f.bridge.state.inbound = { 1: { updateId: 2, state: "received" } };
    await f.bridge.save();
    await assert.rejects(f.bridge.load(), /inbound receipts are invalid/);
    assert.equal(f.calls.length, 0);
});

test("unknown transport causes and abort reasons never expose raw messages or tokens", async () => {
    for (const canceled of [false, true]) {
        const controller = new AbortController();
        if (canceled) controller.abort(token);
        const telegram = new Telegram(token, async () => {
            throw Object.assign(new Error(token), { code: token, cause: { code: token } });
        });

        await assert.rejects(telegram.updates(null, controller.signal), error => {
            assert.equal(error.diagnostic.code, canceled ? "canceled" : "unknown");
            assert.doesNotMatch(error.message + JSON.stringify(error), /ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
            return true;
        });
    }
});

test("a later queued update cannot overtake a failed receipt checkpoint", async () => {
    const f = await fixture(), service = serviceFor(f), offsets = [];
    const controller = new AbortController(); service.controller = controller;
    f.telegram.updates = async offset => {
        offsets.push(offset);
        return [input(), input(2)];
    };
    const save = f.store.save;
    f.store.save = async value => {
        if (value.inbound[1]?.state === "accepted") throw new Error("Result checkpoint failed");
        await save(value);
    };
    await service.poll(controller.signal);
    assert.deepEqual(offsets, [null]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.disk().inbound[1].state, "attempting");
    assert.equal(f.disk().inbound[2], undefined);
});

test("monitor storage failure immediately pauses traffic and stop does not retry that save", async () => {
    const f = await fixture(), service = serviceFor(f), controller = new AbortController();
    service.controller = controller;
    let saves = 0;
    f.store.save = async () => { saves++; throw new Error("Monitor storage failed"); };
    f.bridge.sync = () => f.bridge.save();
    await assert.rejects(service.serial(() => service.refresh(), "monitor"), /Monitor storage failed/);
    assert.equal(controller.signal.aborted, true);
    assert.equal(service.connected, false);
    await service.stop();
    assert.equal(saves, 1);
    assert.equal(f.bridge.state.enabled, false);
});

test("a failed rejection notice is not mistaken for failed preflight or sent a second time", async () => {
    const f = await fixture();
    f.app.get = async id => ({ id, awaiting_user_input: true });
    let sends = 0;
    f.telegram.send = async () => { sends++; throw new Error("Rejection delivery uncertain"); };
    await assert.rejects(f.bridge.receive(input()), /Rejection delivery uncertain/);
    assert.equal(sends, 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.disk().inbound[1].state, "not-sent");
    assert.equal(f.disk().inbound[1].failure.stage, "phone-response");
});
