import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Store, atomicWrite } from "./storage.mjs";
import { initialState } from "./bridge.mjs";

test("a contending file operation subscribes to the owner release instead of polling blind", async () => {
    const { withFileAccess } = await import("./storage.mjs");
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-release-signal-"));
    const path = join(directory, "state.json");
    const hash = createHash("sha256").update(resolve(path).toLowerCase()).digest("hex");
    const address = `\\\\.\\pipe\\copilot-telegram-file-${hash}`;
    const sockets = new Set();
    let connected, waiting, ran = false;
    const subscribed = new Promise(done => { connected = done; });
    const owner = createServer(socket => { sockets.add(socket); connected(); });
    await new Promise((done, reject) => { owner.once("error", reject); owner.listen(address, done); });
    try {
        waiting = withFileAccess(path, () => { ran = true; });
        await Promise.race([subscribed, wait(500).then(() => { throw new Error("Waiter never subscribed to release."); })]);
        assert.equal(ran, false);
        assert.equal(sockets.size, 1);
        const closed = new Promise((done, reject) => owner.close(error => error ? reject(error) : done()));
        for (const socket of sockets) socket.destroy();
        await closed; await waiting;
        assert.equal(ran, true);
    } finally {
        for (const socket of sockets) socket.destroy();
        if (owner.listening) await new Promise(done => owner.close(done));
        await waiting;
        await rm(directory, { recursive: true });
    }
});

test("state replacement remains atomic while session listeners read concurrently", { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-readers-"));
    const workers = [];
    const stop = new Int32Array(new SharedArrayBuffer(4));
    try {
        const store = new Store(directory);
        const state = { ...initialState(), revision: 0, padding: "x".repeat(60_000) };
        await store.save(state);
        for (let i = 0; i < 8; i++) {
            const worker = new Worker(`
                const { parentPort, workerData } = require("node:worker_threads");
                (async () => {
                    const { Store } = await import(workerData.module);
                    const store = new Store(workerData.directory);
                    const stop = new Int32Array(workerData.stop);
                    parentPort.postMessage("ready");
                    let reads = 0;
                    while (!Atomics.load(stop, 0)) {
                        const value = await store.load();
                        if (value.padding !== "x".repeat(60_000) || !Number.isInteger(value.revision)) {
                            throw new Error("Reader saw missing or partial state.");
                        }
                        reads++;
                    }
                    parentPort.postMessage(reads);
                })().catch(error => { throw error; });
            `, { eval: true, workerData: { module: new URL("./storage.mjs", import.meta.url).href,
                directory, stop: stop.buffer } });
            workers.push(worker);
            await new Promise((resolve, reject) => {
                worker.once("message", resolve);
                worker.once("error", reject);
            });
        }
        const results = workers.map(worker => new Promise((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
        }));
        const settledReaders = Promise.allSettled(results);
        const errors = [];
        for (let revision = 1; revision <= 300; revision++) {
            state.revision = revision;
            try { await store.save(state); }
            catch (error) { errors.push(error.code ?? error.message); }
        }
        Atomics.store(stop, 0, 1);
        for (const result of await settledReaders) {
            if (result.status === "rejected") throw result.reason;
            assert.ok(result.value > 0);
        }
        assert.equal(errors.length, 0, `Atomic replacement failures: ${errors.length}; first: ${errors[0]}`);
        assert.equal((await store.load()).revision, 300);
    } finally {
        Atomics.store(stop, 0, 1);
        await Promise.all(workers.map(worker => worker.terminate()));
        await rm(directory, { recursive: true });
    }
});

test("file access waits for an existing reader before replacing complete state", async () => {
    const { withFileAccess } = await import("./storage.mjs");
    assert.equal(typeof withFileAccess, "function");
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-gate-"));
    const path = join(directory, "state.json");
    let releaseReader, reader, writing;
    try {
        await writeFile(path, "old");
        const held = new Promise(resolve => { releaseReader = resolve; });
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        reader = withFileAccess(path, async () => {
            const handle = await open(path, "r");
            try { entered(); await held; }
            finally { await handle.close(); }
        });
        await ready;
        let written = false;
        writing = atomicWrite(path, "new").then(() => { written = true; });
        await wait(100);
        assert.equal(written, false);
        assert.equal(await readFile(path, "utf8"), "old");
        releaseReader();
        await reader; await writing;
        assert.equal(await readFile(path, "utf8"), "new");
        assert.deepEqual(await readdir(directory), ["state.json"]);
    } finally {
        releaseReader?.();
        await Promise.allSettled([reader, writing]);
        await rm(directory, { recursive: true });
    }
});

