import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, initialState } from "./bridge.mjs";
import { IdleListener, IdleReplyStore } from "./idle.mjs";

async function fixture() {
    let disk = initialState(), now = 100_000, sequence = 0;
    disk.enabled = true;
    disk.peer = { id: 42, chatId: 42, name: "Phone" };
    disk.bot = { id: 1000 };
    disk.idleEpoch = "connection-1";
    disk.aliases["session-a"] = "042";
    disk.sessions["session-a"] = { alias: "042", name: "Example session", idleSelectionId: "selection-1" };
    const sent = [], errors = [], cache = new Map();
    const store = {
        async load() { return structuredClone(disk); },
        async save(value) { disk = structuredClone(value); },
    };
    const replies = {
        async write(value) { cache.set(value.sessionId, structuredClone(value)); },
        async read(id, epoch, selectionId) {
            const value = cache.get(id);
            return value?.epoch === epoch && value.selectionId === selectionId ? structuredClone(value) : null;
        },
        async remove(id) { cache.delete(id); },
        async clear(ids) { for (const id of ids) cache.delete(id); },
    };
    const rows = [{ id: "session-a", name: "Example session", activity: { status: "busy" } }];
    const telegram = { async send(chat, text) { sent.push(text); return { message_id: sent.length, chat: { id: chat } }; } };
    const bridge = new Bridge({ app: { async list() { return structuredClone(rows); } },
        telegram, store, selfId: "hub", idleReplies: replies, now: () => now });
    await bridge.load();
    const listener = new IdleListener({ sessionId: "session-a", stateStore: store, replies,
        notify: message => { errors.push(message); } });
    const event = (type, data = {}, extra = {}) => ({
        type, data, id: `event-${++sequence}`, timestamp: new Date(now).toISOString(), ...extra,
    });
    return {
        bridge, listener, replies, rows, sent, errors, cache, telegram, event, store,
        tick(ms = 1000) { now += ms; },
        async start() { await listener.handle(event("assistant.turn_start")); },
        async message(content, extra = {}, envelope = {}) {
            await listener.handle(event("assistant.message", { content, messageId: `message-${sequence}`, ...extra }, envelope));
        },
        async idle(aborted = false) {
            now += 1000;
            await listener.handle(event("session.idle", { aborted }));
            rows[0].activity.status = "idle";
        },
    };
}

test("idle listener captures only the latest public root reply, not reasoning or tool data", async () => {
    const f = await fixture();
    await f.start();
    await f.listener.handle(f.event("user.message", { content: "PRIVATE USER INPUT" }));
    await f.message("TOOL COMMENTARY", { toolRequests: [{ arguments: "PRIVATE TOOL ARGUMENTS" }] });
    await f.message("THINKING", { phase: "analysis", reasoningText: "PRIVATE REASONING" });
    await f.message("Earlier final");
    await f.message("Latest final", { phase: "final", reasoningText: "PRIVATE REASONING" });
    await f.message("SUBAGENT", {}, { agentId: "child" });
    await f.message("LEGACY SUBAGENT", { parentToolCallId: "parent" });
    await f.idle();
    const record = f.cache.get("session-a");
    assert.equal(record.content, "Latest final");
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE|TOOL|THINKING|SUBAGENT|Earlier/);
    assert.deepEqual(f.errors, []);
    await f.listener.handle(f.event("session.idle"));
    assert.equal(f.cache.get("session-a").eventId, record.eventId);
});

test("idle listener accepts the actual final_answer phase and forwards its text", async () => {
    const f = await fixture();
    await f.bridge.sync();
    await f.start();
    await f.message("The requested change is ready.", { phase: "final_answer" });
    await f.idle();
    await f.bridge.sync();
    assert.equal(f.cache.get("session-a").content, "The requested change is ready.");
    assert.equal(f.sent[0], "[042] Example session\n* IDLE *\n\nThe requested change is ready.");
});

