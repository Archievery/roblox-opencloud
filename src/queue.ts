import type { Credential, CredentialContext, RateLimitSnapshot, ResolvedCredential } from "./auth.js";
import { OpenCloudError, errorFromResponse, parseErrorBody } from "./errors.js";
import type { HttpAdapter, RawResponse } from "./http.js";
import type { Logger } from "./logger.js";
import { cacheKey, resolveOperationUrl } from "./url.js";
import type { HttpMethod } from "./types.js";

/** Every wait the queue performs. Exposed so tests can shrink the clock without global state. */
export interface Timings {
    /** First gap between Operation polls; doubles each attempt. Default 1000. */
    pollInitialMs: number;
    /** Ceiling for the doubled poll gap. Default 10000. */
    pollMaxMs: number;
    /** Total wall-clock budget for an Operation to complete. Default 60000. */
    pollBudgetMs: number;
    /** Backoff used when Roblox rate-limits without a Retry-After header. Default 5000. */
    rateLimitFallbackMs: number;
    /** Per-request socket timeout. Default 30000. */
    requestTimeoutMs: number;
    /** Retries attempted for a retryable status. Default 3. */
    maxRetries: number;
}

export const DEFAULT_TIMINGS: Timings = {
    pollInitialMs: 1_000,
    pollMaxMs: 10_000,
    pollBudgetMs: 60_000,
    rateLimitFallbackMs: 5_000,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
};

/** A fully-resolved unit of work. The queue needs nothing else to run it. */
export interface PreparedRequest<T> {
    operation: string;
    method: HttpMethod;
    url: string;
    body?: unknown;
    contentType: string;
    /** `none` skips credential resolution entirely, for Roblox's anonymous endpoints. */
    auth: "required" | "none";
    /** True when Roblox answers with an Operation resource that must be polled. */
    longPoll: boolean;
    /** Only idempotent requests are coalesced with an identical in-flight request. */
    idempotent: boolean;
    transform: (response: RawResponse) => T;
    signal?: AbortSignal;
}

export interface QueueOptions {
    http: HttpAdapter;
    logger: Logger;
    credential?: Credential;
    timings?: Partial<Timings>;
    /** Requests in flight at once. Default 8. */
    maxConcurrent?: number;
    userAgent: string;
}

/** Waits, rejecting early if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new OpenCloudError("ABORTED", "The request was aborted."));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new OpenCloudError("ABORTED", "The request was aborted."));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Reads a Retry-After header, which is normally delta-seconds but may be an HTTP date.
 *
 * @param value The raw header value.
 * @param fallbackMs Used when the header is absent or unparseable.
 * @returns Milliseconds to wait.
 */
export function parseRetryAfter(value: string | undefined, fallbackMs: number): number {
    if (!value) return fallbackMs;
    if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    return fallbackMs;
}

/** An Operation resource, as returned by every long-running Open Cloud method. */
interface OperationResource {
    path?: string;
    done?: boolean;
    error?: { code?: number; message?: string };
    response?: unknown;
}

/** Runs requests against Roblox with bounded concurrency, retries and rate-limit awareness. */
export class RequestQueue {
    private readonly http: HttpAdapter;
    private readonly logger: Logger;
    private readonly credential: Credential | undefined;
    private readonly timings: Timings;
    private readonly maxConcurrent: number;
    private readonly userAgent: string;

    /** Rate-limit state, by the credential that actually paid and then by operation. */
    private readonly rateLimits = new Map<string, Map<string, RateLimitSnapshot>>();
    private readonly inflight = new Map<string, Promise<unknown>>();
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(options: QueueOptions) {
        this.http = options.http;
        this.logger = options.logger;
        this.credential = options.credential;
        this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
        this.maxConcurrent = options.maxConcurrent ?? 8;
        this.userAgent = options.userAgent;
    }

    /**
     * Runs a prepared request, coalescing it with an identical in-flight idempotent request.
     *
     * @param request The work to perform.
     * @returns The transformed response body.
     */
    execute<T>(request: PreparedRequest<T>): Promise<T> {
        if (!request.idempotent) return this.run(request);

        const key = cacheKey({
            operation: request.operation,
            url: request.url,
            body: request.body,
            credentialId: this.credential?.id ?? "anonymous",
        });

        const existing = this.inflight.get(key);
        if (existing) return existing as Promise<T>;

        const promise = this.run(request).finally(() => this.inflight.delete(key));
        this.inflight.set(key, promise);
        return promise;
    }

    /** Observed headroom for a credential, taken as the tightest bucket it currently holds. */
    headroom(credentialId: string): RateLimitSnapshot | undefined {
        const buckets = this.rateLimits.get(credentialId);
        if (!buckets) return undefined;
        const now = Date.now();
        let tightest: RateLimitSnapshot | undefined;
        for (const snapshot of buckets.values()) {
            if (snapshot.resetAt.getTime() <= now) continue;
            if (!tightest || snapshot.remaining < tightest.remaining) tightest = snapshot;
        }
        return tightest;
    }

    private async acquire(): Promise<void> {
        if (this.active < this.maxConcurrent) {
            this.active++;
            return;
        }
        // release() hands a slot straight to the next waiter rather than freeing and
        // re-taking it, so the count never dips and correctness does not rest on microtask
        // ordering between the waiter resuming and the next arrival.
        await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    private release(): void {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
    }

    private async run<T>(request: PreparedRequest<T>): Promise<T> {
        await this.acquire();
        try {
            return await this.attempt(request);
        } finally {
            this.release();
        }
    }

    private async attempt<T>(request: PreparedRequest<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            const credential = await this.resolveCredential(request, attempt);
            const response = await this.send(request.url, request.method, request.body, request.contentType, credential, request.signal);

            this.recordRateLimit(request.operation, credential, response);

            if (this.shouldRetry(response.status) && attempt < this.timings.maxRetries) {
                const waitMs = parseRetryAfter(response.headers["retry-after"], this.timings.rateLimitFallbackMs);
                this.logger.warn(
                    { operation: request.operation, status: response.status, waitMs, attempt },
                    "rate limited or unavailable - retrying",
                );
                await sleep(waitMs, request.signal);
                continue;
            }

            if (response.status >= 400) throw errorFromResponse(response.status, response.data, request.operation);

            return request.longPoll
                ? await this.awaitOperation(request, credential, response)
                : this.transform(request, response);
        }
    }

