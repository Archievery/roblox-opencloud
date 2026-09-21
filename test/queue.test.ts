import { describe, it, expect } from "vitest";
import { apiKey, custom } from "../src/auth.js";
import { OpenCloudError } from "../src/errors.js";
import type { HttpAdapter, RawResponse } from "../src/http.js";
import { RequestQueue, parseRetryAfter } from "../src/queue.js";
import type { PreparedRequest } from "../src/queue.js";
import { fastTimings, recordingLogger, response, stubHttp } from "./helpers.js";
import { ingressAuthError, rawThumbnailDone, rawThumbnailErrored, rawThumbnailPending, rawUser } from "./fixtures.js";

function makeQueue(http: HttpAdapter, overrides: Partial<ConstructorParameters<typeof RequestQueue>[0]> = {}) {
    return new RequestQueue({
        http,
        logger: recordingLogger(),
        credential: apiKey("test-key", { id: "cred-a" }),
        timings: fastTimings,
        userAgent: "test-agent",
        ...overrides,
    });
}

function request<T = unknown>(overrides: Partial<PreparedRequest<T>> = {}): PreparedRequest<T> {
    return {
        operation: "GetUser",
        method: "GET",
        url: "https://apis.roblox.com/cloud/v2/users/1",
        contentType: "application/json",
        auth: "required",
        longPoll: false,
        idempotent: true,
        transform: (r) => r.data as T,
        ...overrides,
    };
}

describe("RequestQueue - dispatch", () => {
    it("sends an API key as x-api-key and an OAuth token as a bearer", async () => {
        const keyHttp = stubHttp();
        keyHttp.push(response(rawUser));
        await makeQueue(keyHttp.adapter).execute(request());
        expect(keyHttp.calls[0]?.headers["x-api-key"]).toBe("test-key");
        expect(keyHttp.calls[0]?.headers["Authorization"]).toBeUndefined();

        const bearerHttp = stubHttp();
        bearerHttp.push(response(rawUser));
        await makeQueue(bearerHttp.adapter, { credential: custom("oauth-a", () => "access-token") }).execute(request());
        expect(bearerHttp.calls[0]?.headers["Authorization"]).toBe("Bearer access-token");
        expect(bearerHttp.calls[0]?.headers["x-api-key"]).toBeUndefined();
    });

    it("sends the configured user agent and serializes the body", async () => {
        const http = stubHttp();
        http.push(response({}));
        await makeQueue(http.adapter).execute(request({ method: "POST", body: { role: "groups/7/roles/9" }, idempotent: false }));
        expect(http.calls[0]?.headers["User-Agent"]).toBe("test-agent");
        expect(http.calls[0]?.body).toBe('{"role":"groups/7/roles/9"}');
    });

    it("skips credential resolution entirely for an anonymous operation", async () => {
        const http = stubHttp();
        http.push(response({}));
        await makeQueue(http.adapter, { credential: undefined }).execute(request({ auth: "none" }));
        expect(http.calls[0]?.headers["x-api-key"]).toBeUndefined();
    });

    it("throws NO_CREDENTIAL before any HTTP when one is required and absent", async () => {
        const http = stubHttp();
        await expect(makeQueue(http.adapter, { credential: undefined }).execute(request())).rejects.toMatchObject({
            code: "NO_CREDENTIAL",
        });
        expect(http.calls).toHaveLength(0);
    });
});

