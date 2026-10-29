import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, initialState } from "./bridge.mjs";
import { IdleListener } from "./idle.mjs";

async function fixture() {
    let disk = initialState(), sequence = 0, nextThread = 100;
    const captures = new Map(), idleCache = new Map(), sent = [], errors = [], calls = [];
    Object.assign(disk, { enabled: true, idleEpoch: "epoch-1", peer: { id: 42, chatId: 42 },
        bot: { id: 1000 }, aliases: { target: "042" },
        sessions: { target: { alias: "042", name: "Target", idleSelectionId: "selection-1" } } });
    const store = {
        async load() { return structuredClone(disk); },
        async save(value) { disk = structuredClone(value); },
    };
    const replies = {
        async write(value) { captures.set(value.inputId, structuredClone(value)); },
        async read(input) {
            const value = captures.get(input.id);
            return value?.epoch === input.epoch && value.selectionId === input.selectionId ? structuredClone(value) : null;
        },
        async remove(id) { captures.delete(id); },
        async clear(ids) { for (const id of ids) captures.delete(id); },
    };
    const idleReplies = {
        async write(value) { idleCache.set(value.sessionId, structuredClone(value)); },
        async read(id) { return idleCache.get(id) ?? null; },
        async remove(id) { idleCache.delete(id); },
    };
    const row = { id: "target", name: "Target", activity: { status: "busy" } };
    const telegram = {
        async identity() { return { id: 1000, hasTopicsEnabled: true }; },
        async createTopic(_, name) { return { message_thread_id: nextThread++, name }; },
        async editTopic() {},
        async deleteTopic() {},
        async send(chatId, text, extra = {}) {
            sent.push({ chatId, text, ...extra });
            return { message_id: sent.length, chat: { id: chatId }, ...extra };
        },
        async edit(chatId, messageId) { return { chat: { id: chatId }, message_id: messageId }; },
        async callback() {},
    };
    const app = {
        async list() { return [structuredClone(row)]; },
        async get() { return structuredClone(row); },
        async tell(...args) { calls.push(args); },
        async answer(...args) { calls.push(args); row.awaiting_user_input = false; },
    };
    const bridge = new Bridge({ app, telegram, store, selfId: "hub", firstReplies: replies, idleReplies });
    await bridge.load();
    const event = (type, data = {}, extra = {}) => ({
        type, data, id: `event-${++sequence}`, timestamp: new Date().toISOString(), ...extra,
    });
    const inputs = () => Object.values(bridge.state.phoneInputs ?? {});
    let listener;
    async function listen() {
        const { FirstReplyListener } = await import("./first-reply.mjs");
        listener = new FirstReplyListener({ sessionId: "target", stateStore: store, replies,
            notify: message => { errors.push(message); } });
        return listener;
    }
    async function user(content = "Please work", extra = {}) {
        return listener.handle(event("user.message", {
            content, source: "agent-hub", messageId: `user-${sequence}`,
            interactionId: "interaction-1", turnId: "1", ...extra,
        }));
    }
    async function message(content = "I'll get started.", extra = {}, envelope = {}) {
        return listener.handle(event("assistant.message", {
            content, messageId: `reply-${sequence}`, interactionId: "interaction-1",
            turnId: "1", phase: "commentary", ...extra,
        }, envelope));
    }
    return { bridge, store, replies, captures, sent, errors, calls, app, telegram, row,
        event, inputs, listen, user, message, idleReplies };
}

test("first reply is armed durably before a phone message is dispatched", async () => {
    const f = await fixture();
    f.app.tell = async () => {
        const saved = await f.store.load();
        assert.equal(Object.values(saved.phoneInputs ?? {}).length, 1);
        assert.equal(Object.values(saved.phoneInputs)[0].state, "attempting");
        assert.doesNotMatch(JSON.stringify(saved.phoneInputs), /Please work/);
    };
    await f.bridge.tell(1, "042", "Please work");
    assert.equal(f.inputs()[0].state, "accepted");
});

