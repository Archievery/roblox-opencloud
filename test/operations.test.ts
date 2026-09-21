import { describe, it, expect } from "vitest";
import { OpenCloudError } from "../src/errors.js";
import { prepare } from "../src/operations/define.js";
import * as ops from "../src/operations/index.js";
import { response } from "./helpers.js";
import {
    GROUP_ID,
    PLACE_ID,
    ROLE_ID,
    ROLE_ID_2,
    UNIVERSE_ID,
    USER_ID,
    rawGroup,
    rawGroupAbandoned,
    rawGroupMemberships,
    rawGroupRoles,
    rawGroupRolesPaged,
    rawJoinRequests,
    rawMembership,
    rawRestrictionLogs,
    rawThumbnailDone,
    rawUser,
    rawUserRestriction,
    rawUsersFromUsernames,
} from "./fixtures.js";

/** Decodes a query string, reversing the "+" that URLSearchParams writes for a space. */
function decodeQuery(url: string): string {
    return decodeURIComponent(url.replace(/\+/g, " "));
}

/** Runs an operation's transform the way the queue would. */
function transform<I, O>(def: ops.OperationDef<I, O>, data: unknown): O {
    return def.transform(data, response(data));
}

describe("users", () => {
    it("getUser maps the profile and keeps timestamps as ISO strings", () => {
        const user = transform(ops.getUser, rawUser);
        expect(user).toMatchObject({
            robloxId: USER_ID,
            username: "Builderman",
            displayName: "ROBLOX",
            about: "Welcome to Roblox!",
            createdAt: "2020-03-15T12:00:00Z",
            locale: "en-us",
            premium: true,
        });
        // A Date here would arrive as a string over the server's JSON boundary while the type
        // still claimed Date.
        expect(typeof user.createdAt).toBe("string");
    });

    it("getUser omits idVerified entirely when the credential lacks the scope", () => {
        expect("idVerified" in transform(ops.getUser, rawUser)).toBe(false);
        expect(transform(ops.getUser, { ...rawUser, idVerified: false }).idVerified).toBe(false);
    });

    it("getUsersByUsername maps rows and is anonymous", () => {
        expect(ops.getUsersByUsername.auth).toBe("none");
        const rows = transform(ops.getUsersByUsername, rawUsersFromUsernames);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({
            requestedUsername: "Builderman",
            robloxId: "1",
            username: "Builderman",
            displayName: "ROBLOX",
            hasVerifiedBadge: true,
        });
    });

    it("getUsersByUsername rejects a body with no data array", () => {
        expect(() => transform(ops.getUsersByUsername, { nope: true })).toThrow(OpenCloudError);
    });

    it("generateUserThumbnail defaults size, format and shape", () => {
        const prepared = prepare(ops.generateUserThumbnail, { userId: USER_ID });
        expect(prepared.url).toBe(
            `https://apis.roblox.com/cloud/v2/users/${USER_ID}:generateThumbnail?size=420&format=PNG&shape=ROUND`,
        );
        expect(prepared.longPoll).toBe(true);
    });

    it("generateUserThumbnail rejects a size Roblox does not support", () => {
        // The server is the only validator, so an unsupported size would otherwise fail late.
        expect(() => prepare(ops.generateUserThumbnail, { userId: USER_ID, size: 128 as never })).toThrow(
            /must be one of/,
        );
        expect(ops.THUMBNAIL_SIZES).toContain(420);
    });

    it("generateUserThumbnail reads the image url out of the completed operation", () => {
        expect(transform(ops.generateUserThumbnail, rawThumbnailDone)).toEqual({
            imageUrl: "https://tr.rbxcdn.com/abc.png",
        });
    });
});