test("idle listener forwards the agent task-completion summary once without inferring success", async () => {
    for (const success of [true, false]) {
        const f = await fixture();
        await f.bridge.sync(); await f.start();
        await f.message("", { toolRequests: [{ name: "task_complete", arguments: "PRIVATE TOOL ARGUMENTS" }] });
        const completed = f.event("session.task_complete", { summary: "The requested work is waiting for review.", success });
        await f.listener.handle(completed);
        await f.idle(); await f.bridge.sync(); await f.bridge.sync();
        assert.equal(f.sent.length, 1);
        assert.match(f.sent[0], /The requested work is waiting for review\.$/);
        const record = f.cache.get("session-a");
        assert.equal(record.completionEventId, completed.id);
        assert.equal(record.messageId, null);
        assert.doesNotMatch(JSON.stringify(record), /PRIVATE|arguments/);
        assert.deepEqual(f.errors, []);
    }
});

test("idle listener keeps the latest public reply across internal model and tool iterations", async () => {
    const f = await fixture();
    await f.start(); await f.message("The result is ready.", { phase: "final_answer" });
    await f.start();
    await f.message("PRIVATE TOOL COMMENTARY", { toolRequests: [{ name: "bookkeeping", arguments: "SECRET" }] });
    await f.message("PRIVATE REASONING", { phase: "analysis" });
    await f.start(); await f.message("", { phase: "final_answer" });
    await f.idle();
    assert.equal(f.cache.get("session-a").content, "The result is ready.");
    assert.doesNotMatch(JSON.stringify(f.cache.get("session-a")), /PRIVATE|SECRET/);
});

test("idle completion capture preserves opt-in, user, idle, subagent and cancellation boundaries", async () => {
    for (const scenario of ["disabled", "selection", "connection", "user", "idle", "subagent", "cancel"]) {
        const f = await fixture(); await f.start();
        if (scenario === "disabled") { f.bridge.state.enabled = false; await f.bridge.save(); }
        await f.listener.handle(f.event("session.task_complete", { summary: "DO NOT REUSE" },
            scenario === "subagent" ? { agentId: "child" } : {}));
        if (scenario === "selection") { f.bridge.state.sessions["session-a"].idleSelectionId = "new"; await f.bridge.save(); }
        if (scenario === "connection") { f.bridge.state.idleEpoch = "new"; await f.bridge.save(); }
        if (scenario === "user") await f.listener.handle(f.event("user.message", { content: "new request" }));
        if (scenario === "idle") { await f.idle(); await f.start(); }
        await f.idle(scenario === "cancel");
        assert.ok(!f.cache.get("session-a")?.content, scenario);
    }
});

test("idle completion capture uses the latest public source and ignores absent summaries", async () => {
    const f = await fixture(); await f.start();
    await f.message("Earlier reply");
    await f.listener.handle(f.event("session.task_complete", { summary: "Completion summary" }));
    await f.listener.handle(f.event("session.task_complete", { success: true }));
    await f.idle();
    assert.equal(f.cache.get("session-a").content, "Completion summary");
    await f.start();
    await f.listener.handle(f.event("session.task_complete", { summary: "Earlier summary" }));
    await f.message("Newer final reply", { phase: "final_answer" });
    await f.idle();
    assert.equal(f.cache.get("session-a").content, "Newer final reply");
    assert.equal(f.cache.get("session-a").completionEventId, null);
});

test("idle capture retains bounded text-free diagnostics for empty terminal messages", async () => {
    const f = await fixture(); await f.start();
    await f.listener.handle(f.event("assistant.message_start", { messageId: "empty-final", phase: "final_answer" }, { ephemeral: true }));
    const terminal = f.event("assistant.message", { messageId: "empty-final", content: "", phase: "final_answer" });
    await f.listener.handle(terminal); await f.idle();
    const record = f.cache.get("session-a");
    assert.equal(record.content, null);
    assert.equal(record.capture.version, 2);
    assert.equal(record.capture.lastTerminal.eventId, terminal.id);
    assert.equal(record.capture.lastTerminal.contentLength, 0);
    assert.equal(record.capture.lastTerminal.streamedLength, 0);
    assert.equal(record.capture.lastTerminal.hadStart, true);
    assert.equal(record.capture.lastTerminal.disposition, "empty");
    assert.equal(record.capture.taskCompletions, 0);
});

test("idle reply store validates a task summary against its actual completion event identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-idle-completion-"));
    try {
        const f = await fixture(); await f.start();
        await f.listener.handle(f.event("session.task_complete", { summary: "Summary" }));
        await f.idle();
        const store = new IdleReplyStore(directory), record = f.cache.get("session-a");
        await store.write(record);
        assert.equal((await store.read("session-a", "connection-1", "selection-1")).content, "Summary");
        await store.write({ ...record, completionEventId: "", messageId: null });
        await assert.rejects(store.read("session-a", "connection-1", "selection-1"), /unsupported/);
    } finally { await rm(directory, { recursive: true }); }
});