test("first public tool-adjacent reply goes out before idle and final result still follows", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    const listener = await f.listen();
    await f.user();
    await f.message("I'll get started.", { toolRequests: [{ arguments: "PRIVATE TOOL" }], reasoningText: "PRIVATE THOUGHT" });
    await f.bridge.forwardFirstReplies();
    assert.match(f.sent.at(-1).text, /\* REPLY \*\n\nI'll get started\.$/);
    assert.doesNotMatch(JSON.stringify(f.captures.values().next().value), /PRIVATE/);
    await f.message("More progress.");
    await f.bridge.forwardFirstReplies();
    assert.equal(f.sent.filter(m => m.text.includes("* REPLY *")).length, 1);
    const idle = new IdleListener({ sessionId: "target", stateStore: f.store, replies: f.idleReplies,
        notify: message => f.errors.push(message) });
    await idle.handle(f.event("assistant.turn_start"));
    await idle.handle(f.event("assistant.message", { content: "The work is done.", messageId: "final", phase: "final_answer" }));
    await idle.handle(f.event("session.idle"));
    f.row.activity.status = "idle";
    await f.bridge.sync();
    assert.match(f.sent.at(-1).text, /\* FINAL \*\n\nThe work is done\.$/);
    await listener.close();
    assert.deepEqual(f.errors, []);
});

test("first reply captures fast output before app acknowledgment but never sends before acceptance", async () => {
    const f = await fixture();
    await f.listen();
    f.app.tell = async () => {
        await f.user();
        await f.message();
        await f.bridge.forwardFirstReplies();
        assert.equal(f.sent.length, 0);
    };
    await f.bridge.tell(1, "042", "Please work");
    await f.bridge.forwardFirstReplies();
    assert.equal(f.sent.filter(m => m.text.includes("* REPLY *")).length, 1);
});

test("first reply after an exact Telegram answer binds completion and the next model turn", async () => {
    const f = await fixture();
    f.row.awaiting_user_input = true;
    f.row.awaiting_input = { kind: "question", request_id: "question-1", prompt: "Which?",
        choices: ["A", "B"], allow_freeform: false };
    await f.bridge.sync();
    const request = Object.values(f.bridge.state.requests)[0], listener = await f.listen();
    f.app.answer = async () => {
        await listener.handle(f.event("user_input.completed", { requestId: "wrong", answer: "A" }));
        assert.equal(f.captures.size, 0);
        await listener.handle(f.event("user_input.completed", { requestId: "question-1", answer: "A" }));
        await listener.handle(f.event("assistant.turn_start", { interactionId: "interaction-1", turnId: "1" }));
        await f.message("I'll use A.");
        f.row.awaiting_user_input = false;
    };
    await f.bridge.answer(request, "A");
    await f.bridge.forwardFirstReplies();
    assert.match(f.sent.at(-1).text, /I'll use A\.$/);
    assert.equal(f.inputs()[0].kind, "answer");
});

test("first reply requires the exact consumed phone message and same native interaction and turn", async () => {
    for (const scenario of ["source", "text", "missing-user-id", "interaction", "turn", "local", "subagent", "analysis", "ephemeral"]) {
        const f = await fixture();
        await f.bridge.tell(1, "042", "Please work");
        const listener = await f.listen();
        await f.user(scenario === "text" ? "Different input" : "Please work",
            scenario === "source" ? { source: "agent-stranger" } : scenario === "missing-user-id" ? { messageId: undefined } : {});
        if (scenario === "local") await listener.handle(f.event("user.message", { content: "Local instruction" }));
        await f.message("MUST NOT FORWARD", scenario === "interaction" ? { interactionId: "other" }
            : scenario === "turn" ? { turnId: "0" } : scenario === "analysis" ? { phase: "analysis" } : {},
        scenario === "subagent" ? { agentId: "child" } : scenario === "ephemeral" ? { ephemeral: true } : {});
        await f.bridge.forwardFirstReplies();
        assert.equal(f.sent.filter(m => m.text.includes("MUST NOT")).length, 0, scenario);
    }
});

test("first reply uses only a completed same-ID stream and ignores repeated chunks", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    const listener = await f.listen();
    await f.user();
    await listener.handle(f.event("assistant.message_start", { messageId: "stream" }, { ephemeral: true }));
    const delta = f.event("assistant.message_delta", { messageId: "stream", deltaContent: "Starting now." }, { ephemeral: true });
    await listener.handle(delta); await listener.handle(delta);
    await f.bridge.forwardFirstReplies();
    assert.equal(f.captures.size, 0);
    await f.message("", { messageId: "stream" });
    await f.bridge.forwardFirstReplies();
    assert.match(f.sent.at(-1).text, /Starting now\.$/);
});

