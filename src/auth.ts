import { createHash } from "node:crypto";
import { OpenCloudError, parseErrorBody } from "./errors.js";
import type { HttpAdapter } from "./http.js";
import type { Logger } from "./logger.js";

const TOKEN_URL = "https://apis.roblox.com/oauth/v1/token";

/** Observed rate-limit headroom for one credential, taken from Roblox response headers. */
export interface RateLimitSnapshot {
    remaining: number;
    resetAt: Date;
}

/** A credential resolved for one outgoing request. */
export interface ResolvedCredential {
    /** The id of the credential that produced this value - for a pool, the chosen member. */
    readonly id: string;
    readonly kind: "apiKey" | "bearer";
    readonly value: string;
}

/** What the queue knows at resolve time, so a pool can choose on live headroom. */
export interface CredentialContext {
    readonly operation: string;
    /** 0 on the first attempt, incremented after a retry. */
    readonly attempt: number;
    /** Live rate-limit view for a credential id, or undefined if never observed. */
    headroom(credentialId: string): RateLimitSnapshot | undefined;
    readonly http: HttpAdapter;
    readonly logger: Logger;
    readonly signal?: AbortSignal;
}

/** A source of credentials. apiKey, oauth, pool and custom all produce one. */
export interface Credential {
    /** Stable and non-secret: used as a rate-limit bucket key and written to logs. */
    readonly id: string;
    resolve(context: CredentialContext): Promise<ResolvedCredential> | ResolvedCredential;
}

/** Derives a stable, non-reversible id from secret material. */
function fingerprint(prefix: string, secret: string): string {
    return prefix + ":" + createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * A static Open Cloud API key, sent as x-api-key.
 *
 * @param key The API key.
 * @param options An explicit id, used for rate-limit bucketing and logs.
 * @returns A credential.
 */
export function apiKey(key: string, options: { id?: string } = {}): Credential {
    if (!key) throw new OpenCloudError("INVALID_ARGUMENT", "apiKey() requires a non-empty key.");
    const id = options.id ?? fingerprint("apiKey", key);
    return { id, resolve: () => ({ id, kind: "apiKey", value: key }) };
}

export interface RefreshedTokens {
    accessToken: string;
    /** Roblox rotates this on every refresh. Persist it or the next refresh fails. */
    refreshToken: string;
    expiresAt: Date;
    /** Space-delimited scopes Roblox granted. */
    scope: string;
}

export interface OAuthCredentialOptions {
    clientId: string;
    clientSecret: string;
    /** The current refresh token. Roblox invalidates it on every use. */
    refreshToken: string;
    /**
     * Called after each successful refresh with the rotated pair. Persist the refreshToken.
     * It is awaited before the triggering request is sent; a rejection is logged, not thrown.
     */
    onTokensRefreshed?: (tokens: RefreshedTokens) => void | Promise<void>;
    /** A known-good access token, to skip the first refresh. */
    accessToken?: string;
    accessTokenExpiresAt?: Date;
    /** Refresh this long before expiry. Default 60000. */
    skewMs?: number;
    id?: string;
}

/**
 * A Roblox OAuth 2.0 credential that refreshes and rotates its own tokens.
 *
 * @param options Client credentials, the current refresh token and a persistence callback.
 * @returns A credential.
 */
export function oauth(options: OAuthCredentialOptions): Credential {
    const { clientId, clientSecret, onTokensRefreshed, skewMs = 60_000 } = options;
    if (!clientId || !clientSecret) {
        throw new OpenCloudError("INVALID_ARGUMENT", "oauth() requires clientId and clientSecret.");
    }
    if (!options.refreshToken) {
        throw new OpenCloudError("INVALID_ARGUMENT", "oauth() requires a refreshToken.");
    }

    const id = options.id ?? fingerprint("oauth", clientId + ":" + options.refreshToken);
    let refreshToken = options.refreshToken;
    let accessToken = options.accessToken;
    let expiresAt = options.accessTokenExpiresAt;
    let inflight: Promise<string> | null = null;

    async function exchange(context: CredentialContext): Promise<string> {
        const form = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        }).toString();

        const response = await context.http({
            method: "POST",
            url: TOKEN_URL,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form,
            timeoutMs: 15_000,
            ...(context.signal ? { signal: context.signal } : {}),
        });

        if (response.status >= 400) throw oauthError(response.status, response.data);

        const data = (response.data ?? {}) as Record<string, unknown>;
        if (typeof data.access_token !== "string") {
            throw new OpenCloudError("AUTH_UNAVAILABLE", "Token refresh returned no access_token.", {
                status: response.status,
            });
        }

        // Updated before the callback runs, so a throwing callback cannot desync us from Roblox.
        accessToken = data.access_token;
        if (typeof data.refresh_token === "string") refreshToken = data.refresh_token;
        const lifetimeSeconds = typeof data.expires_in === "number" ? data.expires_in : 899;
        expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);

        if (onTokensRefreshed) {
            try {
                await onTokensRefreshed({
                    accessToken,
                    refreshToken,
                    expiresAt,
                    scope: typeof data.scope === "string" ? data.scope : "",
                });
            } catch (err: unknown) {
                context.logger.error(
                    { credentialId: id, err: (err as Error)?.message },
                    "onTokensRefreshed threw - the rotated refresh token may not have been persisted",
                );
            }
        }

        return accessToken;
    }

    return {
        id,
        async resolve(context: CredentialContext): Promise<ResolvedCredential> {
            if (accessToken && expiresAt && expiresAt.getTime() - Date.now() > skewMs) {
                return { id, kind: "bearer", value: accessToken };
            }
            // Single-flight: a refresh token is single-use, so two concurrent exchanges would
            // have one consume the token the other is about to send.
            inflight ??= exchange(context).finally(() => {
                inflight = null;
            });
            return { id, kind: "bearer", value: await inflight };
        },
    };
}