test("idle listener assembles same-ID streamed text only after its final message confirms completion", async () => {
    const f = await fixture();
    await f.start();
    await f.listener.handle(f.event("assistant.message_start", { messageId: "stream-1", phase: "final_answer" }, { ephemeral: true }));
    const first = f.event("assistant.message_delta", { messageId: "stream-1", deltaContent: "Finished " }, { ephemeral: true });
    await f.listener.handle(first);
    await f.listener.handle(first);
    await f.listener.handle(f.event("assistant.message_delta", { messageId: "foreign", deltaContent: "NOT THIS MESSAGE" }, { ephemeral: true }));
    await f.listener.handle(f.event("assistant.message_delta", { messageId: "stream-1", deltaContent: "the work." }, { ephemeral: true }));
    assert.equal(f.cache.size, 0);
    await f.listener.handle(f.event("assistant.message", { messageId: "stream-1", content: "", phase: "final_answer" }));
    await f.idle();
    assert.equal(f.cache.get("session-a").content, "Finished the work.");
    assert.equal(f.cache.get("session-a").messageId, "stream-1");
    assert.deepEqual(f.errors, []);
});

test("idle streaming refuses incomplete, nonpublic, wrong-scope, canceled and tool messages", async () => {
    for (const scenario of ["no-start", "no-terminal", "reasoning", "subagent", "tool", "turn", "connection", "selection", "cancel"]) {
        const f = await fixture();
        await f.start();
        const envelope = scenario === "subagent" ? { agentId: "child", ephemeral: true } : { ephemeral: true };
        const phase = scenario === "reasoning" ? "analysis" : "final_answer";
        if (scenario !== "no-start") await f.listener.handle(f.event("assistant.message_start", { messageId: "stream", phase }, envelope));
        await f.listener.handle(f.event("assistant.message_delta", { messageId: "stream", deltaContent: "MUST NOT FORWARD" }, envelope));
        if (scenario === "turn") await f.start();
        if (scenario === "connection" || scenario === "selection") {
            if (scenario === "connection") f.bridge.state.idleEpoch = "new-connection";
            else f.bridge.state.sessions["session-a"].idleSelectionId = "new-selection";
            await f.bridge.save();
        }
        if (scenario !== "no-terminal") await f.listener.handle(f.event("assistant.message", {
            messageId: "stream", phase, content: "",
            ...(scenario === "tool" ? { toolRequests: [{ name: "private", arguments: "SECRET" }] } : {}),
        }, scenario === "subagent" ? { agentId: "child" } : {}));
        await f.idle(scenario === "cancel");
        assert.ok(!f.cache.get("session-a")?.content, scenario);
    }
});

test("idle streaming uses authoritative terminal text and clears streams at every idle boundary", async () => {
    const f = await fixture();
    await f.start();
    await f.listener.handle(f.event("assistant.message_start", { messageId: "stream", phase: "final_answer" }, { ephemeral: true }));
    await f.listener.handle(f.event("assistant.message_delta", { messageId: "stream", deltaContent: "Partial text" }, { ephemeral: true }));
    await f.listener.handle(f.event("assistant.message", { messageId: "stream", phase: "final_answer", content: "Complete text" }));
    await f.idle();
    assert.equal(f.cache.get("session-a").content, "Complete text");
    await f.start();
    await f.listener.handle(f.event("assistant.message", { messageId: "stream", phase: "final_answer", content: "" }));
    await f.idle();
    assert.equal(f.cache.get("session-a").content, null);
    await f.listener.close();
});

test("idle capture subscribes to SDK streaming without requesting subagent streams", async () => {
    const source = await readFile(new URL("./extension.mjs", import.meta.url), "utf8");
    assert.match(source, /joinSession\(\{[^}]*streaming:\s*true[^}]*includeSubAgentStreamingEvents:\s*false/s);
});