test("first reply can be the actual root task summary without inventing a message ID or task success", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    const listener = await f.listen();
    await f.user();
    const completion = f.event("session.task_complete", { summary: "This needs review.", success: false });
    await listener.handle(completion);
    await f.bridge.forwardFirstReplies();
    assert.match(f.sent.at(-1).text, /This needs review\.$/);
    const reply = f.captures.get(f.inputs()[0].id);
    assert.equal(reply.messageId, null);
    assert.equal(reply.completionEventId, completion.id);
    await listener.handle(completion);
    await f.bridge.forwardFirstReplies();
    assert.equal(f.sent.filter(m => m.text.includes("This needs review.")).length, 1);
});

test("first reply task summaries cannot cross local-message or subagent boundaries", async () => {
    for (const scenario of ["local", "subagent"]) {
        const f = await fixture();
        await f.bridge.tell(1, "042", "Please work");
        const listener = await f.listen();
        await f.user();
        if (scenario === "local") await listener.handle(f.event("user.message", { content: "Different task" }));
        await listener.handle(f.event("session.task_complete", { summary: "MUST NOT FORWARD" },
            scenario === "subagent" ? { agentId: "child" } : {}));
        await f.bridge.forwardFirstReplies();
        assert.equal(f.sent.filter(m => m.text.includes("MUST NOT")).length, 0, scenario);
    }
});

test("first reply never forwards an uncertain app action or a revoked connection or selection", async () => {
    for (const scenario of ["app-error", "disabled", "epoch", "selection"]) {
        const f = await fixture();
        await f.listen();
        f.app.tell = async () => {
            await f.user(); await f.message("MUST NOT FORWARD");
            if (scenario === "app-error") throw new Error("App disconnected");
        };
        await f.bridge.tell(1, "042", "Please work");
        if (scenario === "disabled") f.bridge.state.enabled = false;
        if (scenario === "epoch") f.bridge.state.idleEpoch = "new-epoch";
        if (scenario === "selection") f.bridge.state.sessions.target.idleSelectionId = "new-selection";
        await f.bridge.save();
        await f.bridge.forwardFirstReplies();
        assert.equal(f.sent.filter(m => m.text.includes("MUST NOT")).length, 0, scenario);
    }
});

test("first reply checks current session identity and retirement before delivery", async () => {
    for (const scenario of ["archived", "wrong-id", "unavailable"]) {
        const f = await fixture();
        await f.bridge.tell(1, "042", "Please work");
        await f.listen(); await f.user(); await f.message("MUST NOT FORWARD");
        f.app.get = async () => scenario === "archived" ? { ...f.row, archived: true }
            : scenario === "wrong-id" ? { ...f.row, id: "other" } : null;
        await assert.rejects(f.bridge.forwardFirstReplies(), /unavailable|retired/);
        assert.equal(f.sent.filter(m => m.text.includes("MUST NOT")).length, 0, scenario);
        assert.equal(f.inputs()[0].delivery, undefined);
    }
});

test("first reply persists send uncertainty and cannot resend after a bridge restart", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    await f.listen(); await f.user(); await f.message();
    f.telegram.send = async () => { throw new Error("Lost Telegram response"); };
    await assert.rejects(f.bridge.forwardFirstReplies(), /Lost Telegram/);
    assert.equal(f.inputs()[0].delivery.state, "uncertain");
    await f.bridge.load();
    await f.bridge.forwardFirstReplies();
    assert.equal(f.inputs()[0].delivery.state, "uncertain");
});

test("first reply is not sent if its before-send state cannot be saved", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    await f.listen(); await f.user(); await f.message();
    const before = f.sent.length;
    f.store.save = async () => { throw new Error("State save failed"); };
    await assert.rejects(f.bridge.forwardFirstReplies(), /State save failed/);
    assert.equal(f.sent.length, before);
});

test("first reply shares one native public response across co-consumed phone inputs", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "First input");
    await f.bridge.tell(2, "042", "Second input");
    await f.listen();
    await f.user("First input");
    await f.user("Second input");
    await f.message("Answering both inputs.");
    await f.bridge.forwardFirstReplies();
    assert.equal(f.sent.filter(m => m.text.includes("Answering both")).length, 1);
    assert.equal(f.inputs().filter(i => ["sent", "shared"].includes(i.delivery.state)).length, 2);
});

test("first reply store validates identities and does not return stale or corrupt captures", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    await f.listen(); await f.user(); await f.message();
    const { FirstReplyStore } = await import("./first-reply.mjs");
    const directory = await mkdtemp(join(tmpdir(), "telegram-first-reply-"));
    try {
        const store = new FirstReplyStore(directory), input = f.inputs()[0];
        const value = f.captures.get(input.id);
        await store.write(value);
        assert.equal((await store.read(input)).content, "I'll get started.");
        assert.equal(await store.read({ ...input, selectionId: "different" }), null);
        await assert.rejects(store.write({ ...value, messageId: "" }), /unsupported/);
        await store.remove(input.id);
        assert.equal(await store.read(input), null);
    } finally { await rm(directory, { recursive: true }); }
});

