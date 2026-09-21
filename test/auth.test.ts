import { describe, it, expect } from "vitest";
import { apiKey, custom, oauth, pool } from "../src/auth.js";
import type { CredentialContext, RateLimitSnapshot } from "../src/auth.js";
import { OpenCloudError } from "../src/errors.js";
import { oauthInvalidClient, oauthInvalidGrant, oauthTokens } from "./fixtures.js";
import { recordingLogger, response, stubHttp } from "./helpers.js";

function context(overrides: Partial<CredentialContext> = {}): CredentialContext {
    return {
        operation: "GetUser",
        attempt: 0,
        headroom: () => undefined,
        http: stubHttp().adapter,
        logger: recordingLogger(),
        ...overrides,
    };
}

describe("apiKey", () => {
    it("resolves to an x-api-key credential", async () => {
        const credential = apiKey("secret-key");
        expect(await credential.resolve(context())).toEqual({ id: credential.id, kind: "apiKey", value: "secret-key" });
    });

    it("derives a stable id that does not contain the key", () => {
        // The old implementation used key.slice(-8), putting live secret material into
        // rate-limit map keys and every debug log line.
        const id = apiKey("super-secret-api-key-value").id;
        expect(id).toBe(apiKey("super-secret-api-key-value").id);
        expect(id).not.toContain("value");
        expect(id).not.toContain("secret");
        expect(id.startsWith("apiKey:")).toBe(true);
        expect(apiKey("other").id).not.toBe(id);
    });

    it("rejects an empty key and accepts an explicit id", () => {
        expect(() => apiKey("")).toThrow(OpenCloudError);
        expect(apiKey("k", { id: "primary" }).id).toBe("primary");
    });
});