test("idle listener does not capture unselected sessions or disabled idle notifications", async () => {
    for (const change of [
        state => { state.sessions = {}; },
        state => { state.notifyIdle = false; },
        state => { state.enabled = false; },
    ]) {
        const f = await fixture();
        change(f.bridge.state);
        await f.bridge.save();
        await f.start(); await f.message("DO NOT CAPTURE"); await f.idle();
        assert.equal(f.cache.size, 0);
        assert.deepEqual(f.errors, []);
    }
});

test("idle capture cannot reuse a previous connection, selection, turn or canceled reply", async () => {
    for (const change of [
        state => { state.idleEpoch = "new-connection"; },
        state => { state.sessions["session-a"].idleSelectionId = "new-selection"; },
    ]) {
        const f = await fixture();
        await f.start(); await f.message("OLD REPLY");
        change(f.bridge.state); await f.bridge.save();
        await f.idle();
        assert.equal(f.cache.size, 0);
    }
    const f = await fixture();
    await f.start(); await f.message("OLD REPLY"); await f.idle();
    await f.start(); await f.idle();
    assert.equal(f.cache.get("session-a").content, null);
    await f.start(); await f.message("CANCELED REPLY"); await f.idle(true);
    assert.equal(f.cache.get("session-a").content, null);
    assert.equal(f.cache.get("session-a").aborted, true);
});

test("idle reply files validate identity, reject stale scopes and clean up only their own records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-idle-"));
    try {
        const store = new IdleReplyStore(directory);
        const f = await fixture();
        await f.start(); await f.message("Reply"); await f.idle();
        const record = f.cache.get("session-a");
        await store.write(record);
        assert.deepEqual(await store.read("session-a", "connection-1", "selection-1"), record);
        assert.equal(await store.read("session-a", "old-connection", "selection-1"), null);
        assert.equal(await store.read("session-a", "connection-1", "old-selection"), null);
        await assert.rejects(store.read("..\\outside", "connection-1", "selection-1"), /Invalid/);
        await writeFile(store.path("session-a"), "{broken");
        await assert.rejects(store.read("session-a", "connection-1", "selection-1"), /corrupt/);
        await store.write({ ...record, sessionId: "session-b" });
        await store.remove("session-a");
        assert.equal(await store.read("session-a", "connection-1", "selection-1"), null);
        assert.ok(await store.read("session-b", "connection-1", "selection-1"));
        await store.clear(["session-b"]);
        assert.equal(await store.read("session-b", "connection-1", "selection-1"), null);
    } finally { await rm(directory, { recursive: true }); }
});

test("idle transition forwards the latest captured reply once without changing opt-ins", async () => {
    const f = await fixture();
    const selections = structuredClone(f.bridge.state.sessions);
    await f.bridge.sync();
    await f.start(); await f.message("Finished the requested change."); await f.idle();
    await f.bridge.sync(); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /^\[042\] Example session/);
    assert.equal(f.sent[0].split("\n")[1], "* IDLE *");
    assert.doesNotMatch(f.sent[0], /Became idle|does not prove success/);
    assert.equal(f.sent[0], "[042] Example session\n* IDLE *\n\nFinished the requested change.");
    assert.deepEqual(f.bridge.state.sessions, selections);
    assert.equal(f.bridge.state.signals["session-a"].idleDelivery.state, "sent");
});

test("native idle events cover short turns missed by status polling but never backfill old replies", async () => {
    const f = await fixture();
    f.rows[0].activity.status = "idle";
    await f.bridge.sync();
    assert.equal(f.sent.length, 0);
    await f.start(); await f.message("Short turn"); await f.idle();
    await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    f.bridge.state.idleEpoch = "new-connection";
    await f.bridge.save(); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
});

test("idle capture races wait for a reply and missing listeners produce an explicit notice", async () => {
    const f = await fixture();
    await f.bridge.sync(); await f.start(); await f.message("Delayed capture");
    f.rows[0].activity.status = "idle"; f.tick();
    await f.bridge.sync();
    assert.equal(f.sent.length, 0);
    f.tick(15_000); await f.idle(); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /Delayed capture/);
    const missing = await fixture();
    await missing.bridge.sync();
    missing.rows[0].activity.status = "idle";
    await missing.bridge.sync(); missing.tick(30_000);
    await missing.bridge.sync(); await missing.bridge.sync();
    assert.equal(missing.sent.length, 1);
    assert.match(missing.sent[0], /last assistant reply was not captured.*Reload extensions/s);
});