test("first reply sends complete Unicode-safe parts to the exact session topic", async () => {
    const f = await fixture();
    await f.bridge.enableTopics();
    await f.bridge.tell(1, "042", "Please work");
    await f.listen(); await f.user();
    const content = "a".repeat(3499) + "\u{1F642}" + "b".repeat(4000);
    await f.message(content);
    await f.bridge.forwardFirstReplies();
    const parts = f.sent.filter(m => m.text.includes("* REPLY *"));
    assert.equal(parts.length, 3);
    assert.ok(parts.every(m => m.chatId === 42 && m.message_thread_id === f.bridge.topics.destination("target")));
    assert.equal(parts.map(m => m.text.split("\n\n")[1]).join(""), content);
    assert.ok(parts.every(m => !/[\uD800-\uDBFF]$/.test(m.text)));
});

test("first reply rejects wrong or partial Telegram destinations without a retry", async () => {
    for (const scenario of ["chat", "thread", "duplicate-part"]) {
        const f = await fixture();
        await f.bridge.tell(1, "042", "Please work");
        await f.listen(); await f.user(); await f.message("x".repeat(4000));
        let attempts = 0;
        f.telegram.send = async () => {
            attempts++;
            return { message_id: 123, chat: { id: scenario === "chat" ? 99 : 42 },
                ...(scenario === "thread" ? { message_thread_id: 999 } : {}) };
        };
        await assert.rejects(f.bridge.forwardFirstReplies(), /destination/);
        const before = attempts;
        await f.bridge.forwardFirstReplies();
        assert.equal(attempts, before);
        assert.equal(f.inputs()[0].delivery.state, "uncertain");
    }
});

test("first reply follows silent tool iterations but excludes an unrelated interaction", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    const listener = await f.listen();
    await f.user();
    await f.message("", { toolRequests: [{ name: "read" }] });
    await listener.handle(f.event("assistant.turn_start", { interactionId: "interaction-1", turnId: "2" }));
    await f.message("After the tool.", { turnId: "2" });
    await f.bridge.forwardFirstReplies();
    assert.match(f.sent.at(-1).text, /After the tool\.$/);
    await f.bridge.tell(2, "042", "New phone input");
    await f.user("New phone input");
    await listener.handle(f.event("assistant.turn_start", { interactionId: "other", turnId: "1" }));
    await f.message("MUST NOT FORWARD", { interactionId: "other" });
    await f.bridge.forwardFirstReplies();
    assert.doesNotMatch(f.sent.at(-1).text, /MUST NOT/);
});

test("first reply refuses ambiguous duplicate phone text and incomplete streams", async () => {
    for (const scenario of ["ambiguous", "no-start", "no-terminal"]) {
        const f = await fixture();
        await f.bridge.tell(1, "042", "Please work");
        if (scenario === "ambiguous") await f.bridge.tell(2, "042", "Please work");
        const listener = await f.listen();
        await f.user();
        if (scenario === "no-terminal") await listener.handle(f.event("assistant.message_start", { messageId: "stream" }));
        await listener.handle(f.event("assistant.message_delta", { messageId: "stream", deltaContent: "MUST NOT FORWARD" }));
        if (scenario !== "no-terminal") await f.message(scenario === "ambiguous" ? "MUST NOT FORWARD" : "", { messageId: "stream" });
        await f.bridge.forwardFirstReplies();
        assert.equal(f.sent.filter(m => m.text.includes("MUST NOT")).length, 0, scenario);
        if (scenario === "ambiguous") assert.match(f.errors[0], /ambiguous/);
    }
});

test("first reply cleanup retains uncertain delivery evidence while revoking capture", async () => {
    const f = await fixture();
    await f.bridge.tell(1, "042", "Please work");
    await f.listen(); await f.user(); await f.message();
    f.telegram.send = async () => { throw new Error("Uncertain send"); };
    await assert.rejects(f.bridge.forwardFirstReplies());
    const input = f.inputs()[0];
    await f.bridge.clearFirstReplies();
    assert.ok(f.captures.has(input.id));
    assert.equal(f.inputs()[0].delivery.state, "uncertain");
});

