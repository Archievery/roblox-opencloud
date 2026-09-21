import { OpenCloudError } from "../errors.js";
import type { Page, UserRestriction, UserRestrictionInput, UserRestrictionLog } from "../types.js";
import { asRecord, defineOperation, durationToSeconds, isoString, lastSegment, nextPageToken } from "./define.js";

export const MAX_PAGE_SIZE_RESTRICTIONS = 100;

/** Restrictions are scoped to a universe, and optionally narrowed to one place within it. */
interface UniverseScope {
    universeId: string | number;
    /** Narrows the call to a single place. A place-level unban cannot lift a universe-level ban. */
    placeId?: string | number;
}

/** Builds the universe- or place-scoped collection path. */
function collectionPath(scope: UniverseScope): string {
    return scope.placeId === undefined
        ? "/cloud/v2/universes/{universeId}/user-restrictions"
        : "/cloud/v2/universes/{universeId}/places/{placeId}/user-restrictions";
}

function scopeParams(scope: UniverseScope): Record<string, string | number> {
    return scope.placeId === undefined
        ? { universeId: scope.universeId }
        : { universeId: scope.universeId, placeId: scope.placeId };
}

function toRestriction(data: unknown): UserRestriction {
    const d = asRecord(data);
    const r = asRecord(d.gameJoinRestriction);
    return {
        robloxId: lastSegment(d.user, "user"),
        updatedAt: isoString(d.updateTime),
        gameJoinRestriction: {
            active: Boolean(r.active),
            ...(typeof r.startTime === "string" ? { startTime: r.startTime } : {}),
            durationSeconds: durationToSeconds(r.duration),
            privateReason: typeof r.privateReason === "string" ? r.privateReason : "",
            displayReason: typeof r.displayReason === "string" ? r.displayReason : "",
            excludeAltAccounts: Boolean(r.excludeAltAccounts),
            inherited: Boolean(r.inherited),
        },
    };
}

export interface ListUserRestrictionsInput extends UniverseScope {
    /** Maximum 100. */
    maxPageSize?: number;
    pageToken?: string;
}

export const listUserRestrictions = defineOperation<ListUserRestrictionsInput, Page<UserRestriction>>({
    name: "ListUserRestrictions",
    method: "GET",
    path: (input) => collectionPath(input),
    build: (input) => {
        if (input.maxPageSize !== undefined && (input.maxPageSize < 1 || input.maxPageSize > MAX_PAGE_SIZE_RESTRICTIONS)) {
            throw new OpenCloudError("INVALID_ARGUMENT", `maxPageSize must be between 1 and ${MAX_PAGE_SIZE_RESTRICTIONS}.`);
        }
        return {
            params: scopeParams(input),
            query: { maxPageSize: input.maxPageSize ?? 10, pageToken: input.pageToken },
        };
    },
    transform: (data) => {
        const d = asRecord(data);
        const rows = Array.isArray(d.userRestrictions) ? d.userRestrictions : [];
        return { items: rows.map(toRestriction), ...nextPageToken(d) };
    },
});

export interface GetUserRestrictionInput extends UniverseScope {
    /** The restriction id is the user's own id. */
    userId: string | number;
}

export const getUserRestriction = defineOperation<GetUserRestrictionInput, UserRestriction>({
    name: "GetUserRestriction",
    method: "GET",
    path: (input) => `${collectionPath(input)}/{userId}`,
    build: (input) => ({ params: { ...scopeParams(input), userId: input.userId } }),
    transform: (data) => toRestriction(data),
});

/** Replaying a write safely requires the same key AND the same firstSent as the original attempt. */
export interface IdempotencyKey {
    key: string;
    firstSent: Date;
}

export interface SetUserRestrictionInput extends UniverseScope {
    userId: string | number;
    restriction: UserRestrictionInput;
    idempotencyKey?: IdempotencyKey;
}