/** Classifies a token-endpoint failure. invalid_client is a 401, every other reason is a 400. */
function oauthError(status: number, data: unknown): OpenCloudError {
    const parsed = parseErrorBody(data);
    const reason = typeof parsed?.robloxCode === "string" ? parsed.robloxCode : undefined;
    const message = parsed?.message ?? "Token refresh failed with HTTP " + status + ".";

    if (reason === "invalid_grant") {
        return new OpenCloudError("AUTH_REVOKED", message, { status, robloxCode: reason });
    }
    if (reason === "invalid_client" || reason === "unsupported_grant_type" || reason === "invalid_request") {
        return new OpenCloudError("AUTH_MISCONFIGURED", message, { status, robloxCode: reason });
    }
    return new OpenCloudError("AUTH_UNAVAILABLE", message, { status, robloxCode: reason });
}

export interface PoolOptions {
    /** headroom prefers the member with the most observed remaining requests. Default headroom. */
    strategy?: "headroom" | "round-robin";
    id?: string;
}

/**
 * Spreads requests across several credentials. A pool is itself a credential, so pools nest.
 *
 * @param members The credentials to choose between. Must not be empty.
 * @param options Selection strategy and an explicit id.
 * @returns A credential.
 */
export function pool(members: Credential[], options: PoolOptions = {}): Credential {
    if (members.length === 0) {
        throw new OpenCloudError("INVALID_ARGUMENT", "pool() requires at least one credential.");
    }
    const id = options.id ?? "pool:" + members.map((m) => m.id).join(",");
    const strategy = options.strategy ?? "headroom";
    let cursor = 0;

    return {
        id,
        async resolve(context: CredentialContext): Promise<ResolvedCredential> {
            const ordered = strategy === "round-robin" ? rotate(members, cursor++) : byHeadroom(members, context);
            let lastError: unknown;

            for (const member of ordered) {
                try {
                    return await member.resolve(context);
                } catch (err: unknown) {
                    lastError = err;
                    // A transient failure is the pool's problem too, so it is not worked around.
                    if (err instanceof OpenCloudError && err.retryable) throw err;
                    context.logger.warn(
                        { poolId: id, memberId: member.id, err: (err as Error)?.message },
                        "pool member could not resolve - trying the next",
                    );
                }
            }
            throw lastError ?? new OpenCloudError("AUTH_UNAVAILABLE", "No pool member could resolve a credential.");
        },
    };
}

/** Returns the members reordered so that the one at offset comes first. */
function rotate(members: Credential[], offset: number): Credential[] {
    const start = offset % members.length;
    return [...members.slice(start), ...members.slice(0, start)];
}

/** Orders members by observed headroom, treating never-seen and expired windows as full. */
function byHeadroom(members: Credential[], context: CredentialContext): Credential[] {
    const now = Date.now();
    const score = (member: Credential): number => {
        const snapshot = context.headroom(member.id);
        if (!snapshot || snapshot.resetAt.getTime() <= now) return Number.POSITIVE_INFINITY;
        return snapshot.remaining;
    };
    return [...members].sort((a, b) => score(b) - score(a));
}

/**
 * Wraps a caller-supplied resolver, for platforms that mint tokens elsewhere.
 *
 * @param id A stable, non-secret id used for rate-limit bucketing and logs.
 * @param resolve Returns a bearer token string, or a full ResolvedCredential.
 * @returns A credential.
 */
export function custom(
    id: string,
    resolve: (context: CredentialContext) => Promise<ResolvedCredential | string> | ResolvedCredential | string,
): Credential {
    if (!id) throw new OpenCloudError("INVALID_ARGUMENT", "custom() requires an id.");
    return {
        id,
        async resolve(context: CredentialContext): Promise<ResolvedCredential> {
            const result = await resolve(context);
            return typeof result === "string" ? { id, kind: "bearer", value: result } : result;
        },
    };
}