test("first reply watcher forwards while busy without waiting for a monitoring scan and closes on stop", async () => {
    const { Service } = await import("./service.mjs");
    const directory = await mkdtemp(join(tmpdir(), "telegram-first-watch-")), f = await fixture();
    const service = new Service({ directory, app: f.app, selfId: "hub" });
    let timeout;
    try {
        await service.initialize();
        service.bridge = f.bridge;
        f.bridge.firstReplies = service.firstReplies;
        f.replies.write = value => service.firstReplies.write(value);
        f.replies.read = input => service.firstReplies.read(input);
        f.telegram.call = async () => [];
        f.telegram.updates = (_, signal) => new Promise(resolve => {
            if (signal.aborted) resolve([]);
            else signal.addEventListener("abort", () => resolve([]), { once: true });
        });
        service.monitor = async () => {};
        await service.connect(f.telegram);
        const delivered = new Promise(resolve => {
            const send = f.telegram.send;
            f.telegram.send = async (...args) => {
                const result = await send(...args);
                if (args[1].includes("* REPLY *")) resolve(result);
                return result;
            };
        });
        await f.listen();
        f.app.tell = async () => { await f.user(); await f.message("Immediate while busy."); };
        await service.serial(() => f.bridge.tell(1, "042", "Please work"));
        await Promise.race([delivered, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("No event-driven first reply")), 2000);
        })]);
        assert.equal(service.lastSync, null);
        await service.stop();
        assert.equal(service.firstReplyWatcher, null);
        assert.equal(f.bridge.state.enabled, false);
    } finally {
        clearTimeout(timeout);
        await service.close();
        await rm(directory, { recursive: true });
    }
});

test("first reply restart fences interrupted dispatch and exposes unresolved delivery in status", async () => {
    const { Service } = await import("./service.mjs");
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "telegram-first-restart-"));
    await f.bridge.tell(1, "042", "Please work");
    const input = f.inputs()[0];
    input.state = "attempting";
    input.delivery = { state: "attempting", eventId: "event-before-restart" };
    const service = new Service({ directory, app: f.app, selfId: "hub" });
    try {
        await service.store.save(f.bridge.state);
        await service.initialize();
        assert.equal(service.bridge.state.phoneInputs[input.id].state, "uncertain");
        assert.equal(service.bridge.state.phoneInputs[input.id].delivery.state, "uncertain");
        const status = await service.status();
        assert.ok(status.unresolved.some(r => r.state === "first-reply-uncertain"));
        assert.ok(status.unresolved.some(r => r.state === "phone-input-uncertain"));
    } finally { await service.close(); await rm(directory, { recursive: true }); }
});

test("the same native first/final reply is shared in either capture order without retrying uncertain sends", async () => {
    for (const order of ["first", "final"]) {
        for (const uncertain of [false, true]) {
            const f = await fixture();
            await f.bridge.tell(1, "042", "Please work");
            const first = await f.listen(); await f.user();
            const final = new IdleListener({ sessionId: "target", stateStore: f.store, replies: f.idleReplies,
                notify: message => f.errors.push(message) });
            await final.handle(f.event("assistant.turn_start"));
            const message = f.event("assistant.message", {
                messageId: "shared-public-result", content: "One public result", phase: "final_answer",
                interactionId: "interaction-1", turnId: "1",
            });
            let attempts = 0;
            const send = f.telegram.send;
            f.telegram.send = async (...args) => {
                attempts++;
                if (uncertain) throw new Error("Uncertain Telegram delivery");
                return send(...args);
            };
            const forward = async operation => {
                if (uncertain && attempts === 0) await assert.rejects(operation(), /Uncertain/);
                else await operation();
            };
            if (order === "first") {
                await first.handle(message);
                await forward(() => f.bridge.forwardFirstReplies());
            }
            await final.handle(message); await final.handle(f.event("session.idle"));
            f.row.activity.status = "idle";
            await forward(() => f.bridge.sync());
            if (order === "final") {
                await first.handle(message);
                await f.bridge.forwardFirstReplies();
            }
            await f.bridge.sync(); await f.bridge.forwardFirstReplies();
            assert.equal(attempts, 1, `${order}/${uncertain}`);
            assert.equal(f.inputs()[0].delivery.state, uncertain ? "uncertain" : order === "first" ? "sent" : "shared");
            assert.equal(f.bridge.state.signals.target.idleDelivery.state,
                uncertain ? "uncertain" : order === "first" ? "shared" : "sent");
            assert.deepEqual(f.errors, []);
            await first.close(); await final.close();
        }
    }
});