describe("RequestQueue - error mapping", () => {
    it("maps HTTP statuses onto error codes", async () => {
        for (const [status, code] of [
            [400, "BAD_REQUEST"],
            [403, "FORBIDDEN"],
            [404, "NOT_FOUND"],
            [500, "ROBLOX_ERROR"],
            [502, "ROBLOX_ERROR"],
            [504, "ROBLOX_ERROR"],
        ] as const) {
            const http = stubHttp();
            http.push(response({}, status));
            await expect(makeQueue(http.adapter).execute(request())).rejects.toMatchObject({ code, status });
        }
    });

    it("reports a bad key as UNAUTHORIZED with the real message, not a generic 403", async () => {
        const http = stubHttp();
        http.push(response(ingressAuthError, 403));
        await expect(makeQueue(http.adapter).execute(request())).rejects.toMatchObject({
            code: "UNAUTHORIZED",
            message: "Invalid authentication data provided",
        });
    });

    it("wraps a throwing transform as MALFORMED_RESPONSE rather than leaking a TypeError", async () => {
        const http = stubHttp();
        http.push(response({}));
        const boom = request({
            transform: () => {
                throw new TypeError("cannot read property of undefined");
            },
        });
        await expect(makeQueue(http.adapter).execute(boom)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    });

    it("surfaces a transport failure as thrown by the adapter", async () => {
        const http = stubHttp();
        http.pushError(new OpenCloudError("NETWORK", "ECONNREFUSED"));
        await expect(makeQueue(http.adapter).execute(request())).rejects.toMatchObject({ code: "NETWORK" });
    });
});

describe("parseRetryAfter", () => {
    it("reads delta-seconds as an offset, not as a year", () => {
        // new Date("5") parses as a calendar date, producing an already-elapsed backoff and a
        // hot retry loop straight back into the rate limit.
        const before = Date.now();
        expect(parseRetryAfter("5", 1_000)).toBe(5_000);
        expect(Date.now() - before).toBeLessThan(1_000);
    });

    it("reads an HTTP date as a delay from now", () => {
        const at = new Date(Date.now() + 30_000).toUTCString();
        const delay = parseRetryAfter(at, 1_000);
        expect(delay).toBeGreaterThan(28_000);
        expect(delay).toBeLessThanOrEqual(30_000);
    });

    it("falls back when the header is absent or unparseable", () => {
        expect(parseRetryAfter(undefined, 5_000)).toBe(5_000);
        expect(parseRetryAfter("soon", 5_000)).toBe(5_000);
    });
});

describe("RequestQueue - retries", () => {
    it("retries a 429 and resolves on the retry", async () => {
        const http = stubHttp();
        http.push(response({}, 429, { "retry-after": "0" }), response(rawUser));
        const result = await makeQueue(http.adapter).execute(request());
        expect(result).toEqual(rawUser);
        expect(http.calls).toHaveLength(2);
    });

    it("retries a 503 and gives up as RATE_LIMITED or ROBLOX_ERROR once retries run out", async () => {
        const http = stubHttp();
        for (let i = 0; i < 5; i++) http.push(response({}, 503));
        await expect(makeQueue(http.adapter).execute(request())).rejects.toMatchObject({ code: "ROBLOX_ERROR" });
        expect(http.calls).toHaveLength(4); // the initial attempt plus maxRetries
    });

    it("does NOT retry a success that happens to carry Retry-After", async () => {
        // The original condition fired on any status carrying the header, so a 200 with
        // Retry-After was requeued forever and the caller's promise never settled.
        const http = stubHttp();
        http.push(response(rawUser, 200, { "retry-after": "5" }));
        expect(await makeQueue(http.adapter).execute(request())).toEqual(rawUser);
        expect(http.calls).toHaveLength(1);
    });

    it("does not retry a 404", async () => {
        const http = stubHttp();
        http.push(response({}, 404));
        await expect(makeQueue(http.adapter).execute(request())).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(http.calls).toHaveLength(1);
    });
});

describe("RequestQueue - coalescing", () => {
    it("gives two identical in-flight reads the same promise and one request", async () => {
        const http = stubHttp();
        http.push(response(rawUser));
        const queue = makeQueue(http.adapter);

        const [a, b] = await Promise.all([queue.execute(request()), queue.execute(request())]);

        // Superseding instead would reject one branch of a Promise.all for no reason the caller
        // can explain.
        expect(a).toEqual(rawUser);
        expect(b).toEqual(rawUser);
        expect(http.calls).toHaveLength(1);
    });

    it("does not coalesce different resources", async () => {
        const http = stubHttp();
        http.push(response(rawUser), response({ ...rawUser, id: "2" }));
        const queue = makeQueue(http.adapter);

        await Promise.all([
            queue.execute(request()),
            queue.execute(request({ url: "https://apis.roblox.com/cloud/v2/users/2" })),
        ]);
        expect(http.calls).toHaveLength(2);
    });

    it("never coalesces writes, and both settle", async () => {
        // Two identical writes are two intended writes. The original queue dropped one of them
        // silently and left its promise pending forever.
        const http = stubHttp();
        http.push(response({ ok: 1 }), response({ ok: 2 }));
        const queue = makeQueue(http.adapter);
        const write = () => request({ method: "POST", idempotent: false, body: { role: "x" } });

        const results = await Promise.all([queue.execute(write()), queue.execute(write())]);

        expect(http.calls).toHaveLength(2);
        expect(results).toHaveLength(2);
    });

    it("releases the coalescing slot once a request finishes", async () => {
        const http = stubHttp();
        http.push(response(rawUser), response(rawUser));
        const queue = makeQueue(http.adapter);
        await queue.execute(request());
        await queue.execute(request());
        expect(http.calls).toHaveLength(2);
    });
});

describe("RequestQueue - concurrency", () => {
    it("never exceeds maxConcurrent in flight", async () => {
        let inFlight = 0;
        let peak = 0;
        const adapter: HttpAdapter = async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return response(rawUser);
        };
        const queue = makeQueue(adapter, { maxConcurrent: 3 });

        await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
                queue.execute(request({ url: `https://apis.roblox.com/cloud/v2/users/${i}` })),
            ),
        );

        expect(peak).toBeLessThanOrEqual(3);
    });

    it("still respects maxConcurrent when a caller chains a request off a completing one", async () => {
        // Chaining off a completing request is the arrival pattern most likely to race the
        // hand-off of a freed slot, so the cap is asserted under it as well as under a burst.
        let inFlight = 0;
        let peak = 0;
        const adapter: HttpAdapter = async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 10));
            inFlight--;
            return response(rawUser);
        };
        const queue = makeQueue(adapter, { maxConcurrent: 2 });
        const at = (id: string) => request({ url: `https://apis.roblox.com/cloud/v2/users/${id}` });

        const first = queue.execute(at("1"));
        const second = queue.execute(at("2"));
        const queued = queue.execute(at("3")); // waits for a slot
        const chained = first.then(() => queue.execute(at("4"))); // arrives as that slot frees

        await Promise.all([first, second, queued, chained]);

        expect(peak).toBeLessThanOrEqual(2);
    });

    it("keeps draining after a request fails", async () => {
        const http = stubHttp();
        http.push(response({}, 404), response(rawUser));
        const queue = makeQueue(http.adapter, { maxConcurrent: 1 });

        await expect(queue.execute(request())).rejects.toThrow();
        expect(await queue.execute(request({ url: "https://apis.roblox.com/cloud/v2/users/2" }))).toEqual(rawUser);
    });
});