test("file access releases after failure and does not block different files", async () => {
    const { withFileAccess } = await import("./storage.mjs");
    assert.equal(typeof withFileAccess, "function");
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-release-"));
    try {
        const path = join(directory, "state.json");
        const failure = new Error("synthetic read failure");
        await assert.rejects(withFileAccess(path, () => { throw failure; }), error => error === failure);
        await withFileAccess(path, () => atomicWrite(join(directory, "other.json"), "independent"));
        await atomicWrite(path, "released");
        assert.equal(await readFile(path, "utf8"), "released");
    } finally { await rm(directory, { recursive: true }); }
});

test("file access timeout stays explicit and cannot run the blocked operation", { timeout: 10_000 }, async () => {
    const { withFileAccess } = await import("./storage.mjs");
    assert.equal(typeof withFileAccess, "function");
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-timeout-"));
    try {
        const path = join(directory, "state.json");
        await withFileAccess(path, async () => {
            let ran = false;
            const start = performance.now();
            await assert.rejects(withFileAccess(path, () => { ran = true; }),
                error => error.code === "EBUSY" && /file access.*timed out/i.test(error.message));
            assert.equal(ran, false);
            assert.ok(performance.now() - start < 7000);
        });
        await atomicWrite(path, "released");
    } finally { await rm(directory, { recursive: true }); }
});

test("file access is released by the OS when its owning worker exits", async () => {
    const { withFileAccess } = await import("./storage.mjs");
    assert.equal(typeof withFileAccess, "function");
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-owner-exit-"));
    let worker, writing;
    try {
        const path = join(directory, "state.json");
        worker = new Worker(`
            const { parentPort, workerData } = require("node:worker_threads");
            (async () => {
                const { withFileAccess } = await import(workerData.module);
                await withFileAccess(workerData.path, () => new Promise(() => parentPort.postMessage("locked")));
            })().catch(error => { throw error; });
        `, { eval: true, workerData: { module: new URL("./storage.mjs", import.meta.url).href, path } });
        await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
        let written = false;
        writing = atomicWrite(path, "after exit").then(() => { written = true; });
        await wait(100);
        assert.equal(written, false);
        await worker.terminate();
        await writing;
        assert.equal(await readFile(path, "utf8"), "after exit");
    } finally { await worker?.terminate(); await writing; await rm(directory, { recursive: true }); }
});

test("cross-process file access coordinates Windows path casing and releases on process exit", { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-process-"));
    const path = join(directory, "state.json");
    let child, exited, writing;
    try {
        await atomicWrite(path, "old");
        child = spawn(process.execPath, ["--input-type=module", "-e", `
            import { withFileAccess } from ${JSON.stringify(new URL("./storage.mjs", import.meta.url).href)};
            import { open } from "node:fs/promises";
            process.on("message", message => { if (message === "exit") process.exit(0); });
            await withFileAccess(${JSON.stringify(path.toUpperCase())}, async () => {
                const reader = await open(${JSON.stringify(path)}, "r");
                process.send("locked");
                await new Promise(() => {});
                await reader.close();
            });
        `], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
        let errors = "";
        child.stderr.on("data", chunk => { errors += chunk; });
        exited = new Promise((done, reject) => {
            child.once("exit", code => code === 0 ? done() : reject(new Error(`Reader exited ${code}: ${errors}`)));
            child.once("error", reject);
        });
        await Promise.race([
            new Promise(done => child.once("message", done)),
            exited.then(() => { throw new Error("Reader exited before acquiring file access."); }),
        ]);
        let committed = false;
        writing = atomicWrite(path, "new").then(() => { committed = true; });
        await wait(100);
        assert.equal(committed, false);
        assert.equal(await readFile(path, "utf8"), "old");
        child.send("exit");
        await exited; await writing;
        assert.equal(await readFile(path, "utf8"), "new");
    } finally {
        if (child?.connected) child.send("exit");
        await Promise.allSettled([exited, writing]);
        await rm(directory, { recursive: true });
    }
});

test("external read locks remain visible failures without deleting or truncating old state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-state-external-lock-"));
    let reader;
    try {
        const path = join(directory, "state.json");
        await atomicWrite(path, "old complete state");
        reader = await open(path, "r");
        await assert.rejects(atomicWrite(path, "new complete state"), error => error.code === "EPERM");
        assert.equal(await readFile(path, "utf8"), "old complete state");
        assert.deepEqual(await readdir(directory), ["state.json"]);
        await reader.close(); reader = null;
        await atomicWrite(path, "new complete state");
        assert.equal(await readFile(path, "utf8"), "new complete state");
    } finally { await reader?.close(); await rm(directory, { recursive: true }); }
});