test("silent idle stays quiet across scans and reloads, then forwards the next real reply", async () => {
    const f = await fixture();
    await f.bridge.sync(); await f.start();
    await f.listener.handle(f.event("assistant.message_start", { messageId: "silent", phase: "final_answer" }, { ephemeral: true }));
    await f.listener.handle(f.event("assistant.message", { messageId: "silent", content: "", phase: "final_answer" }));
    await f.idle(); await f.bridge.sync(); await f.bridge.sync();
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.bridge.state.signals["session-a"].idleDelivery, {
        eventId: f.cache.get("session-a").eventId, state: "quiet", reason: "no-public-reply",
        partsSent: 0, partCount: 0,
    });
    await f.bridge.load(); await f.bridge.sync();
    assert.equal(f.sent.length, 0);
    f.rows[0].activity.status = "busy"; await f.bridge.sync();
    await f.start(); await f.message("New public reply", { phase: "final_answer" });
    await f.idle(); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /New public reply$/);
});

test("silent idle policy never hides missing listeners, incomplete streams, cancellation or unproven captures", async () => {
    for (const scenario of ["no-start", "no-terminal", "incomplete-stream", "cancel", "no-diagnostics", "unknown-version", "missing-listener"]) {
        const f = await fixture();
        await f.bridge.sync(); await f.start();
        if (scenario === "incomplete-stream") {
            await f.listener.handle(f.event("assistant.message_start", { messageId: "partial", phase: "final_answer" }, { ephemeral: true }));
            await f.listener.handle(f.event("assistant.message_delta", { messageId: "partial", deltaContent: "Incomplete" }, { ephemeral: true }));
        }
        if (scenario !== "no-start") await f.listener.handle(f.event("assistant.message_start", { messageId: "silent", phase: "final_answer" }, { ephemeral: true }));
        if (scenario !== "no-terminal") await f.listener.handle(f.event("assistant.message", { messageId: "silent", content: "", phase: "final_answer" }));
        if (scenario === "missing-listener") {
            f.rows[0].activity.status = "idle"; await f.bridge.sync(); f.tick(30_000);
        } else {
            await f.idle(scenario === "cancel");
            if (scenario === "no-diagnostics") delete f.cache.get("session-a").capture;
            if (scenario === "unknown-version") f.cache.get("session-a").capture.version = 999;
        }
        await f.bridge.sync(); await f.bridge.sync();
        assert.equal(f.sent.length, 1, scenario);
        assert.match(f.sent[0], /not captured|no final assistant reply/i, scenario);
        assert.equal(f.bridge.state.signals["session-a"].idleDelivery.state, "sent", scenario);
    }
});

test("silent idle policy preserves earlier public output in the same run and durable error reporting", async () => {
    const f = await fixture();
    await f.bridge.sync(); await f.start(); await f.message("Public result", { phase: "final_answer" });
    await f.start();
    await f.listener.handle(f.event("assistant.message_start", { messageId: "empty", phase: "final_answer" }, { ephemeral: true }));
    await f.listener.handle(f.event("assistant.message", { messageId: "empty", content: "", phase: "final_answer" }));
    await f.idle(); await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /Public result$/);

    const broken = await fixture();
    await broken.bridge.sync(); await broken.start();
    await broken.listener.handle(broken.event("assistant.message_start", { messageId: "empty", phase: "final_answer" }, { ephemeral: true }));
    await broken.listener.handle(broken.event("assistant.message", { messageId: "empty", content: "", phase: "final_answer" }));
    await broken.idle();
    const save = broken.store.save;
    broken.store.save = async state => {
        if (state.signals["session-a"]?.idleDelivery?.state === "quiet") throw new Error("quiet receipt save failed");
        await save(state);
    };
    await assert.rejects(broken.bridge.sync(), /quiet receipt save failed/);
    assert.equal(broken.sent.length, 0);
});

test("long idle replies are split losslessly within Telegram limits without breaking Unicode", async () => {
    const f = await fixture();
    const content = "a".repeat(3499) + "\u{1F600}" + "b".repeat(7000);
    await f.bridge.sync(); await f.start(); await f.message(content); await f.idle();
    await f.bridge.sync();
    assert.equal(f.sent.length, 4);
    assert.ok(f.sent.every(text => text.length <= 4096));
    assert.ok(f.sent.every((text, index) => text.startsWith(`[042] Example session\n* IDLE *\n(part ${index + 1}/4)\n\n`)));
    assert.ok(f.sent.every(text => !text.includes("Last assistant message")));
    const parts = f.sent.map(text => text.slice(text.indexOf("\n\n") + 2));
    assert.equal(parts.join(""), content);
    assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)));
    assert.equal(f.bridge.state.signals["session-a"].idleDelivery.partsSent, 4);
});