describe("groups", () => {
    it("getGroup maps the group", () => {
        expect(transform(ops.getGroup, rawGroup)).toEqual({
            groupId: GROUP_ID,
            name: "Test Group",
            description: "A test group",
            ownerRobloxId: USER_ID,
            publicEntryAllowed: true,
            locked: false,
            verified: false,
            memberCount: 500,
            createdAt: "2019-06-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
        });
    });

    it("getGroup returns a null owner for an abandoned group instead of throwing", () => {
        // Roblox omits `owner` entirely once a group has no owner, so splitting it unguarded
        // is a TypeError on a perfectly valid response.
        expect(transform(ops.getGroup, rawGroupAbandoned).ownerRobloxId).toBeNull();
    });

    it("listGroupRoles maps roles and reports a next page only when there is one", () => {
        const page = transform(ops.listGroupRoles, rawGroupRoles);
        expect(page.items).toHaveLength(2);
        expect(page.items[0]).toMatchObject({ roleId: ROLE_ID, displayName: "Guest", rank: 0, description: "" });
        expect(page.nextPageToken).toBeUndefined();
        expect(transform(ops.listGroupRoles, rawGroupRolesPaged).nextPageToken).toBe("page-token-abc");
    });

    it("listGroupRoles refuses a page size above Roblox's cap of 20", () => {
        // Roblox clamps rather than rejects, so a request for 100 silently truncates to 20 and a
        // group with 21 roles loses one without any error.
        expect(() => prepare(ops.listGroupRoles, { groupId: GROUP_ID, maxPageSize: 100 })).toThrow(/between 1 and 20/);
        expect(ops.MAX_PAGE_SIZE_ROLES).toBe(20);
    });

    it("listGroupMemberships keeps every role, not just the highest", () => {
        // Roblox now supports multi-role memberships: `role` is only the top one.
        const page = transform(ops.listGroupMemberships, rawGroupMemberships);
        expect(page.items[0]).toMatchObject({ robloxId: USER_ID, roleId: ROLE_ID_2 });
        expect(page.items[0]?.roleIds).toEqual([ROLE_ID_2, ROLE_ID]);
    });

    it("listGroupMemberships falls back to the single role when Roblox omits the array", () => {
        const { roles: _roles, ...single } = rawGroupMemberships.groupMemberships[0] as Record<string, unknown>;
        const page = transform(ops.listGroupMemberships, { groupMemberships: [single] });
        expect(page.items[0]?.roleIds).toEqual([ROLE_ID_2]);
    });

    it("listGroupMemberships builds each supported filter form", () => {
        const one = prepare(ops.listGroupMemberships, { groupId: GROUP_ID, userId: USER_ID });
        expect(decodeQuery(one.url)).toContain(`filter=user == 'users/${USER_ID}'`);

        const many = prepare(ops.listGroupMemberships, { groupId: "-", userIds: [1, 2] });
        expect(decodeQuery(many.url)).toContain("filter=user in ['users/1', 'users/2']");

        const byRole = prepare(ops.listGroupMemberships, { groupId: GROUP_ID, roleId: ROLE_ID });
        expect(decodeQuery(byRole.url)).toContain(`filter=role == 'groups/${GROUP_ID}/roles/${ROLE_ID}'`);

        const none = prepare(ops.listGroupMemberships, { groupId: GROUP_ID });
        expect(none.url).not.toContain("filter");
    });

    it("listGroupMemberships caps a batched user filter at 50", () => {
        const userIds = Array.from({ length: 51 }, (_, i) => i);
        expect(() => prepare(ops.listGroupMemberships, { groupId: "-", userIds })).toThrow(/at most 50/);
    });

    it("assignGroupRole sends the role as a resource path and returns the membership", () => {
        const prepared = prepare(ops.assignGroupRole, { groupId: GROUP_ID, userId: USER_ID, roleId: ROLE_ID_2 });
        expect(prepared.url).toBe(
            `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships/${USER_ID}:assignRole`,
        );
        // This value is data, not a URL, and is the spelling a communities rename would break.
        expect(prepared.body).toEqual({ role: `groups/${GROUP_ID}/roles/${ROLE_ID_2}` });
        expect(prepared.idempotent).toBe(false);

        expect(transform(ops.assignGroupRole, rawMembership)).toMatchObject({
            robloxId: USER_ID,
            roleId: ROLE_ID_2,
            roleIds: [ROLE_ID_2],
        });
    });

    it("unassignGroupRole sends a role body, which Roblox now requires", () => {
        // With multi-role memberships the server must be told which role to remove; a bodyless
        // call will start failing once that is enforced everywhere.
        const prepared = prepare(ops.unassignGroupRole, { groupId: GROUP_ID, userId: USER_ID, roleId: ROLE_ID });
        expect(prepared.url).toBe(
            `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships/${USER_ID}:unassignRole`,
        );
        expect(prepared.body).toEqual({ role: `groups/${GROUP_ID}/roles/${ROLE_ID}` });
    });
});

