// Canonical wire payloads. Each mirrors the exact shape Roblox sends, so the transforms are
// exercised against real data rather than something convenient.

export const USER_ID = "1234567890";
export const GROUP_ID = "9876543210";
export const ROLE_ID = "111";
export const ROLE_ID_2 = "222";
export const UNIVERSE_ID = "555";
export const PLACE_ID = "666";

export const rawUser = {
    path: `users/${USER_ID}`,
    createTime: "2020-03-15T12:00:00Z",
    id: USER_ID,
    name: "Builderman",
    displayName: "ROBLOX",
    about: "Welcome to Roblox!",
    locale: "en-us",
    premium: true,
};

export const rawUsersFromUsernames = {
    data: [
        { requestedUsername: "Builderman", hasVerifiedBadge: true, id: 1, name: "Builderman", displayName: "ROBLOX" },
        { requestedUsername: "Roblox", hasVerifiedBadge: false, id: 2, name: "Roblox", displayName: "Roblox" },
    ],
};

export const rawThumbnailPending = {
    path: `users/${USER_ID}/operations/thumb-op-123`,
    done: false,
};

export const rawThumbnailDone = {
    path: `users/${USER_ID}/operations/thumb-op-123`,
    done: true,
    response: { "@type": "apis.roblox.com/roblox.open_cloud.cloud.v2.GenerateUserThumbnailResponse", imageUri: "https://tr.rbxcdn.com/abc.png" },
};

export const rawThumbnailErrored = {
    path: `users/${USER_ID}/operations/thumb-op-123`,
    done: true,
    // Note `code` is an integer here, unlike the string enum a v2 HTTP error carries.
    error: { code: 3, message: "The user does not exist." },
};

export const rawGroup = {
    path: `groups/${GROUP_ID}`,
    createTime: "2019-06-01T00:00:00Z",
    updateTime: "2024-01-01T00:00:00Z",
    id: GROUP_ID,
    displayName: "Test Group",
    description: "A test group",
    owner: `users/${USER_ID}`,
    memberCount: 500,
    publicEntryAllowed: true,
    locked: false,
    verified: false,
};

/** Roblox omits `owner` entirely once a group has been abandoned. */
export const rawGroupAbandoned = (() => {
    const { owner: _owner, ...rest } = rawGroup;
    return rest;
})();

export const rawGroupRoles = {
    groupRoles: [
        {
            path: `groups/${GROUP_ID}/roles/${ROLE_ID}`,
            createTime: "2019-06-01T00:00:00Z",
            updateTime: "2019-06-01T00:00:00Z",
            id: ROLE_ID,
            displayName: "Guest",
            rank: 0,
            memberCount: 100,
        },
        {
            path: `groups/${GROUP_ID}/roles/${ROLE_ID_2}`,
            createTime: "2019-06-01T00:00:00Z",
            updateTime: "2019-06-01T00:00:00Z",
            id: ROLE_ID_2,
            displayName: "Member",
            description: "Full member",
            rank: 1,
            memberCount: 400,
        },
    ],
};

export const rawGroupRolesPaged = { ...rawGroupRoles, nextPageToken: "page-token-abc" };

export const rawGroupMemberships = {
    groupMemberships: [
        {
            path: `groups/${GROUP_ID}/memberships/m1`,
            createTime: "2021-01-01T00:00:00Z",
            updateTime: "2021-01-01T00:00:00Z",
            user: `users/${USER_ID}`,
            role: `groups/${GROUP_ID}/roles/${ROLE_ID_2}`,
            roles: [`groups/${GROUP_ID}/roles/${ROLE_ID_2}`, `groups/${GROUP_ID}/roles/${ROLE_ID}`],
        },
    ],
};

export const rawMembership = {
    path: `groups/${GROUP_ID}/memberships/m1`,
    createTime: "2021-01-01T00:00:00Z",
    updateTime: "2024-02-01T00:00:00Z",
    user: `users/${USER_ID}`,
    role: `groups/${GROUP_ID}/roles/${ROLE_ID_2}`,
    roles: [`groups/${GROUP_ID}/roles/${ROLE_ID_2}`],
};

export const rawJoinRequests = {
    groupJoinRequests: [
        { path: `groups/${GROUP_ID}/join-requests/${USER_ID}`, createTime: "2024-05-01T00:00:00Z", user: `users/${USER_ID}` },
    ],
};

export const rawUserRestriction = {
    path: `universes/${UNIVERSE_ID}/user-restrictions/${USER_ID}`,
    updateTime: "2024-07-05T12:34:56Z",
    user: `users/${USER_ID}`,
    gameJoinRestriction: {
        active: true,
        startTime: "2024-07-05T12:34:56Z",
        duration: "3600s",
        privateReason: "exploiting",
        displayReason: "You have been temporarily banned.",
        excludeAltAccounts: true,
        inherited: false,
    },
};

export const rawRestrictionLogs = {
    logs: [
        {
            user: `users/${USER_ID}`,
            place: `places/${PLACE_ID}`,
            moderator: { robloxUser: "users/42" },
            createTime: "2024-07-05T12:34:56Z",
            active: true,
            startTime: "2024-07-05T12:34:56Z",
            duration: "3600s",
            privateReason: "exploiting",
            displayReason: "banned",
            restrictionType: { gameJoinRestriction: {} },
            excludeAltAccounts: true,
        },
        {
            user: "users/99",
            // A universe-level change carries no place, and a script has no moderating user.
            moderator: { gameServerScript: {} },
            createTime: "2024-07-06T00:00:00Z",
            active: false,
            privateReason: "",
            displayReason: "",
            excludeAltAccounts: false,
        },
    ],
};

/** The Open Cloud v2 error envelope: `code` is a string enum. */
export const v2Error = { code: "PERMISSION_DENIED", message: "You shall not pass.", details: [{ reason: "nope" }] };

/** What the ingress returns for an unauthenticated /cloud/v2 call - a 403 with the legacy body. */
export const ingressAuthError = { errors: [{ code: 0, message: "Invalid authentication data provided" }] };

/** The OAuth token endpoint uses RFC 6749 shapes, unrelated to both of the above. */
export const oauthInvalidGrant = { error: "invalid_grant", error_description: "Token is invalid" };
export const oauthInvalidClient = { error: "invalid_client", error_description: "No authentication method is provided" };

export const oauthTokens = {
    access_token: "new-access-token",
    refresh_token: "rotated-refresh-token",
    token_type: "Bearer",
    expires_in: 899,
    scope: "group:read group:write",
};