    /** Retried only for the statuses where the same request can plausibly succeed later. */
    private shouldRetry(status: number): boolean {
        return status === 429 || status === 503;
    }

    private async resolveCredential<T>(request: PreparedRequest<T>, attempt: number): Promise<ResolvedCredential | null> {
        if (request.auth === "none") return null;
        if (!this.credential) {
            throw new OpenCloudError(
                "NO_CREDENTIAL",
                `Operation "${request.operation}" needs a credential. Construct the client with one, e.g. new OpenCloudClient({ credential: apiKey(key) }).`,
                { operation: request.operation },
            );
        }

        const context: CredentialContext = {
            operation: request.operation,
            attempt,
            headroom: (id) => this.headroom(id),
            http: this.http,
            logger: this.logger,
            ...(request.signal ? { signal: request.signal } : {}),
        };
        return this.credential.resolve(context);
    }

    private async send(
        url: string,
        method: HttpMethod,
        body: unknown,
        contentType: string,
        credential: ResolvedCredential | null,
        signal: AbortSignal | undefined,
    ): Promise<RawResponse> {
        const headers: Record<string, string> = {
            "Content-Type": contentType,
            "User-Agent": this.userAgent,
        };
        if (credential) {
            if (credential.kind === "bearer") headers["Authorization"] = `Bearer ${credential.value}`;
            else headers["x-api-key"] = credential.value;
        }

        this.logger.debug({ method, url, credentialId: credential?.id ?? "anonymous" }, "dispatch");

        return this.http({
            method,
            url,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            timeoutMs: this.timings.requestTimeoutMs,
            ...(signal ? { signal } : {}),
        });
    }

    /** Polls an Operation resource with exponential backoff until it completes or the budget runs out. */
    private async awaitOperation<T>(
        request: PreparedRequest<T>,
        credential: ResolvedCredential | null,
        initial: RawResponse,
    ): Promise<T> {
        let response = initial;
        const deadline = Date.now() + this.timings.pollBudgetMs;
        let delay = this.timings.pollInitialMs;

        for (;;) {
            const operation = (response.data ?? {}) as OperationResource;

            if (operation.done) {
                // Checked before `response`, which is absent on a failed operation.
                if (operation.error) {
                    throw new OpenCloudError("ROBLOX_ERROR", operation.error.message ?? "The operation failed.", {
                        operation: request.operation,
                        robloxCode: operation.error.code,
                    });
                }
                return this.transform(request, response);
            }

            if (!operation.path) {
                throw new OpenCloudError("MALFORMED_RESPONSE", "The operation returned no path to poll.", {
                    operation: request.operation,
                    status: response.status,
                });
            }

            if (Date.now() >= deadline) {
                throw new OpenCloudError(
                    "TIMEOUT",
                    `The operation did not complete within ${this.timings.pollBudgetMs}ms.`,
                    { operation: request.operation },
                );
            }

            await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), request.signal);
            delay = Math.min(delay * 2, this.timings.pollMaxMs);

            response = await this.send(
                resolveOperationUrl(operation.path),
                "GET",
                undefined,
                "application/json",
                credential,
                request.signal,
            );
            this.recordRateLimit(request.operation, credential, response);
            if (response.status >= 400) throw errorFromResponse(response.status, response.data, request.operation);
        }
    }

    /** Applies the operation's transform, converting an unexpected shape into a clean error. */
    private transform<T>(request: PreparedRequest<T>, response: RawResponse): T {
        // A 2xx carrying an error envelope is Roblox reporting failure without a failing status.
        const embedded = parseErrorBody(response.data);
        if (embedded?.robloxCode !== undefined && embedded.message !== undefined && !Array.isArray(response.data)) {
            throw new OpenCloudError("ROBLOX_ERROR", embedded.message, {
                operation: request.operation,
                status: response.status,
                robloxCode: embedded.robloxCode,
                ...(embedded.details ? { details: embedded.details } : {}),
            });
        }

        try {
            return request.transform(response);
        } catch (err: unknown) {
            if (err instanceof OpenCloudError) throw err;
            throw new OpenCloudError("MALFORMED_RESPONSE", `Could not read the ${request.operation} response.`, {
                operation: request.operation,
                status: response.status,
                cause: err,
            });
        }
    }

    /** Records `x-ratelimit-*` headroom against the credential that actually paid for the call. */
    private recordRateLimit(operation: string, credential: ResolvedCredential | null, response: RawResponse): void {
        const remaining = response.headers["x-ratelimit-remaining"];
        if (remaining === undefined) return;

        const reset = response.headers["x-ratelimit-reset"];
        const resetSeconds = reset === undefined ? 60 : Number(reset);
        const credentialId = credential?.id ?? "anonymous";
        let buckets = this.rateLimits.get(credentialId);
        if (!buckets) this.rateLimits.set(credentialId, (buckets = new Map()));
        buckets.set(operation, {
            remaining: Number(remaining),
            // x-ratelimit-reset is seconds remaining in the window, not an absolute time.
            resetAt: new Date(Date.now() + (Number.isFinite(resetSeconds) ? resetSeconds : 60) * 1000),
        });
    }
}