test("partial or canceled idle deliveries remain uncertain and are never automatically retried", async () => {
    for (const cancel of [false, true]) {
        const f = await fixture(), controller = new AbortController();
        let attempts = 0;
        f.telegram.send = async (chat, text) => {
            attempts++;
            if (!cancel && attempts === 2) throw new Error("delivery unknown");
            f.sent.push(text);
            if (cancel) controller.abort();
            return { message_id: attempts, chat: { id: chat } };
        };
        await f.bridge.sync(); await f.start(); await f.message("x".repeat(8000)); await f.idle();
        await assert.rejects(f.bridge.sync(controller.signal), /unknown|canceled/);
        const delivery = f.bridge.state.signals["session-a"].idleDelivery;
        assert.equal(delivery.state, "uncertain");
        assert.equal(delivery.partsSent, 1);
        const before = attempts;
        await f.bridge.sync();
        assert.equal(attempts, before);
    }
});

test("idle notifications stay off for awaiting-input sessions and surface cache failures", async () => {
    const f = await fixture();
    await f.bridge.sync(); await f.start(); await f.message("Reply"); await f.idle();
    f.rows[0].awaiting_permission = true;
    await f.bridge.sync();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /Needs input in the Copilot app/);
    f.rows[0].awaiting_permission = false;
    f.replies.read = async () => { throw new Error("cache unavailable"); };
    await assert.rejects(f.bridge.sync(), /cache unavailable/);
    assert.equal(f.sent.length, 1);
});

test("idle listener failures are visible and do not prevent a later valid capture", async () => {
    const f = await fixture();
    await f.start();
    await f.listener.handle(f.event("assistant.message", { content: "Reply without identity" }));
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /identity/);
    await f.message("Valid reply"); await f.idle();
    assert.equal(f.cache.get("session-a").content, "Valid reply");
});

test("idle service lifecycle scopes captures, clears them on disconnect and exposes uncertain delivery", async () => {
    const { Service } = await import("./service.mjs");
    const directory = await mkdtemp(join(tmpdir(), "telegram-idle-service-"));
    const app = { async list() { return []; } };
    let service = new Service({ directory, selfId: "hub", app });
    const telegram = {
        async call() { return []; },
        async updates(offset, signal) {
            return new Promise(resolve => signal.addEventListener("abort", () => resolve([]), { once: true }));
        },
    };
    try {
        await service.initialize();
        service.bridge.state.peer = { id: 42, chatId: 42, name: "Phone" };
        service.bridge.state.aliases["session-a"] = "042";
        service.bridge.state.sessions["session-a"] = { alias: "042", name: "Example" };
        await service.connect(telegram);
        const { idleEpoch: epoch, sessions } = service.bridge.state;
        const selectionId = sessions["session-a"].idleSelectionId;
        assert.equal(typeof epoch, "string");
        assert.equal(typeof selectionId, "string");
        await service.serial(async () => {
            service.bridge.state.signals["session-a"] = { idleDelivery: { eventId: "idle-1", state: "notifying" } };
            await service.bridge.save();
            await service.idleReplies.write({ version: 1, sessionId: "session-a", epoch, selectionId,
                eventId: "idle-1", idleAt: new Date().toISOString(), content: "Reply", messageId: "message-1", aborted: false });
        });
        assert.deepEqual((await service.status()).unresolved, [{ sessionId: "session-a", state: "idle-notification-uncertain" }]);
        await service.stop();
        assert.equal(await service.idleReplies.read("session-a", epoch, selectionId), null);
        await service.close();
        service = new Service({ directory, selfId: "hub", app });
        await service.initialize();
        assert.equal(service.bridge.state.signals["session-a"].idleDelivery.state, "uncertain");
        assert.equal(service.bridge.state.sessions["session-a"].idleSelectionId, selectionId);
    } finally { await service.close(); await rm(directory, { recursive: true }); }
});
