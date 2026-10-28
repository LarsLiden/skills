import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
import { AppAdapter } from "./app.mjs";
import { Service } from "./service.mjs";
import { startPanel } from "./panel.mjs";
import { Store } from "./storage.mjs";
import { IdleListener, IdleReplyStore } from "./idle.mjs";
import { AnswerListener, AnswerReceiptStore } from "./answers.mjs";
import { FirstReplyListener, FirstReplyStore } from "./first-reply.mjs";

const directory = fileURLToPath(new URL("./artifacts/", import.meta.url));
let service, panel, opening;
async function ensurePanel() {
    opening ??= (async () => {
        service ??= new Service({
            app: new AppAdapter(request => session.rpc.tools.execute(request)),
            directory,
            selfId: session.sessionId,
            notify: message => { void session.log(message, { level: "warning", ephemeral: false }); },
        });
        await service.initialize();
        panel ??= await startPanel(service);
        return panel;
    })().catch(error => { opening = undefined; throw error; });
    return opening;
}

const canvas = createCanvas({
    id: "telegram-bridge",
    displayName: "Telegram bridge",
    description: "Pair your phone and opt individual Copilot sessions into Telegram question alerts and replies.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    actions: [{
        name: "status",
        description: "Read bridge health without revealing credentials or changing monitoring.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => {
            if (!service?.initialized) return { configured: false, connected: false, setupRequired: true };
            const value = await service.status();
            return { configured: value.configured, connected: value.connected, enabled: value.enabled,
                lastSync: value.lastSync, error: value.error, monitoredSessions: value.sessions.filter(s => s.selected).length,
                unresolvedActions: value.unresolved.length, topics: value.topics, questionUpdates: value.questionUpdates,
                health: value.health, inbound: value.inbound };
        },
    }, {
        name: "check_app_connection",
        description: "Check the app session-status RPC without sending Telegram messages or changing any session.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => {
            if (!service?.initialized) throw new Error("Open the setup panel first.");
            const rows = await service.app.list();
            service.bridge.rows = rows;
            return { connectedToApp: true, visibleSessions: rows.length };
        },
    }],
    open: async () => {
        const current = await ensurePanel();
        return { url: current.url, title: "Telegram bridge", status: "Local setup and per-session opt-in" };
    },
});

const session = await joinSession({ canvases: [canvas], streaming: true, includeSubAgentStreamingEvents: false });
const listener = new IdleListener({
    sessionId: session.sessionId, stateStore: new Store(directory), replies: new IdleReplyStore(directory),
    notify: message => session.log(`Telegram idle capture: ${message}`, { level: "warning", ephemeral: false }),
});
const answerListener = new AnswerListener({
    sessionId: session.sessionId, stateStore: new Store(directory), receipts: new AnswerReceiptStore(directory),
    notify: message => session.log(`Telegram answer capture: ${message}`, { level: "warning", ephemeral: false }),
});
const firstReplyListener = new FirstReplyListener({
    sessionId: session.sessionId, stateStore: new Store(directory), replies: new FirstReplyStore(directory),
    notify: message => session.log(`Telegram first reply: ${message}`, { level: "warning", ephemeral: false }),
});
const unsubscribe = session.on(event => {
    void listener.handle(event);
    void answerListener.handle(event);
    void firstReplyListener.handle(event);
});
let closing = false;
async function close() {
    if (closing) return;
    closing = true;
    unsubscribe();
    try { await listener.close(); await answerListener.close(); await firstReplyListener.close(); await service?.close(); await panel?.close(); }
    catch { await session.log("Telegram bridge shutdown was not clean; check its owner process before reconnecting.", { level: "error" }); }
}
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
session.on("session.shutdown", () => { void close(); });
