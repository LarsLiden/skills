import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "./service.mjs";
import { IdleListener } from "./idle.mjs";

test("final cache watcher forwards before the next monitor poll, with inactivity disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-final-watcher-"));
    const row = { id: "target", name: "Target", activity: { status: "busy" } };
    const sent = [], errors = [];
    let delivered, timeout;
    const receipt = new Promise(resolve => { delivered = resolve; });
    const app = { async list() { return [structuredClone(row)]; }, async get() { return structuredClone(row); } };
    const telegram = {
        async call() { return []; },
        async updates(_, signal) {
            return new Promise(resolve => {
                if (signal.aborted) resolve([]);
                else signal.addEventListener("abort", () => resolve([]), { once: true });
            });
        },
        async send(chatId, text) {
            sent.push(text); delivered();
            return { message_id: sent.length, chat: { id: chatId } };
        },
    };
    const service = new Service({ directory, selfId: "hub", app, notify: message => errors.push(message) });
    let listener;
    try {
        await service.initialize();
        Object.assign(service.bridge.state, { peer: { id: 42, chatId: 42 }, bot: { id: 1000 },
            aliases: { target: "042" }, sessions: { target: { alias: "042", name: "Target", idleSelectionId: "s" } } });
        await service.connect(telegram);
        await service.serial(async () => {});
        const epoch = service.bridge.state.idleEpoch;
        await service.action({ action: "idle", enabled: false });
        assert.equal(service.bridge.state.idleEpoch, epoch);
        listener = new IdleListener({ sessionId: "target", stateStore: service.store, replies: service.idleReplies,
            notify: message => errors.push(message) });
        const event = (type, id, data = {}) => ({ type, id, data, timestamp: new Date().toISOString() });
        await listener.handle(event("assistant.turn_start", "turn"));
        await listener.handle(event("assistant.message", "message", {
            messageId: "public-result", phase: "final_answer", content: "Prompt result",
        }));
        await listener.handle(event("session.idle", "native-idle"));
        await Promise.race([receipt, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Final reply waited for the 15-second monitor poll.")), 5_000);
        })]);
        clearTimeout(timeout);
        await service.serial(async () => {});
        assert.deepEqual(sent, ["[042] Target\n* FINAL *\n\nPrompt result"]);
        await service.action({ action: "idle", enabled: true });
        assert.equal(service.bridge.state.idleEpoch, epoch);
        assert.equal((await service.idleReplies.read("target", epoch, "s")).content, "Prompt result");
        row.activity.status = "idle";
        await service.refresh();
        service.bridge.now = () => Date.now() + 30_001;
        await service.refresh();
        assert.equal(sent.length, 1, "lagging busy/idle app scans must not invent a missing-capture warning");
        assert.deepEqual(errors, []);
    } finally {
        clearTimeout(timeout);
        await listener?.close(); await service.close();
        await rm(directory, { recursive: true });
    }
});

test("interrupted inactivity attempts are exposed separately and retained on deselection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-inactivity-restart-"));
    let service = new Service({ directory, selfId: "hub", app: {} });
    try {
        await service.initialize();
        Object.assign(service.bridge.state, {
            aliases: { target: "042" }, sessions: { target: { alias: "042", idleSelectionId: "s" } },
            signals: { target: { inactivityDelivery: { scope: "scope", revision: "r", state: "notifying" } } },
        });
        await service.bridge.save(); await service.close();
        service = new Service({ directory, selfId: "hub", app: {} });
        await service.initialize();
        assert.equal(service.bridge.state.signals.target.inactivityDelivery.state, "uncertain");
        assert.deepEqual((await service.status()).unresolved,
            [{ sessionId: "target", state: "inactivity-notification-uncertain" }]);
        await service.bridge.setOptIn("target", false);
        assert.equal(service.bridge.state.signals.target.inactivityDelivery.state, "uncertain");
    } finally {
        await service.close(); await rm(directory, { recursive: true });
    }
});

test("entrypoint records activity separately without changing hub role hooks or requesting child text streams", async () => {
    const source = await readFile(new URL("./extension.mjs", import.meta.url), "utf8");
    assert.match(source, /hooks:\s*hubRole\.hooks/);
    assert.match(source, /includeSubAgentStreamingEvents:\s*false/);
    assert.match(source, /activityListener\.handle\(event\)/);
    assert.match(source, /setInterval\([^;]*activityListener\.heartbeat\(\)[\s\S]*15_000\)/);
    assert.match(source, /clearInterval\(heartbeat\)/);
    assert.match(source, /activityListener\.close\(\)/);
});