describe("oauth", () => {
    const base = { clientId: "client", clientSecret: "shh", refreshToken: "refresh-1" };

    it("exchanges the refresh token and returns a bearer credential", async () => {
        const http = stubHttp();
        http.push(response(oauthTokens));
        const credential = oauth(base);

        const resolved = await credential.resolve(context({ http: http.adapter }));

        expect(resolved).toEqual({ id: credential.id, kind: "bearer", value: "new-access-token" });
        expect(http.calls[0]?.url).toBe("https://apis.roblox.com/oauth/v1/token");
        expect(http.calls[0]?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
        expect(http.calls[0]?.body).toContain("grant_type=refresh_token");
        expect(http.calls[0]?.body).toContain("refresh_token=refresh-1");
    });

    it("hands the rotated refresh token to onTokensRefreshed", async () => {
        const http = stubHttp();
        http.push(response(oauthTokens));
        const seen: string[] = [];
        const credential = oauth({ ...base, onTokensRefreshed: (t) => void seen.push(t.refreshToken) });

        await credential.resolve(context({ http: http.adapter }));

        expect(seen).toEqual(["rotated-refresh-token"]);
    });

    it("reuses a cached access token instead of refreshing", async () => {
        const http = stubHttp();
        const credential = oauth({
            ...base,
            accessToken: "seeded",
            accessTokenExpiresAt: new Date(Date.now() + 600_000),
        });

        const resolved = await credential.resolve(context({ http: http.adapter }));

        expect(resolved.value).toBe("seeded");
        expect(http.calls).toHaveLength(0);
    });

    it("refreshes once its access token is inside the skew window", async () => {
        const http = stubHttp();
        http.push(response(oauthTokens));
        const credential = oauth({
            ...base,
            accessToken: "nearly-expired",
            accessTokenExpiresAt: new Date(Date.now() + 1_000),
            skewMs: 60_000,
        });

        expect((await credential.resolve(context({ http: http.adapter }))).value).toBe("new-access-token");
        expect(http.calls).toHaveLength(1);
    });

    it("performs exactly one exchange for many concurrent resolves", async () => {
        // A refresh token is single-use. Without single-flight, one of two concurrent exchanges
        // consumes the token the other is about to send and a healthy credential dies with
        // invalid_grant - which never reproduces under development traffic.
        const http = stubHttp();
        http.push(response(oauthTokens));
        const credential = oauth(base);
        const ctx = context({ http: http.adapter });

        const results = await Promise.all(Array.from({ length: 20 }, () => credential.resolve(ctx)));

        expect(http.calls).toHaveLength(1);
        expect(new Set(results.map((r) => r.value))).toEqual(new Set(["new-access-token"]));
    });

    it("refreshes again after a failure rather than latching the in-flight promise", async () => {
        const http = stubHttp();
        http.push(response({}, 503), response(oauthTokens));
        const credential = oauth(base);
        const ctx = context({ http: http.adapter });

        await expect(Promise.resolve(credential.resolve(ctx))).rejects.toThrow(OpenCloudError);
        expect((await credential.resolve(ctx)).value).toBe("new-access-token");
    });

    it("classifies invalid_grant as a revoked credential", async () => {
        const http = stubHttp();
        http.push(response(oauthInvalidGrant, 400));

        await expect(Promise.resolve(oauth(base).resolve(context({ http: http.adapter })))).rejects.toMatchObject({
            code: "AUTH_REVOKED",
            retryable: false,
        });
    });

    it("classifies invalid_client as misconfiguration, branching on the reason not the status", async () => {
        // invalid_client arrives as a 401 while every other OAuth failure is a 400, so branching
        // on status alone gets this wrong.
        const http = stubHttp();
        http.push(response(oauthInvalidClient, 401));

        await expect(Promise.resolve(oauth(base).resolve(context({ http: http.adapter })))).rejects.toMatchObject({
            code: "AUTH_MISCONFIGURED",
            retryable: false,
        });
    });

    it("classifies a 5xx and a missing access_token as transient", async () => {
        const serverError = stubHttp();
        serverError.push(response({}, 500));
        await expect(Promise.resolve(oauth(base).resolve(context({ http: serverError.adapter })))).rejects.toMatchObject({
            code: "AUTH_UNAVAILABLE",
            retryable: true,
        });

        const noToken = stubHttp();
        noToken.push(response({ token_type: "Bearer" }));
        await expect(Promise.resolve(oauth(base).resolve(context({ http: noToken.adapter })))).rejects.toMatchObject({
            code: "AUTH_UNAVAILABLE",
        });
    });

    it("does not fail the request when onTokensRefreshed throws, but logs it", async () => {
        const http = stubHttp();
        http.push(response(oauthTokens));
        const logger = recordingLogger();
        const credential = oauth({
            ...base,
            onTokensRefreshed: () => {
                throw new Error("disk full");
            },
        });

        const resolved = await credential.resolve(context({ http: http.adapter, logger }));

        expect(resolved.value).toBe("new-access-token");
        expect(logger.lines.some((l) => l.level === "error" && /persisted/.test(l.message))).toBe(true);
    });

    it("rejects incomplete options at construction", () => {
        expect(() => oauth({ ...base, clientId: "" })).toThrow(OpenCloudError);
        expect(() => oauth({ ...base, refreshToken: "" })).toThrow(OpenCloudError);
    });
});

describe("pool", () => {
    const snapshot = (remaining: number): RateLimitSnapshot => ({
        remaining,
        resetAt: new Date(Date.now() + 60_000),
    });

    it("returns the chosen member's id, not the pool's", async () => {
        // If rate limits bucket under the pool id, every member shares one bucket and the pool
        // becomes decorative.
        const a = apiKey("key-a", { id: "a" });
        const p = pool([a]);
        const resolved = await p.resolve(context());

        expect(resolved.id).toBe("a");
        expect(p.id).not.toBe("a");
    });

    it("prefers the member with the most observed headroom", async () => {
        const a = apiKey("key-a", { id: "a" });
        const b = apiKey("key-b", { id: "b" });
        const headroom = (id: string) => (id === "a" ? snapshot(2) : snapshot(90));

        expect((await pool([a, b]).resolve(context({ headroom }))).id).toBe("b");
    });

    it("treats a never-seen or expired credential as having full headroom", async () => {
        const a = apiKey("key-a", { id: "a" });
        const b = apiKey("key-b", { id: "b" });
        const headroom = (id: string) =>
            id === "a" ? snapshot(5) : { remaining: 0, resetAt: new Date(Date.now() - 1_000) };

        expect((await pool([a, b]).resolve(context({ headroom }))).id).toBe("b");
    });

    it("round-robins when asked to", async () => {
        const p = pool([apiKey("a", { id: "a" }), apiKey("b", { id: "b" })], { strategy: "round-robin" });
        const ctx = context();
        expect((await p.resolve(ctx)).id).toBe("a");
        expect((await p.resolve(ctx)).id).toBe("b");
        expect((await p.resolve(ctx)).id).toBe("a");
    });

    it("skips a member whose credential is permanently dead", async () => {
        const dead = custom("dead", () => {
            throw new OpenCloudError("AUTH_REVOKED", "gone");
        });
        const good = apiKey("key", { id: "good" });

        expect((await pool([dead, good], { strategy: "round-robin" }).resolve(context())).id).toBe("good");
    });

    it("propagates a transient failure rather than burning the rest of the pool on it", async () => {
        const flaky = custom("flaky", () => {
            throw new OpenCloudError("AUTH_UNAVAILABLE", "roblox is down");
        });
        const good = apiKey("key", { id: "good" });

        await expect(Promise.resolve(pool([flaky, good], { strategy: "round-robin" }).resolve(context()))).rejects.toMatchObject({
            code: "AUTH_UNAVAILABLE",
        });
    });

    it("rethrows when no member can resolve", async () => {
        const dead = custom("dead", () => {
            throw new OpenCloudError("AUTH_REVOKED", "gone");
        });
        await expect(Promise.resolve(pool([dead]).resolve(context()))).rejects.toMatchObject({ code: "AUTH_REVOKED" });
    });

    it("nests, because a pool is itself a credential", async () => {
        const inner = pool([apiKey("a", { id: "a" })]);
        const outer = pool([inner, apiKey("b", { id: "b" })], { strategy: "round-robin" });
        expect((await outer.resolve(context())).id).toBe("a");
    });

    it("rejects an empty member list at construction", () => {
        expect(() => pool([])).toThrow(OpenCloudError);
    });
});

describe("custom", () => {
    it("treats a returned string as a bearer token", async () => {
        const credential = custom("mine", () => "token-from-elsewhere");
        expect(await credential.resolve(context())).toEqual({ id: "mine", kind: "bearer", value: "token-from-elsewhere" });
    });

    it("passes a full ResolvedCredential through", async () => {
        const credential = custom("mine", () => ({ id: "mine", kind: "apiKey" as const, value: "k" }));
        expect((await credential.resolve(context())).kind).toBe("apiKey");
    });

    it("requires an id", () => {
        expect(() => custom("", () => "t")).toThrow(OpenCloudError);
    });
});
