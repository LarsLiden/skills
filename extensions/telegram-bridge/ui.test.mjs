import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL("./panel.html", import.meta.url), "utf8");
const source = await readFile(new URL("./ui.mjs", import.meta.url), "utf8");
const saved = {
    configured: true, connected: false, started: false, enabled: false,
    bot: { username: "example_bot" }, peer: { name: "Phone", id: 42 },
    pairing: null, notifyIdle: false, error: null, lastSync: "2026-10-23T12:00:00Z",
    sessions: [{ id: "session-a", name: "Example", project: "Project", activity: "idle", selected: true }],
    selectedMissing: [], unresolved: [],
};

class Element {
    constructor() {
        this.hidden = false;
        this.disabled = false;
        this.value = "";
        this.textContent = "";
        this.children = [];
        this.handlers = {};
        this.classes = new Set();
        this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    focus() { this.focused = true; }
}

async function panel(overrides = {}) {
    const elements = new Map();
    for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const element = new Element();
        element.hidden = /\shidden(?:\s|>)/.test(match[0]);
        element.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
        elements.set(match[1], element);
    }
    let value = { ...structuredClone(saved), ...overrides }, refresh, failure;
    const requests = [];
    const get = id => {
        assert.ok(elements.has(id), `Missing panel element: ${id}`);
        return elements.get(id);
    };
    await runInNewContext(`(async () => {\n${source}\n})()`, {
        location: { hash: "#test-panel-key", pathname: "/" },
        history: { replaceState() {} },
        document: { getElementById: get, createElement: () => new Element(), createTextNode: text => text },
        fetch: async (path, options) => {
            requests.push({ path, ...options });
            if (failure) throw new Error(failure);
            assert.equal(options.method, "GET", "State rendering must never change bridge settings.");
            return { ok: true, json: async () => structuredClone(value) };
        },
        setInterval: callback => { refresh = callback; },
    });
    return {
        get, requests,
        async update(changes) { value = { ...value, ...changes }; await refresh(); },
        async fail(message) { failure = message; await refresh(); },
    };
}

test("first-time setup shows bot creation only when no credential is saved", async () => {
    const p = await panel({ configured: false, bot: null, peer: null, sessions: [] });
    assert.equal(p.get("bot-heading").textContent, "1. Set up a bot");
    assert.equal(p.get("bot-setup").hidden, false);
    assert.equal(p.get("new-bot-help").hidden, false);
    assert.equal(p.get("replace-bot-help").hidden, true);
    assert.equal(p.get("connect").hidden, true);
    assert.equal(p.get("change-bot").hidden, true);
    assert.equal(p.get("pair").disabled, true);
    assert.equal(p.get("refresh").disabled, true);
    assert.equal(p.get("idle").disabled, true);
    assert.equal(p.get("session-help").hidden, false);
    assert.match(p.get("session-help").textContent, /Connect your bot/);
    assert.match(p.get("sessions").textContent, /after connecting/);
    assert.match(p.get("notice").textContent, /one-time setup/);
});

test("saved disconnected bot offers reconnect and preserves the paired-phone display", async () => {
    const p = await panel();
    assert.equal(p.get("bot-heading").textContent, "1. Reconnect your saved bot");
    assert.equal(p.get("bot-setup").hidden, true);
    assert.equal(p.get("new-bot-help").hidden, true);
    assert.equal(p.get("connect").hidden, false);
    assert.equal(p.get("connect").disabled, false);
    assert.equal(p.get("stop").hidden, true);
    assert.equal(p.get("phone-heading").textContent, "2. Phone paired");
    assert.equal(p.get("pair").hidden, true);
    assert.match(p.get("connection-help").textContent, /no new bot or token/);
    assert.match(p.get("notice").textContent, /No phone commands or alerts are active/);
    assert.match(p.get("health").textContent, /scanning is stopped/);
    await p.update({ bot: null });
    assert.match(p.get("bot-status").textContent, /A bot token is saved/);
    assert.equal(p.get("bot-setup").hidden, true);
});

