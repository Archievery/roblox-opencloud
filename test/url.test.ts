import { describe, it, expect } from "vitest";
import { OpenCloudError } from "../src/errors.js";
import { ROBLOX_API_HOST, buildQuery, buildUrl, cacheKey, interpolate, resolveOperationUrl } from "../src/url.js";

describe("interpolate", () => {
    it("substitutes brace placeholders", () => {
        expect(interpolate("/cloud/v2/groups/{groupId}/roles/{roleId}", { groupId: 7, roleId: "99" })).toBe(
            "/cloud/v2/groups/7/roles/99",
        );
    });

    it("leaves every Roblox custom-method verb intact", () => {
        // Colons are routing characters, not placeholders. A `/:(\w+)/g` interpolator would eat
        // all six of these and 404 every one of those calls.
        const cases: Array<[string, Record<string, string | number>, string]> = [
            ["/cloud/v2/users/{userId}:generateThumbnail", { userId: 1 }, "/cloud/v2/users/1:generateThumbnail"],
            [
                "/cloud/v2/groups/{groupId}/memberships/{userId}:assignRole",
                { groupId: 7, userId: 1 },
                "/cloud/v2/groups/7/memberships/1:assignRole",
            ],
            [
                "/cloud/v2/groups/{groupId}/memberships/{userId}:unassignRole",
                { groupId: 7, userId: 1 },
                "/cloud/v2/groups/7/memberships/1:unassignRole",
            ],
            [
                "/cloud/v2/groups/{groupId}/join-requests/{userId}:accept",
                { groupId: 7, userId: 1 },
                "/cloud/v2/groups/7/join-requests/1:accept",
            ],
            [
                "/cloud/v2/groups/{groupId}/join-requests/{userId}:decline",
                { groupId: 7, userId: 1 },
                "/cloud/v2/groups/7/join-requests/1:decline",
            ],
            // This one hangs off a collection rather than a resource id - the shape most likely
            // to break a naive interpolator.
            [
                "/cloud/v2/universes/{universeId}/user-restrictions:listLogs",
                { universeId: 5 },
                "/cloud/v2/universes/5/user-restrictions:listLogs",
            ],
        ];
        for (const [template, params, expected] of cases) {
            expect(interpolate(template, params)).toBe(expected);
        }
    });

    it("percent-encodes values so an id cannot inject path segments", () => {
        expect(interpolate("/cloud/v2/users/{userId}", { userId: "1/../groups/7" })).toBe(
            "/cloud/v2/users/1%2F..%2Fgroups%2F7",
        );
    });

    it("throws on a missing parameter rather than emitting a literal placeholder", () => {
        expect(() => interpolate("/cloud/v2/groups/{groupId}", {})).toThrow(OpenCloudError);
        expect(() => interpolate("/cloud/v2/groups/{groupId}", {})).toThrow(/groupId/);
    });
});

describe("buildQuery", () => {
    it("drops null and undefined but keeps false and zero", () => {
        expect(buildQuery({ a: 1, b: undefined, c: null, d: false, e: 0 })).toBe("a=1&d=false&e=0");
    });

    it("keeps dotted keys verbatim, which the idempotency key depends on", () => {
        const query = buildQuery({ "idempotencyKey.key": "abc", "idempotencyKey.firstSent": "2024-07-05T12:34:56.000Z" });
        expect(query).toContain("idempotencyKey.key=abc");
        expect(query).toContain("idempotencyKey.firstSent=2024-07-05T12%3A34%3A56.000Z");
    });
});

describe("buildUrl", () => {
    it("joins a template onto the host", () => {
        expect(buildUrl(ROBLOX_API_HOST, "/cloud/v2/users/{userId}", { userId: 1 })).toBe(
            "https://apis.roblox.com/cloud/v2/users/1",
        );
    });

    it("uses an absolute template as-is", () => {
        expect(buildUrl(ROBLOX_API_HOST, "https://users.roblox.com/v1/usernames/users")).toBe(
            "https://users.roblox.com/v1/usernames/users",
        );
    });

    it("appends the query string", () => {
        expect(buildUrl(ROBLOX_API_HOST, "/cloud/v2/groups/{groupId}/roles", { groupId: 7 }, { maxPageSize: 20 })).toBe(
            "https://apis.roblox.com/cloud/v2/groups/7/roles?maxPageSize=20",
        );
    });

    it("preserves the custom verb through a full build", () => {
        expect(buildUrl(ROBLOX_API_HOST, "/cloud/v2/users/{userId}:generateThumbnail", { userId: 1 }, { size: 420 })).toBe(
            "https://apis.roblox.com/cloud/v2/users/1:generateThumbnail?size=420",
        );
    });
});

describe("resolveOperationUrl", () => {
    it("joins a bare operation path under /cloud/v2/", () => {
        // Roblox returns this with no leading slash and no version segment. Concatenating it onto
        // the origin produces https://apis.roblox.comusers/... - a URL that cannot resolve.
        expect(resolveOperationUrl("users/123/operations/xyz")).toBe(
            "https://apis.roblox.com/cloud/v2/users/123/operations/xyz",
        );
    });

    it("does not double-prefix a path that already carries a version segment", () => {
        expect(resolveOperationUrl("v1/assets/12345/operation/xyz")).toBe(
            "https://apis.roblox.com/v1/assets/12345/operation/xyz",
        );
        expect(resolveOperationUrl("cloud/v2/users/1/operations/xyz")).toBe(
            "https://apis.roblox.com/cloud/v2/users/1/operations/xyz",
        );
    });

    it("tolerates a leading slash and passes an absolute URL through", () => {
        expect(resolveOperationUrl("/users/1/operations/x")).toBe("https://apis.roblox.com/cloud/v2/users/1/operations/x");
        expect(resolveOperationUrl("https://apis.roblox.com/cloud/v2/x")).toBe("https://apis.roblox.com/cloud/v2/x");
    });
});

describe("cacheKey", () => {
    it("is stable for identical requests and differs on any part", () => {
        const base = { operation: "GetUser", url: "https://x/1", body: undefined, credentialId: "a" };
        expect(cacheKey(base)).toBe(cacheKey({ ...base }));
        expect(cacheKey(base)).not.toBe(cacheKey({ ...base, url: "https://x/2" }));
        expect(cacheKey(base)).not.toBe(cacheKey({ ...base, operation: "GetGroup" }));
        expect(cacheKey(base)).not.toBe(cacheKey({ ...base, body: { a: 1 } }));
    });

    it("includes the credential, so two credentials never collide on one resource", () => {
        const base = { operation: "GetUser", url: "https://x/1", credentialId: "a" };
        expect(cacheKey(base)).not.toBe(cacheKey({ ...base, credentialId: "b" }));
    });
});
