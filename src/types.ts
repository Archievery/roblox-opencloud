// Public DTOs. Timestamps are ISO-8601 strings, never Date objects: these cross a JSON
// boundary when the optional server is used, and a Date would silently arrive as a string.

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** One page of a `maxPageSize` / `pageToken` paginated listing. */
export interface Page<T> {
    items: T[];
    /** Absent when there are no further pages. */
    nextPageToken?: string;
}

// ── Users ───────────────────────────────────────────────────────────────────

export interface RobloxUser {
    robloxId: string;
    username: string;
    displayName: string;
    about: string;
    /** ISO-8601. */
    createdAt: string;
    locale?: string;
    premium?: boolean;
    /** Present only when the credential holds `user.advanced:read`. */
    idVerified?: boolean;
}

export interface UsernameLookup {
    requestedUsername: string;
    robloxId: string;
    username: string;
    displayName: string;
    hasVerifiedBadge: boolean;
}

export interface UserThumbnail {
    imageUrl: string;
}

export type ThumbnailSize = 48 | 50 | 60 | 75 | 100 | 110 | 150 | 180 | 352 | 420 | 720;
export type ThumbnailFormat = "PNG" | "JPEG";
export type ThumbnailShape = "ROUND" | "SQUARE";

// ── Groups ──────────────────────────────────────────────────────────────────

export interface Group {
    groupId: string;
    name: string;
    description: string;
    /** Null when the group has been abandoned - Roblox omits `owner` entirely. */
    ownerRobloxId: string | null;
    publicEntryAllowed: boolean;
    locked: boolean;
    verified: boolean;
    memberCount: number;
    /** ISO-8601. */
    createdAt: string;
    /** ISO-8601. */
    updatedAt: string;
}

export interface GroupRole {
    roleId: string;
    displayName: string;
    description: string;
    /** 0-255, where 255 is the owner role. */
    rank: number;
    memberCount: number;
    /** ISO-8601. */
    createdAt: string;
    /** ISO-8601. */
    updatedAt: string;
}

export interface GroupMembership {
    robloxId: string;
    /** The member's highest-ranked role. */
    roleId: string;
    /** Every role the member holds - Roblox supports multi-role memberships. */
    roleIds: string[];
    /** ISO-8601. */
    createdAt: string;
    /** ISO-8601. */
    updatedAt: string;
}

export interface GroupJoinRequest {
    robloxId: string;
    /** ISO-8601. */
    createdAt: string;
}

// ── User restrictions ───────────────────────────────────────────────────────

export interface GameJoinRestriction {
    active: boolean;
    /** ISO-8601. */
    startTime?: string;
    /** Seconds, or null for a permanent restriction. */
    durationSeconds: number | null;
    privateReason: string;
    displayReason: string;
    excludeAltAccounts: boolean;
    /** True when the restriction is inherited from the universe rather than set on this place. */
    inherited: boolean;
}

export interface UserRestriction {
    robloxId: string;
    /** ISO-8601. */
    updatedAt: string;
    gameJoinRestriction: GameJoinRestriction;
}

export interface UserRestrictionLog {
    robloxId: string;
    /** Absent for a universe-level change. */
    placeId?: string;
    /** The moderating user, or null when the change came from a game-server script. */
    moderatorRobloxId: string | null;
    active: boolean;
    /** ISO-8601. */
    createdAt: string;
    /** ISO-8601. */
    startTime?: string;
    durationSeconds: number | null;
    privateReason: string;
    displayReason: string;
    excludeAltAccounts: boolean;
}

/** The writable half of a restriction. Read-only fields are deliberately absent. */
export interface UserRestrictionInput {
    active: boolean;
    /** Omit for a permanent restriction. Roblox rejects a negative duration with a 400. */
    durationSeconds?: number;
    /** Not shown to the restricted user. Max 1000 characters. */
    privateReason?: string;
    /** Shown to the restricted user. Max 400 characters. */
    displayReason?: string;
    excludeAltAccounts?: boolean;
}
