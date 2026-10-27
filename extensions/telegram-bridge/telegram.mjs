export class Telegram {
    constructor(token, fetchImpl = fetch) {
        if (!/^\d{5,}:[A-Za-z0-9_-]{25,}$/.test(token)) throw new Error("Enter a valid BotFather token.");
        this.token = token;
        this.fetch = fetchImpl;
        this.botId = null;
        this.username = null;
        this.outbound = Promise.resolve();
        this.lastSend = 0;
    }

    async call(method, body = {}, signal) {
        let response, data;
        const timeout = AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000);
        try {
            response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                redirect: "error",
            });
            data = await response.json();
        } catch {
            if (signal?.aborted) throw new Error("Telegram request canceled.");
            throw new Error("Telegram network request failed; delivery may be uncertain.");
        }
        if (!response.ok || data?.ok !== true) {
            const code = Number.isInteger(data?.error_code) ? data.error_code : "unknown";
            const error = new Error(`Telegram API rejected ${method} (${code}); no action was automatically retried.`);
            error.apiCode = code;
            if (code === 429) error.retryAfter = Math.max(1, Number(data.parameters?.retry_after) || 30);
            throw error;
        }
        return data.result;
    }

    async identity() {
        const bot = await this.call("getMe");
        if (!Number.isSafeInteger(bot?.id) || bot.is_bot !== true || !/^[A-Za-z0-9_]+$/.test(bot.username ?? "")) {
            throw new Error("Telegram did not return a valid bot identity.");
        }
        this.botId = bot.id;
        this.username = bot.username;
        return { id: bot.id, username: bot.username, hasTopicsEnabled: bot.has_topics_enabled === true };
    }

    async checkWebhook() {
        const result = await this.call("getWebhookInfo");
        if (typeof result?.url !== "string") throw new Error("Telegram webhook status is unavailable.");
        if (result.url) throw new Error("This bot already has a webhook. Use a dedicated bot; the bridge will not remove it.");
    }

    async updates(offset, signal) {
        const result = await this.call("getUpdates", {
            ...(offset === null ? {} : { offset }), timeout: 25, limit: 50,
            allowed_updates: ["message", "callback_query"],
        }, signal);
        if (!Array.isArray(result)) throw new Error("Telegram returned an invalid update list.");
        return result;
    }

    paced(method, body) {
        const result = this.outbound.then(async () => {
            const remaining = 1100 - (Date.now() - this.lastSend);
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
            this.lastSend = Date.now();
            return this.call(method, body);
        });
        this.outbound = result.then(() => undefined, () => undefined);
        return result;
    }

    send(chatId, text, extra = {}) {
        return this.paced("sendMessage", {
            chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra,
        });
    }

    edit(chatId, messageId, text) {
        return this.paced("editMessageText", {
            chat_id: chatId, message_id: messageId, text,
            link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] },
        });
    }

    createTopic(chatId, name) { return this.paced("createForumTopic", { chat_id: chatId, name }); }

    async editTopic(chatId, threadId, name) {
        const result = await this.paced("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name });
        if (result !== true) throw new Error("Telegram did not confirm the topic rename.");
    }

    async deleteTopic(chatId, threadId) {
        const result = await this.paced("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
        if (result !== true) throw new Error("Telegram did not confirm the topic deletion.");
    }

    callback(id) { return this.call("answerCallbackQuery", { callback_query_id: id }); }
}
