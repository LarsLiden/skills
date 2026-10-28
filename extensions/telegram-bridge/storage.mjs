import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { initialState } from "./bridge.mjs";

const accessTimeout = () => Object.assign(
    new Error("Bridge file access timed out; no file operation was performed."), { code: "EBUSY" });

function waitForRelease(address, deadline) {
    return new Promise((done, reject) => {
        const socket = createConnection(address);
        let finished = false;
        const finish = error => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error); else done();
        };
        const timer = setTimeout(() => finish(accessTimeout()), Math.max(0, deadline - performance.now()));
        socket.once("error", error => {
            // The owner can release or exit between our busy result and this connection.
            finish(["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code) ? null : error);
        });
        socket.once("close", () => finish());
        socket.resume();
    });
}

export async function withFileAccess(path, operation) {
    if (process.platform !== "win32") return operation();
    const hash = createHash("sha256").update(resolve(path).toLowerCase()).digest("hex");
    const address = `\\\\.\\pipe\\copilot-telegram-file-${hash}`;
    const deadline = performance.now() + 5000;
    while (true) {
        if (performance.now() >= deadline) throw accessTimeout();
        const waiters = new Set();
        let releasing = false;
        const server = createServer(socket => {
            socket.on("error", () => socket.destroy());
            socket.once("close", () => waiters.delete(socket));
            if (releasing) socket.destroy();
            else { waiters.add(socket); socket.resume(); }
        });
        const acquired = await new Promise((done, reject) => {
            server.once("error", error => error.code === "EADDRINUSE" ? done(false) : reject(error));
            server.listen(address, () => done(true));
        });
        if (acquired) {
            try {
                if (performance.now() >= deadline) throw accessTimeout();
                return await operation();
            } finally {
                releasing = true;
                const closed = new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
                for (const socket of waiters) socket.destroy();
                await closed;
            }
        }
        else await waitForRelease(address, deadline);
    }
}

export function readText(path) {
    return withFileAccess(path, () => readFile(path, "utf8"));
}

export function removeFile(path) {
    return withFileAccess(path, async () => {
        try { await unlink(path); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    });
}

async function optionalRead(path) {
    try { return await readText(path); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function atomicWrite(path, text) {
    // Windows replacement can fail even for read handles opened with delete-sharing.
    return withFileAccess(path, async () => {
        const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            await writeFile(temp, text, { mode: 0o600, flag: "wx" });
            await rename(temp, path);
        } finally {
            try { await unlink(temp); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
    });
}

export class Store {
    constructor(directory) { this.directory = directory; this.path = join(directory, "state.json"); }
    async load() {
        const text = await optionalRead(this.path);
        if (text === null) return initialState();
        let value;
        try { value = JSON.parse(text); }
        catch { throw new Error("Bridge state is corrupt. Preserve state.json and repair it before starting."); }
        if (![1, 2].includes(value?.version) || typeof value.enabled !== "boolean" ||
            !value.sessions || !value.requests || !value.signals || !value.commands ||
            (value.lastUpdate !== null && !Number.isSafeInteger(value.lastUpdate))) {
            throw new Error("Bridge state has an unsupported format; no empty-state recovery was performed.");
        }
        return value;
    }
    async save(value) {
        await mkdir(this.directory, { recursive: true });
        await atomicWrite(this.path, JSON.stringify(value, null, 2));
    }
}

function dpapi(value, encrypt) {
    if (process.platform !== "win32") throw new Error("Credential storage currently requires Windows DPAPI.");
    const script = encrypt
        ? "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString $v -AsPlainText -Force)"
        : "$ErrorActionPreference='Stop'; $v=ConvertTo-SecureString ([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($v); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }";
    return new Promise((resolve, reject) => {
        const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
        env.PSModulePath = join(powershell, "Modules");
        const child = spawn(join(powershell, "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
        const chunks = [];
        const timer = setTimeout(() => child.kill(), 15_000);
        child.stdout.on("data", chunk => chunks.push(chunk));
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.on("error", () => { clearTimeout(timer); reject(new Error("Windows credential helper could not start.")); });
        child.on("close", code => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error("Windows credential encryption/decryption failed."));
            else resolve(Buffer.concat(chunks).toString("utf8").trim());
        });
        child.stdin.end(value);
    });
}

export class Vault {
    constructor(directory) { this.directory = directory; this.path = join(directory, "bot.dpapi"); }
    async save(token) {
        const encrypted = await dpapi(token, true);
        await mkdir(this.directory, { recursive: true });
        await atomicWrite(this.path, encrypted);
    }
    async load() {
        const encrypted = await optionalRead(this.path);
        return encrypted === null ? null : dpapi(encrypted, false);
    }
    async clear() {
        await removeFile(this.path);
    }
}

export async function acquireOwner(identity) {
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 24);
    const address = process.platform === "win32" ? `\\\\.\\pipe\\copilot-telegram-${hash}`
        : join(process.env.TMPDIR ?? "/tmp", `copilot-telegram-${hash}.sock`);
    const server = createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
        server.once("error", error => reject(new Error(error.code === "EADDRINUSE"
            ? "Telegram bridge is already open in another hub session. Disconnect there or close that hub first."
            : "Could not acquire Telegram bridge ownership.")));
        server.listen(address, resolve);
    });
    return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
