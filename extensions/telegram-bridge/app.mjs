export class AppAdapter {
    constructor(execute) { this.execute = execute; }

    async call(name, args = {}, json = false) {
        let timer;
        try {
            const result = await Promise.race([
                this.execute({ name, arguments: args }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`App ${name} timed out; outcome may be unknown.`)), 25_000);
                }),
            ]);
            if (typeof result !== "string" && result?.resultType !== "success") {
                const known = ["failure", "rejected", "denied", "timeout"].includes(result?.resultType);
                const outcome = known ? result.resultType : "unsupported response";
                const resultType = known ? result.resultType
                    : result?.resultType === undefined ? "missing" : "unrecognized";
                const fields = ["result", "resultType", "textResultForLlm", "content", "contents",
                    "isError", "error", "success", "status"].filter(key =>
                    result !== null && typeof result === "object" && Object.hasOwn(result, key));
                throw new Error(`App ${name} returned ${outcome} (resultType=${resultType}; fields=${fields.join(",") || "none"}). No result was accepted.`);
            }
            const text = typeof result === "string" ? result : result.textResultForLlm;
            if (typeof text !== "string") throw new Error(`App ${name} returned an unsupported result.`);
            if (/^\s*(error|failed|denied|rejected)\b/i.test(text)) throw new Error(`App ${name} did not confirm success.`);
            if (!json) {
                if (/^\s*\{/.test(text)) {
                    const value = JSON.parse(text);
                    if (value.error || value.success === false || value.accepted === false || value.handled === false) {
                        throw new Error(`App ${name} did not accept the request.`);
                    }
                }
                return;
            }
            try { return JSON.parse(text); }
            catch { throw new Error(`App ${name} returned invalid JSON.`); }
        } finally { clearTimeout(timer); }
    }

    async list() {
        const value = await this.call("get_sessions_status", {}, true);
        if (!Array.isArray(value?.sessions) || value.sessions.some(r => typeof r.id !== "string")) {
            throw new Error("App session status has an unsupported shape.");
        }
        return value.sessions;
    }

    async get(id) {
        const value = await this.call("get_session", { project_session_id: id }, true);
        if (value?.id !== id) throw new Error("App returned a different or unavailable session.");
        return value;
    }

    answer(id, requestId, answer) {
        return this.call("answer_session_input", { project_session_id: id, request_id: requestId, answer });
    }

    tell(id, message) {
        return this.call("send_session_message", { session_id: id, message, delivery_mode: "immediate" });
    }
}