describe("join requests", () => {
    it("listJoinRequests maps applicants", () => {
        const page = transform(ops.listJoinRequests, rawJoinRequests);
        expect(page.items).toEqual([{ robloxId: USER_ID, createdAt: "2024-05-01T00:00:00Z" }]);
    });

    it("listJoinRequests refuses a page size above Roblox's cap of 20", () => {
        expect(() => prepare(ops.listJoinRequests, { groupId: GROUP_ID, maxPageSize: 100 })).toThrow(/between 1 and 20/);
    });

    it("listJoinRequests supports only a user filter", () => {
        const prepared = prepare(ops.listJoinRequests, { groupId: GROUP_ID, userId: USER_ID });
        expect(decodeQuery(prepared.url)).toContain(`filter=user == 'users/${USER_ID}'`);
    });

    it("accept and decline send a literal empty body and tolerate an empty response", () => {
        for (const [def, verb] of [
            [ops.acceptJoinRequest, "accept"],
            [ops.declineJoinRequest, "decline"],
        ] as const) {
            const prepared = prepare(def, { groupId: GROUP_ID, userId: USER_ID });
            expect(prepared.url).toBe(
                `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/join-requests/${USER_ID}:${verb}`,
            );
            expect(prepared.body).toEqual({});
            expect(transform(def, "")).toBeUndefined();
        }
    });
});

