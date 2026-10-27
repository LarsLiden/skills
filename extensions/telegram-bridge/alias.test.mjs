import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, initialState } from "./bridge.mjs";
import { Store } from "./storage.mjs";

function fixture(state = initialState()) {
    let disk = structuredClone(state);
    const sent = [], messages = [];
    const store = {
        async load() { return structuredClone(disk); },
        async save(value) { disk = structuredClone(value); },
    };
    const app = {
        async get(id) { return { id, name: `Session ${id}`, activity: { status: "idle" } }; },
        async list() { return Promise.all(Object.keys(disk.sessions).map(id => this.get(id))); },
        async tell(...args) { messages.push(args); },
    };
    const bridge = new Bridge({ store, app, selfId: "hub", telegram: {
        async send(chatId, text) { sent.push(text); return { message_id: sent.length }; },
    } });
    return { bridge, store, app, sent, messages, disk: () => structuredClone(disk) };
}

function legacyState() {
    const state = { ...initialState(), version: 1 };
    delete state.aliases;
    state.peer = { id: 42, chatId: 42, name: "Phone" };
    state.bot = { id: 100, username: "example_bot" };
    state.enabled = true;
    state.sessions = {
        "session-a": { alias: "123abc", name: "First session" },
        "missing-b": { alias: "123def", name: "Unavailable session" },
    };
    state.requests = { question: { sessionId: "session-a", messageId: 7, requestId: "request-1", state: "pending" } };
    state.commands = { 9: { sessionId: "session-a", state: "uncertain" } };
    return state;
}

test("alias migration persists unique three-digit codes and preserves pairing and question bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-alias-migration-"));
    try {
        const store = new Store(directory);
        const original = legacyState();
        await store.save(original);
        const bridge = new Bridge({ store, app: {}, selfId: "hub" });
        await bridge.load();
        const expected = {
            ...original, version: 2, aliases: { "session-a": "000", "missing-b": "001" },
            sessions: {
                "session-a": { ...original.sessions["session-a"], alias: "000" },
                "missing-b": { ...original.sessions["missing-b"], alias: "001" },
            },
        };
        assert.deepEqual(bridge.state, expected);
        assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")), expected);
        const restarted = new Bridge({ store, app: {}, selfId: "hub" });
        await restarted.load();
        assert.deepEqual(restarted.state, expected);
    } finally { await rm(directory, { recursive: true }); }
});

test("alias allocation remains stable after opt-out and restart without reusing retired codes", async () => {
    const f = fixture();
    await f.bridge.load();
    await f.bridge.setOptIn("session-a", true);
    await f.bridge.setOptIn("session-b", true);
    assert.equal(f.bridge.state.sessions["session-a"].alias, "000");
    assert.equal(f.bridge.state.sessions["session-b"].alias, "001");
    await f.bridge.setOptIn("session-a", false);
    await f.bridge.load();
    await f.bridge.setOptIn("session-c", true);
    assert.equal(f.bridge.state.sessions["session-c"].alias, "002");
    assert.equal(f.bridge.state.sessions["session-a"], undefined);
    assert.equal(f.bridge.state.aliases["session-a"], "000");
    await f.bridge.setOptIn("session-a", true);
    assert.equal(f.bridge.state.sessions["session-a"].alias, "000");
    assert.equal(new Set(Object.values(f.bridge.state.aliases)).size, 3);
});

test("alias capacity includes all 1000 codes and exhaustion cannot change selections or reuse a code", async () => {
    const state = initialState();
    for (let n = 0; n < 999; n++) state.aliases[`session-${n}`] = String(n).padStart(3, "0");
    const f = fixture(state);
    await f.bridge.load();
    await f.bridge.setOptIn("last-session", true);
    assert.equal(f.bridge.state.sessions["last-session"].alias, "999");
    const before = f.disk();
    await assert.rejects(f.bridge.setOptIn("overflow", true), /All 1,000 three-digit session codes are reserved/);
    assert.deepEqual(f.bridge.state, before);
    assert.deepEqual(f.disk(), before);
    await f.bridge.setOptIn("session-0", true);
    assert.equal(f.bridge.state.sessions["session-0"].alias, "000");
});

test("alias corruption is rejected without silently renumbering or discarding reservations", async () => {
    const invalid = [
        { ...initialState(), aliases: null },
        { ...initialState(), aliases: [] },
        { ...initialState(), aliases: { one: "000", two: "000" } },
        { ...initialState(), aliases: { one: "00" } },
        { ...initialState(), aliases: { one: 123 } },
        { ...initialState(), sessions: { one: { alias: "000", name: "No reservation" } } },
        { ...initialState(), aliases: { one: "000" }, sessions: { one: { alias: "001" } } },
    ];
    for (const state of invalid) {
        const f = fixture(state);
        await assert.rejects(f.bridge.load(), /code/);
        assert.deepEqual(f.disk(), state);
    }
    const oversized = legacyState();
    oversized.sessions = Object.fromEntries(Array.from({ length: 1001 }, (_, n) =>
        [`session-${n}`, { alias: String(n).padStart(6, "0"), name: "Legacy" }]));
    const f = fixture(oversized);
    await assert.rejects(f.bridge.load(), /All 1,000/);
    assert.deepEqual(f.disk(), oversized);
});

test("alias write failures cannot expose an unpersisted migration or session code", async () => {
    const legacy = fixture(legacyState());
    legacy.store.save = async () => { throw new Error("disk full"); };
    await assert.rejects(legacy.bridge.load(), /disk full/);
    assert.deepEqual(legacy.disk(), legacyState());
    assert.deepEqual(legacy.bridge.state, initialState());
    const fresh = fixture();
    await fresh.bridge.load();
    fresh.store.save = async () => { throw new Error("disk full"); };
    await assert.rejects(fresh.bridge.setOptIn("session-a", true), /disk full/);
    assert.deepEqual(fresh.bridge.state, initialState());
    assert.deepEqual(fresh.disk(), initialState());
});

test("alias routing and status use exact three-digit codes without accepting stale or unauthorized commands", async () => {
    const f = fixture(legacyState());
    await f.bridge.load();
    let updateId = 10;
    const receive = async (text, userId = 42) => f.bridge.receive({
        update_id: ++updateId,
        message: { message_id: updateId, text, from: { id: userId }, chat: { id: userId, type: "private" } },
    });
    await receive("/status");
    assert.match(f.sent.at(-1), /\[000\].*\n\[001\]/);
    assert.doesNotMatch(f.sent.at(-1), /123abc|123def/);
    await receive("/help");
    assert.match(f.sent.at(-1), /three-digit code/);
    for (const text of ["/tell 123abc Old code", "/tell 000111 Do not truncate", "/tell 00 Too short",
        "/tell 0 Missing zeros", "/tell 999 Unknown"]) await receive(text);
    await receive("/tell 000 Foreign", 99);
    assert.deepEqual(f.messages, []);
    await receive("/tell 000 Hello");
    await receive("/tell 001 Second");
    assert.deepEqual(f.messages, [["session-a", "Hello"], ["missing-b", "Second"]]);
    await f.bridge.setOptIn("session-a", false);
    await receive("/tell 000 Retired");
    assert.equal(f.messages.length, 2);
    assert.match(f.sent.at(-1), /unselected session code/);
});