test("connected state distinguishes phone pairing, monitoring, no selections and paused commands", async () => {
    const p = await panel({ connected: true, started: true, peer: null });
    assert.equal(p.get("bot-heading").textContent, "1. Bot connected");
    assert.equal(p.get("connect").hidden, true);
    assert.equal(p.get("stop").hidden, false);
    assert.equal(p.get("pair").hidden, false);
    assert.equal(p.get("pair").disabled, false);
    assert.match(p.get("notice").textContent, /Pair your phone/);
    await p.update({ peer: saved.peer, enabled: true });
    assert.equal(p.get("pair").hidden, true);
    assert.match(p.get("notice").textContent, /Monitoring 1 selected session/);
    assert.match(p.get("health").textContent, /scanning interval: 15 seconds/);
    await p.update({ sessions: [] });
    assert.match(p.get("notice").textContent, /No available sessions are selected/);
    await p.update({ enabled: false });
    assert.match(p.get("notice").textContent, /commands and monitoring are paused/);
    assert.doesNotMatch(p.get("notice").textContent, /Monitoring \d/);
});

test("connection failures remain visible and require stopping the old connection before reconnecting", async () => {
    const p = await panel({ started: true, error: "Telegram polling failed (409)." });
    assert.equal(p.get("notice").textContent, "Telegram polling failed (409).");
    assert.equal(p.get("notice").classes.has("error"), true);
    assert.equal(p.get("bot-heading").textContent, "1. Connection stopped");
    assert.equal(p.get("connect").disabled, true);
    assert.equal(p.get("stop").hidden, false);
    assert.equal(p.get("stop").disabled, false);
    assert.equal(p.get("refresh").disabled, true);
    assert.equal(p.get("idle").disabled, true);
    assert.equal(p.get("sessions").children[0].children[0].disabled, true);
    assert.match(p.get("connection-help").textContent, /Disconnect the stopped connection/);
    await p.update({ started: false, error: null });
    assert.equal(p.get("notice").classes.has("error"), false);
    assert.equal(p.get("connect").disabled, false);
    await p.fail("Local bridge unavailable.");
    assert.equal(p.get("notice").textContent, "Local bridge unavailable.");
    assert.equal(p.get("notice").classes.has("error"), true);
});

test("replacement is explicit, survives refresh and can be canceled without changing the saved bot", async () => {
    const p = await panel();
    p.get("change-bot").handlers.click();
    assert.equal(p.get("bot-setup").hidden, false);
    assert.equal(p.get("new-bot-help").hidden, true);
    assert.equal(p.get("replace-bot-help").hidden, false);
    assert.equal(p.get("configure").textContent, "Replace bot and connect");
    assert.equal(p.get("connect").hidden, true);
    assert.equal(p.get("token").focused, true);
    p.get("token").value = "unsaved-test-value";
    await p.update({});
    assert.equal(p.get("bot-setup").hidden, false);
    assert.equal(p.get("token").value, "unsaved-test-value");
    p.get("cancel-bot").handlers.click();
    assert.equal(p.get("bot-setup").hidden, true);
    assert.equal(p.get("token").value, "");
    assert.equal(p.get("connect").hidden, false);
    assert.equal(p.get("change-bot").focused, true);
    assert.ok(p.requests.every(request => request.method === "GET"));
});

test("configuration transitions remove stale setup drafts and restore the correct controls", async () => {
    const p = await panel({ configured: false, bot: null, peer: null });
    p.get("token").value = "unsaved-test-value";
    await p.update({ configured: true, bot: saved.bot, connected: true, started: true });
    assert.equal(p.get("bot-setup").hidden, true);
    assert.equal(p.get("token").value, "");
    p.get("change-bot").handlers.click();
    p.get("token").value = "unsaved-replacement";
    await p.update({ configured: false, bot: null, connected: false, started: false });
    assert.equal(p.get("bot-setup").hidden, false);
    assert.equal(p.get("new-bot-help").hidden, false);
    assert.equal(p.get("replace-bot-help").hidden, true);
    assert.equal(p.get("token").value, "");
    assert.equal(p.get("cancel-bot").hidden, true);
    assert.equal(p.get("configure").textContent, "Save token and connect");
});

test("session controls track connection state without changing saved selections", async () => {
    assert.match(html, /id="refresh"[^>]*\sdisabled/);
    assert.match(html, /id="idle"[^>]*\sdisabled/);
    const p = await panel({ notifyIdle: true });
    const assertControls = disabled => {
        assert.equal(p.get("refresh").disabled, disabled);
        assert.equal(p.get("idle").disabled, disabled);
        assert.equal(p.get("idle").checked, true);
        assert.equal(p.get("session-help").hidden, !disabled);
        const checkbox = p.get("sessions").children[0].children[0];
        assert.equal(checkbox.disabled, disabled);
        assert.equal(checkbox.checked, true);
    };
    assertControls(true);
    assert.match(p.get("session-help").textContent, /saved selections are retained/);
    await p.update({ connected: true, started: true, enabled: true });
    assertControls(false);
    await p.update({ connected: false, started: false, enabled: false });
    assertControls(true);
    await p.update({ sessions: [] });
    assert.match(p.get("sessions").textContent, /after connecting/);
    assert.doesNotMatch(p.get("sessions").textContent, /Refresh/);
    await p.update({ connected: true, started: true, enabled: true });
    assert.equal(p.get("refresh").disabled, false);
    assert.match(p.get("sessions").textContent, /Refresh/);
    assert.ok(p.requests.every(request => request.method === "GET"));
});