describe("user restrictions", () => {
    it("listUserRestrictions addresses the universe, and the place when one is given", () => {
        expect(prepare(ops.listUserRestrictions, { universeId: UNIVERSE_ID }).url).toContain(
            `/cloud/v2/universes/${UNIVERSE_ID}/user-restrictions`,
        );
        expect(prepare(ops.listUserRestrictions, { universeId: UNIVERSE_ID, placeId: PLACE_ID }).url).toContain(
            `/cloud/v2/universes/${UNIVERSE_ID}/places/${PLACE_ID}/user-restrictions`,
        );
    });

    it("getUserRestriction parses the duration into seconds", () => {
        const restriction = transform(ops.getUserRestriction, rawUserRestriction);
        expect(restriction.robloxId).toBe(USER_ID);
        expect(restriction.gameJoinRestriction).toMatchObject({
            active: true,
            durationSeconds: 3600,
            privateReason: "exploiting",
            excludeAltAccounts: true,
            inherited: false,
        });
    });

    it("reads an absent duration as permanent", () => {
        const permanent = {
            ...rawUserRestriction,
            gameJoinRestriction: { ...rawUserRestriction.gameJoinRestriction, duration: undefined },
        };
        expect(transform(ops.getUserRestriction, permanent).gameJoinRestriction.durationSeconds).toBeNull();
    });

    it("setUserRestriction serializes a duration as a protobuf string", () => {
        const prepared = prepare(ops.setUserRestriction, {
            universeId: UNIVERSE_ID,
            userId: USER_ID,
            restriction: { active: true, durationSeconds: 3600, displayReason: "temp ban" },
        });
        expect(prepared.method).toBe("PATCH");
        expect(prepared.body).toEqual({
            gameJoinRestriction: { active: true, duration: "3600s", displayReason: "temp ban" },
        });
    });

    it("setUserRestriction omits duration entirely for a permanent ban", () => {
        // Roblox answers 400 to duration: -1. Permanent means leaving the field out, and the
        // typed input makes the -1 form unrepresentable.
        const prepared = prepare(ops.setUserRestriction, {
            universeId: UNIVERSE_ID,
            userId: USER_ID,
            restriction: { active: true, privateReason: "cheating" },
        });
        const body = prepared.body as { gameJoinRestriction: Record<string, unknown> };
        expect("duration" in body.gameJoinRestriction).toBe(false);
    });

    it("setUserRestriction rejects a negative or fractional duration locally", () => {
        for (const durationSeconds of [-1, 0, 1.5]) {
            expect(() =>
                prepare(ops.setUserRestriction, {
                    universeId: UNIVERSE_ID,
                    userId: USER_ID,
                    restriction: { active: true, durationSeconds },
                }),
            ).toThrow(/whole number of seconds/);
        }
    });

    it("setUserRestriction lifts a ban with active: false", () => {
        const prepared = prepare(ops.setUserRestriction, {
            universeId: UNIVERSE_ID,
            userId: USER_ID,
            restriction: { active: false },
        });
        expect(prepared.body).toEqual({ gameJoinRestriction: { active: false } });
    });

    it("setUserRestriction sends the idempotency key as two dotted query params", () => {
        const firstSent = new Date("2024-07-05T12:34:56.000Z");
        const prepared = prepare(ops.setUserRestriction, {
            universeId: UNIVERSE_ID,
            userId: USER_ID,
            restriction: { active: true },
            idempotencyKey: { key: "abc-123", firstSent },
        });
        // These are two flat query parameters containing a literal dot, not a nested object.
        expect(prepared.url).toContain("idempotencyKey.key=abc-123");
        expect(decodeQuery(prepared.url)).toContain("idempotencyKey.firstSent=2024-07-05T12:34:56.000Z");
    });

    it("listUserRestrictionLogs keeps the custom verb on the collection", () => {
        const prepared = prepare(ops.listUserRestrictionLogs, { universeId: UNIVERSE_ID });
        expect(prepared.url).toContain(`/cloud/v2/universes/${UNIVERSE_ID}/user-restrictions:listLogs`);
    });

    it("listUserRestrictionLogs joins its filter clauses with &&", () => {
        const prepared = prepare(ops.listUserRestrictionLogs, {
            universeId: UNIVERSE_ID,
            userId: USER_ID,
            placeId: PLACE_ID,
        });
        expect(decodeQuery(prepared.url)).toContain(
            `filter=user == 'users/${USER_ID}' && place == 'places/${PLACE_ID}'`,
        );
    });

    it("listUserRestrictionLogs distinguishes a script-made change from a moderator's", () => {
        const page = transform(ops.listUserRestrictionLogs, rawRestrictionLogs);
        expect(page.items[0]).toMatchObject({ robloxId: USER_ID, placeId: PLACE_ID, moderatorRobloxId: "42" });
        // A game-server script carries an empty-object marker and no user.
        expect(page.items[1]).toMatchObject({ robloxId: "99", moderatorRobloxId: null });
        expect("placeId" in (page.items[1] as object)).toBe(false);
    });
});

describe("defineOperation", () => {
    it("lets a consumer add an endpoint and run it through the same machinery", () => {
        const custom = ops.defineOperation<{ id: string }, { ok: boolean }>({
            name: "MyOperation",
            method: "GET",
            path: "/cloud/v2/whatever/{id}",
            build: (input) => ({ params: { id: input.id } }),
            transform: (data) => ({ ok: Boolean((data as { ok?: boolean }).ok) }),
        });

        const prepared = prepare(custom, { id: "7" });
        expect(prepared.url).toBe("https://apis.roblox.com/cloud/v2/whatever/7");
        expect(prepared.idempotent).toBe(true);
        expect(transform(custom, { ok: true })).toEqual({ ok: true });
    });
});
