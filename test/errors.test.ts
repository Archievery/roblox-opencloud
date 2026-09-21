import { describe, it, expect } from "vitest";
import { OpenCloudError, errorFromResponse, parseErrorBody } from "../src/errors.js";
import { ingressAuthError, oauthInvalidClient, oauthInvalidGrant, rawThumbnailErrored, v2Error } from "./fixtures.js";

describe("parseErrorBody - the four envelopes Roblox actually uses", () => {
    it("reads the Open Cloud v2 envelope, whose code is a string enum", () => {
        const parsed = parseErrorBody(v2Error);
        expect(parsed).toMatchObject({ message: "You shall not pass.", robloxCode: "PERMISSION_DENIED", legacy: false });
        expect(parsed?.details).toEqual([{ reason: "nope" }]);
    });

    it("reads the legacy envelope the ingress uses, whose code is an integer", () => {
        const parsed = parseErrorBody(ingressAuthError);
        expect(parsed).toMatchObject({ message: "Invalid authentication data provided", robloxCode: 0, legacy: true });
    });

    it("reads the OAuth token endpoint envelope", () => {
        expect(parseErrorBody(oauthInvalidGrant)).toMatchObject({
            message: "Token is invalid",
            robloxCode: "invalid_grant",
        });
    });

    it("reads an operation-level failure, whose nested code is an integer", () => {
        expect(parseErrorBody(rawThumbnailErrored)).toMatchObject({
            message: "The user does not exist.",
            robloxCode: 3,
        });
    });

    it("returns null for a body that is not an error", () => {
        expect(parseErrorBody({ id: "1", name: "Builderman" })).toBeNull();
        expect(parseErrorBody(null)).toBeNull();
        expect(parseErrorBody("nope")).toBeNull();
    });
});

describe("errorFromResponse", () => {
    it("maps statuses onto codes", () => {
        const cases: Array<[number, string]> = [
            [400, "BAD_REQUEST"],
            [401, "UNAUTHORIZED"],
            [403, "FORBIDDEN"],
            [404, "NOT_FOUND"],
            [409, "CONFLICT"],
            [429, "RATE_LIMITED"],
            [500, "ROBLOX_ERROR"],
            [503, "ROBLOX_ERROR"],
        ];
        for (const [status, code] of cases) {
            expect(errorFromResponse(status, {}, "GetUser").code).toBe(code);
        }
    });

    it("reports a 403 carrying the legacy body as UNAUTHORIZED, keeping the real message", () => {
        // An unauthenticated /cloud/v2 call never reaches the v2 service: the ingress answers
        // 403 with the legacy shape, so treating it as FORBIDDEN hides a bad API key.
        const error = errorFromResponse(403, ingressAuthError, "GetGroup");
        expect(error.code).toBe("UNAUTHORIZED");
        expect(error.message).toBe("Invalid authentication data provided");
        expect(error.robloxCode).toBe(0);
    });

    it("keeps a genuine v2 403 as FORBIDDEN", () => {
        const error = errorFromResponse(403, v2Error, "AssignGroupRole");
        expect(error.code).toBe("FORBIDDEN");
        expect(error.message).toBe("You shall not pass.");
    });

    it("falls back to a status message when the body carries nothing useful", () => {
        expect(errorFromResponse(502, "<html>bad gateway</html>", "GetUser").message).toBe("Roblox returned HTTP 502.");
    });
});

describe("OpenCloudError.retryable", () => {
    it("is true only for failures where the same call could later succeed", () => {
        const retryable = ["AUTH_UNAVAILABLE", "RATE_LIMITED", "ROBLOX_ERROR", "TIMEOUT", "NETWORK"] as const;
        const terminal = [
            "NO_CREDENTIAL",
            "INVALID_ARGUMENT",
            "AUTH_REVOKED",
            "AUTH_MISCONFIGURED",
            "UNAUTHORIZED",
            "FORBIDDEN",
            "NOT_FOUND",
            "CONFLICT",
            "BAD_REQUEST",
            "ABORTED",
            "MALFORMED_RESPONSE",
        ] as const;

        for (const code of retryable) expect(new OpenCloudError(code, "x").retryable).toBe(true);
        for (const code of terminal) expect(new OpenCloudError(code, "x").retryable).toBe(false);
    });

    it("carries a cause and defaults its operation to request", () => {
        const cause = new Error("socket hang up");
        const error = new OpenCloudError("NETWORK", "boom", { cause });
        expect(error.cause).toBe(cause);
        expect(error.operation).toBe("request");
        expect(error.name).toBe("OpenCloudError");
        expect(error instanceof Error).toBe(true);
    });
});
