const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
    "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
const methods = new Set(["getMe", "getWebhookInfo", "getUpdates", "sendMessage", "editMessageText",
    "createForumTopic", "editForumTopic", "deleteForumTopic", "answerCallbackQuery"]);

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
        if (!methods.has(method)) throw new Error("Unsupported Telegram operation.");
        let response, data;
        const timeout = AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000);
        try {
            response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                redirect: "error",
            });
        } catch (cause) {
            const code = signal?.aborted ? "canceled" : timeout.aborted ? "timeout"
                : [cause?.code, cause?.cause?.code].find(value => networkCodes.has(value)) ?? "unknown";
            throw this.failure(method, "network", code);
        }
        try { data = await response.json(); }
        catch {
            throw this.failure(method, "response-json", signal?.aborted ? "canceled"
                : timeout.aborted ? "timeout" : "invalid-json", response.status);
        }
        if (!response.ok || data?.ok !== true) {
            const code = Number.isInteger(data?.error_code) ? data.error_code : "unknown";
            const error = new Error(`Telegram API rejected ${method} (${code}); no action was automatically retried.`);
            error.apiCode = code;
            error.diagnostic = { method, stage: "api", code, at: new Date().toISOString(),
                httpStatus: Number.isInteger(response.status) ? response.status : null };
            if (code === 429) error.retryAfter = Math.max(1, Number(data.parameters?.retry_after) || 30);
            throw error;
        }
        return data.result;
    }

    failure(method, stage, code, httpStatus) {
        const diagnostic = { method, stage, code, at: new Date().toISOString(),
            httpStatus: Number.isInteger(httpStatus) ? httpStatus : null };
        const outcome = method === "getUpdates" ? "Incoming polling failed; no new batch was confirmed."
            : ["getMe", "getWebhookInfo"].includes(method) ? "The read was not confirmed."
                : "Delivery may be uncertain; no action was automatically retried.";
        return Object.assign(new Error(`Telegram ${method} ${stage} failed (${code}) at ${diagnostic.at}. ${outcome}`),
            { diagnostic });
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

    edit(chatId, messageId, text, markup = { inline_keyboard: [] }) {
        return this.paced("editMessageText", {
            chat_id: chatId, message_id: messageId, text,
            link_preview_options: { is_disabled: true }, reply_markup: markup,
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
