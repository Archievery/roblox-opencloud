import { vi } from "vitest";
import type { HttpAdapter, RawRequest, RawResponse } from "../src/http.js";
import type { Logger } from "../src/logger.js";

/** Builds a RawResponse without going near axios. */
export function response(data: unknown, status = 200, headers: Record<string, string> = {}): RawResponse {
    return { status, headers, data };
}

export interface StubHttp {
    adapter: HttpAdapter;
    /** Every request the adapter received, in order. */
    calls: RawRequest[];
    /** Queues one response, consumed in order. */
    push(...responses: RawResponse[]): void;
    /** Queues a transport-level rejection. */
    pushError(error: unknown): void;
}

/** A scripted HTTP adapter: the only mocking any suite needs. */
export function stubHttp(): StubHttp {
    const queued: Array<{ ok: true; value: RawResponse } | { ok: false; error: unknown }> = [];
    const calls: RawRequest[] = [];

    const adapter: HttpAdapter = async (request) => {
        calls.push(request);
        const next = queued.shift();
        if (!next) throw new Error(`stubHttp: no response queued for ${request.method} ${request.url}`);
        if (!next.ok) throw next.error;
        return next.value;
    };

    return {
        adapter,
        calls,
        push: (...responses) => queued.push(...responses.map((value) => ({ ok: true as const, value }))),
        pushError: (error) => queued.push({ ok: false, error }),
    };
}

/** A logger whose lines can be asserted on. */
export function recordingLogger(): Logger & { lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> } {
    const lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
    return {
        lines,
        debug: (fields, message) => lines.push({ level: "debug", fields, message }),
        warn: (fields, message) => lines.push({ level: "warn", fields, message }),
        error: (fields, message) => lines.push({ level: "error", fields, message }),
    };
}

/** Timings that keep the real poll and retry schedule but remove the waiting. */
export const fastTimings = {
    pollInitialMs: 1,
    pollMaxMs: 4,
    pollBudgetMs: 200,
    rateLimitFallbackMs: 1,
    requestTimeoutMs: 1_000,
    maxRetries: 3,
};

/** Suppresses vitest's unhandled-rejection noise for a promise we assert on later. */
export function swallow(promise: Promise<unknown>): Promise<unknown> {
    promise.catch(() => {});
    return promise;
}

export { vi };
