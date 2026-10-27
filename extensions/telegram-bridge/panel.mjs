import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";

const assets = new Map([
    ["/", ["panel.html", "text/html; charset=utf-8"]],
    ["/ui.mjs", ["ui.mjs", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
export async function startPanel(service) {
    const key = randomBytes(32).toString("hex");
    let origin;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'");
        const send = (status, value) => {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(value));
        };
        try {
            if (req.headers.host !== new URL(origin).host ||
                (req.headers.origin && req.headers.origin !== origin)) {
                send(403, { error: "Foreign host or origin rejected." }); return;
            }
            const url = new URL(req.url, origin);
            const asset = assets.get(url.pathname);
            if (req.method === "GET" && asset) {
                res.writeHead(200, { "Content-Type": asset[1] });
                res.end(await readFile(new URL(asset[0], import.meta.url))); return;
            }
            const supplied = Buffer.from(String(req.headers["x-bridge-key"] ?? ""));
            const expected = Buffer.from(key);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                send(401, { error: "Open this panel from its owner session." }); return;
            }
            if (req.method === "GET" && url.pathname === "/api/status") {
                send(200, await service.status()); return;
            }
            if (req.method !== "POST" || url.pathname !== "/api/action") {
                send(404, { error: "Unknown endpoint." }); return;
            }
            if (req.headers["content-type"] !== "application/json") {
                send(415, { error: "JSON is required." }); return;
            }
            const chunks = [];
            let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 16_384) {
                    send(413, { error: "Request is too large." }); req.resume(); return;
                }
                chunks.push(chunk);
            }
            let input;
            try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch { send(400, { error: "Invalid JSON." }); return; }
            send(200, await service.action(input));
        } catch (error) {
            if (!res.headersSent) send(400, { error: error.message || "Local bridge operation failed." });
            else res.end();
        }
    });
    server.requestTimeout = 60_000;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        origin, key, url: `${origin}/#${key}`,
        close: () => new Promise((resolve, reject) => {
            server.closeAllConnections();
            server.close(error => error ? reject(error) : resolve());
        }),
    };
}