test("unavailable selections show saved names, aliases and a red text marker beside available sessions", async () => {
    const missing = [
        { id: "missing-a", name: "Older session", alias: "old" },
        { id: "missing-b", name: "<img src=x>", alias: "other" },
    ];
    const p = await panel({ connected: true, started: true, enabled: true, selectedMissing: missing });
    const rows = p.get("sessions").children;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].children[1].children.length, 1);
    for (let i = 0; i < missing.length; i++) {
        const [checkbox, text] = rows[i + 1].children;
        assert.equal(checkbox.checked, true);
        assert.equal(checkbox.disabled, false);
        assert.equal(text.textContent, missing[i].name);
        assert.equal(text.children[0].className, "unavailable-marker");
        assert.equal(text.children[0].textContent, " * Unavailable");
        assert.match(text.children[1].textContent, /Not currently visible in Copilot/);
        assert.ok(text.children[1].textContent.includes(`alias ${missing[i].alias}`));
    }
    assert.match(p.get("missing").textContent, /^2 selected session/);
    assert.match(p.get("missing").textContent, /marked \* Unavailable above/);
    const css = await readFile(new URL("./style.css", import.meta.url), "utf8");
    assert.match(css, /\.unavailable-marker\s*\{[^}]*color:\s*var\(--true-color-red,/);
    await p.update({ connected: false, started: false, enabled: false });
    for (const row of p.get("sessions").children) {
        assert.equal(row.children[0].disabled, true);
        assert.equal(row.children[0].checked, true);
    }
    assert.ok(p.requests.every(request => request.method === "GET"));
});

test("unavailable-only selections stay visible and lose their marker when the session returns", async () => {
    const missing = { id: "missing-a", name: "Saved session", alias: "old" };
    const p = await panel({ sessions: [], selectedMissing: [missing] });
    assert.equal(p.get("sessions").children.length, 1);
    assert.equal(p.get("sessions").children[0].children[1].textContent, missing.name);
    assert.doesNotMatch(p.get("sessions").textContent, /Refresh|after connecting/);
    await p.update({
        sessions: [{ ...missing, project: "Project", activity: "idle", selected: true }],
        selectedMissing: [],
    });
    const rows = p.get("sessions").children;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].children[0].checked, true);
    assert.equal(rows[0].children[1].children.length, 1);
    assert.equal(rows[0].children[1].children[0].className, undefined);
    assert.equal(p.get("missing").textContent, "");
});

test("topic setup stays explicit, explains BotFather, and shows persisted topic problems", async () => {
    const p = await panel();
    assert.equal(p.get("enable-topics").disabled, true);
    assert.match(html, /id="topics-help">In BotFather/);
    assert.match(html, /Deselecting a session permanently deletes its Telegram topic and all messages/);
    assert.match(html, /Idle or temporarily unavailable sessions are kept/);
    assert.match(html, /Inside a session topic, just type your message/);
    assert.match(html, /No <code>\/tell<\/code> prefix is required/);
    assert.match(html, /After a phone message or question answer, the first public reply is sent as soon as captured/);
    assert.match(html, /final result still follows at idle/);
    assert.match(html, /Reload the extension in this hub and monitored sessions/);
    await p.update({ connected: true, started: true, enabled: true,
        topics: { enabled: false, ready: 0, issues: [] } });
    assert.equal(p.get("enable-topics").disabled, false);
    assert.equal(p.get("enable-topics").textContent, "Enable session topics");
    await p.update({ topics: { enabled: true, ready: 2, issues: [] } });
    assert.equal(p.get("enable-topics").textContent, "Sync session topics");
    assert.match(p.get("topics-status").textContent, /2 session topic/);
    await p.update({ topics: { enabled: true, ready: 1, issues: ["000 - First: creation outcome uncertain."] } });
    assert.match(p.get("topics-status").textContent, /000 - First: creation outcome uncertain/);
    await p.update({ connected: false });
    assert.equal(p.get("enable-topics").disabled, true);
    assert.ok(p.requests.every(request => request.method === "GET"));
});