/**
 * Bans, edits or lifts a restriction. There is no create and no delete: this one PATCH does all
 * three, and lifting a ban is `{ active: false }`.
 */
export const setUserRestriction = defineOperation<SetUserRestrictionInput, UserRestriction>({
    name: "SetUserRestriction",
    method: "PATCH",
    path: (input) => `${collectionPath(input)}/{userId}`,
    build: (input) => {
        const { active, durationSeconds, privateReason, displayReason, excludeAltAccounts } = input.restriction;
        if (durationSeconds !== undefined && (!Number.isInteger(durationSeconds) || durationSeconds < 1)) {
            // Roblox rejects a negative or fractional duration with a 400; permanent means omitting it.
            throw new OpenCloudError(
                "INVALID_ARGUMENT",
                "durationSeconds must be a whole number of seconds >= 1. Omit it entirely for a permanent restriction.",
            );
        }
        return {
            params: { ...scopeParams(input), userId: input.userId },
            query: input.idempotencyKey
                ? {
                      "idempotencyKey.key": input.idempotencyKey.key,
                      "idempotencyKey.firstSent": input.idempotencyKey.firstSent.toISOString(),
                  }
                : {},
            body: {
                gameJoinRestriction: {
                    active,
                    ...(durationSeconds === undefined ? {} : { duration: `${durationSeconds}s` }),
                    ...(privateReason === undefined ? {} : { privateReason }),
                    ...(displayReason === undefined ? {} : { displayReason }),
                    ...(excludeAltAccounts === undefined ? {} : { excludeAltAccounts }),
                },
            },
        };
    },
    transform: (data) => toRestriction(data),
});

export interface ListUserRestrictionLogsInput {
    universeId: string | number;
    /** Maximum 100. */
    maxPageSize?: number;
    pageToken?: string;
    userId?: string | number;
    placeId?: string | number;
}

/** Note the custom verb hangs off the collection, not a resource id. */
export const listUserRestrictionLogs = defineOperation<ListUserRestrictionLogsInput, Page<UserRestrictionLog>>({
    name: "ListUserRestrictionLogs",
    method: "GET",
    path: "/cloud/v2/universes/{universeId}/user-restrictions:listLogs",
    build: (input) => {
        const clauses: string[] = [];
        if (input.userId !== undefined) clauses.push(`user == 'users/${input.userId}'`);
        if (input.placeId !== undefined) clauses.push(`place == 'places/${input.placeId}'`);
        return {
            params: { universeId: input.universeId },
            query: {
                maxPageSize: input.maxPageSize ?? 10,
                pageToken: input.pageToken,
                filter: clauses.length > 0 ? clauses.join(" && ") : undefined,
            },
        };
    },
    transform: (data) => {
        const d = asRecord(data);
        const rows = Array.isArray(d.logs) ? d.logs : [];
        return {
            items: rows.map((row: unknown): UserRestrictionLog => {
                const l = asRecord(row);
                const moderator = asRecord(l.moderator);
                return {
                    robloxId: lastSegment(l.user, "user"),
                    ...(typeof l.place === "string" && l.place !== ""
                        ? { placeId: lastSegment(l.place, "place") }
                        : {}),
                    // Absent when the change came from a game-server script rather than a person.
                    moderatorRobloxId:
                        typeof moderator.robloxUser === "string" ? lastSegment(moderator.robloxUser, "robloxUser") : null,
                    active: Boolean(l.active),
                    createdAt: isoString(l.createTime),
                    ...(typeof l.startTime === "string" ? { startTime: l.startTime } : {}),
                    durationSeconds: durationToSeconds(l.duration),
                    privateReason: typeof l.privateReason === "string" ? l.privateReason : "",
                    displayReason: typeof l.displayReason === "string" ? l.displayReason : "",
                    excludeAltAccounts: Boolean(l.excludeAltAccounts),
                };
            }),
            ...nextPageToken(d),
        };
    },
});
