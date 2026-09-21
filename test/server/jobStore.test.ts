import { describe, it, expect, afterEach } from "vitest";
import { JobStore } from "../../src/server/jobStore.js";

const stores: JobStore[] = [];
function makeStore(ttlMs = 300_000, sweepMs = 60_000): JobStore {
    const store = new JobStore(ttlMs, sweepMs);
    stores.push(store);
    return store;
}

afterEach(() => {
    while (stores.length) stores.pop()?.close();
});

describe("JobStore lifecycle", () => {
    it("creates a pending job with a uuid", () => {
        const store = makeStore();
        const id = store.create();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(store.get(id)?.status).toBe("pending");
    });

    it("moves pending to running to completed", () => {
        const store = makeStore();
        const id = store.create();
        store.markRunning(id);
        expect(store.get(id)?.status).toBe("running");
        store.complete(id, { ok: true });
        expect(store.get(id)).toMatchObject({ status: "completed", data: { ok: true } });
    });

    it("records a failure with its code", () => {
        const store = makeStore();
        const id = store.create();
        store.fail(id, { code: "NOT_FOUND", message: "no such user" });
        expect(store.get(id)).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    });

    it("ignores every mutation for an unknown id", () => {
        const store = makeStore();
        expect(() => {
            store.markRunning("nope");
            store.complete("nope", 1);
            store.fail("nope", { code: "x", message: "y" });
        }).not.toThrow();
        expect(store.get("nope")).toBeUndefined();
    });

    it("hands out snapshots, not the live job", () => {
        const store = makeStore();
        const id = store.create();
        const snapshot = store.get(id);
        if (snapshot) snapshot.status = "failed";
        expect(store.get(id)?.status).toBe("pending");
    });
});

describe("JobStore.waitForTerminal", () => {
    it("returns immediately for a job that has already finished", async () => {
        const store = makeStore();
        const id = store.create();
        store.complete(id, 1);
        expect((await store.waitForTerminal(id, 50))?.status).toBe("completed");
    });

    it("returns null for an unknown id", async () => {
        expect(await makeStore().waitForTerminal("nope", 10)).toBeNull();
    });

    it("wakes every waiter when the job completes", async () => {
        const store = makeStore();
        const id = store.create();
        store.markRunning(id);

        const waiters = [store.waitForTerminal(id, 5_000), store.waitForTerminal(id, 5_000)];
        setTimeout(() => store.complete(id, "done"), 5);

        for (const job of await Promise.all(waiters)) expect(job).toMatchObject({ status: "completed", data: "done" });
    });

    it("returns the current snapshot when it times out", async () => {
        const store = makeStore();
        const id = store.create();
        store.markRunning(id);
        const started = Date.now();

        const job = await store.waitForTerminal(id, 30);

        expect(job?.status).toBe("running");
        expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    });
});

describe("JobStore.sweep", () => {
    it("drops finished jobs past the ttl but keeps recent ones", async () => {
        const store = makeStore(1);
        const old = store.create();
        store.complete(old, 1);
        const fresh = makeStore(300_000);
        const kept = fresh.create();
        fresh.complete(kept, 1);

        await new Promise((r) => setTimeout(r, 10));
        store.sweep();
        fresh.sweep();

        expect(store.get(old)).toBeUndefined();
        expect(fresh.get(kept)).toBeDefined();
    });

    it("never sweeps a job that has not finished, however old", async () => {
        const store = makeStore(1);
        const pending = store.create();
        const running = store.create();
        store.markRunning(running);

        await new Promise((r) => setTimeout(r, 10));
        store.sweep();

        expect(store.get(pending)).toBeDefined();
        expect(store.get(running)).toBeDefined();
    });
});

describe("JobStore.close", () => {
    it("stops the sweep timer and is safe to call twice", () => {
        // The timer starts in the constructor rather than at module import: a library must not
        // run a timer merely because it was loaded, and an import-time one cannot be stopped.
        const store = new JobStore(1, 1);
        expect(() => {
            store.close();
            store.close();
        }).not.toThrow();
    });
});