describe("RequestQueue - long-poll", () => {
    const thumbnail = () =>
        request({
            operation: "GenerateUserThumbnail",
            longPoll: true,
            transform: (r) => (r.data as { response: { imageUri: string } }).response.imageUri,
        });

    it("polls the operation path at a resolvable URL", async () => {
        const http = stubHttp();
        http.push(response(rawThumbnailPending), response(rawThumbnailDone));

        expect(await makeQueue(http.adapter).execute(thumbnail())).toBe("https://tr.rbxcdn.com/abc.png");
        // Concatenating the origin and the relative path yields https://apis.roblox.comusers/...
        expect(http.calls[1]?.url).toBe(`https://apis.roblox.com/cloud/v2/users/1234567890/operations/thumb-op-123`);
    });

    it("returns immediately when the first response is already done", async () => {
        const http = stubHttp();
        http.push(response(rawThumbnailDone));
        expect(await makeQueue(http.adapter).execute(thumbnail())).toBe("https://tr.rbxcdn.com/abc.png");
        expect(http.calls).toHaveLength(1);
    });

    it("reports an operation-level failure instead of dereferencing the absent response", async () => {
        const http = stubHttp();
        http.push(response(rawThumbnailErrored));
        await expect(makeQueue(http.adapter).execute(thumbnail())).rejects.toMatchObject({
            code: "ROBLOX_ERROR",
            message: "The user does not exist.",
            robloxCode: 3,
        });
    });

    it("backs off exponentially and gives up at the budget", async () => {
        const http = stubHttp();
        for (let i = 0; i < 200; i++) http.push(response(rawThumbnailPending));
        const queue = makeQueue(http.adapter, {
            timings: { ...fastTimings, pollInitialMs: 1, pollMaxMs: 8, pollBudgetMs: 60 },
        });

        await expect(queue.execute(thumbnail())).rejects.toMatchObject({ code: "TIMEOUT" });
        // A fixed 60x1s schedule would burn an OAuth credential's whole minute budget in ten
        // seconds; backing off keeps the poll count far below the attempt ceiling.
        expect(http.calls.length).toBeLessThan(40);
    });

    it("fails cleanly when the operation carries no path to poll", async () => {
        const http = stubHttp();
        http.push(response({ done: false }));
        await expect(makeQueue(http.adapter).execute(thumbnail())).rejects.toMatchObject({
            code: "MALFORMED_RESPONSE",
        });
    });

    it("surfaces an error status received while polling", async () => {
        const http = stubHttp();
        http.push(response(rawThumbnailPending), response({}, 404));
        await expect(makeQueue(http.adapter).execute(thumbnail())).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("RequestQueue - rate-limit tracking", () => {
    it("records headroom against the credential that actually paid", async () => {
        const http = stubHttp();
        http.push(response(rawUser, 200, { "x-ratelimit-remaining": "17", "x-ratelimit-reset": "30" }));
        const queue = makeQueue(http.adapter);

        await queue.execute(request());

        // The old implementation had a comment where this write should have been, so the
        // headroom map was permanently empty and pool selection never did anything.
        const snapshot = queue.headroom("cred-a");
        expect(snapshot?.remaining).toBe(17);
        expect(snapshot?.resetAt.getTime()).toBeGreaterThan(Date.now());
        expect(queue.headroom("someone-else")).toBeUndefined();
    });

    it("reports the tightest bucket a credential holds", async () => {
        const http = stubHttp();
        http.push(
            response(rawUser, 200, { "x-ratelimit-remaining": "50", "x-ratelimit-reset": "30" }),
            response(rawUser, 200, { "x-ratelimit-remaining": "3", "x-ratelimit-reset": "30" }),
        );
        const queue = makeQueue(http.adapter);

        await queue.execute(request({ operation: "GetUser" }));
        await queue.execute(request({ operation: "GetGroup", url: "https://apis.roblox.com/cloud/v2/groups/7" }));

        expect(queue.headroom("cred-a")?.remaining).toBe(3);
    });

    it("ignores a response with no rate-limit headers", async () => {
        const http = stubHttp();
        http.push(response(rawUser));
        const queue = makeQueue(http.adapter);
        await queue.execute(request());
        expect(queue.headroom("cred-a")).toBeUndefined();
    });
});

describe("RequestQueue - abort", () => {
    it("rejects with ABORTED when the signal fires during a retry wait", async () => {
        const http = stubHttp();
        http.push(response({}, 429, { "retry-after": "30" }));
        const controller = new AbortController();
        const queue = makeQueue(http.adapter, { timings: { ...fastTimings, rateLimitFallbackMs: 30_000 } });

        const promise = queue.execute(request({ signal: controller.signal, idempotent: false }));
        setTimeout(() => controller.abort(), 5);

        await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    });
});

describe("RequestQueue - embedded errors", () => {
    it("treats a 2xx carrying an error envelope as a failure", async () => {
        const http = stubHttp();
        http.push(response({ code: "INVALID_ARGUMENT", message: "bad filter" }, 200));
        await expect(makeQueue(http.adapter).execute(request())).rejects.toMatchObject({
            code: "ROBLOX_ERROR",
            message: "bad filter",
        });
    });

    it("leaves an ordinary success alone", async () => {
        const http = stubHttp();
        const body: RawResponse = response(rawUser);
        http.push(body);
        expect(await makeQueue(http.adapter).execute(request())).toEqual(rawUser);
    });
});
