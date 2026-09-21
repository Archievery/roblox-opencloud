import { OpenCloudError } from "../errors.js";
import type { GroupJoinRequest, Page } from "../types.js";
import { asRecord, defineOperation, isoString, lastSegment, nextPageToken } from "./define.js";

/** Join-request listings cap at 20 per page, unlike memberships, which allow 100. */
export const MAX_PAGE_SIZE_JOIN_REQUESTS = 20;

export interface ListJoinRequestsInput {
    groupId: string | number;
    /** Maximum 20. Roblox clamps larger values, silently truncating the page. */
    maxPageSize?: number;
    pageToken?: string;
    /** Restricts the listing to one user. Roblox supports no other filter here. */
    userId?: string | number;
}

export const listJoinRequests = defineOperation<ListJoinRequestsInput, Page<GroupJoinRequest>>({
    name: "ListJoinRequests",
    method: "GET",
    path: "/cloud/v2/groups/{groupId}/join-requests",
    build: (input) => {
        if (input.maxPageSize !== undefined && (input.maxPageSize < 1 || input.maxPageSize > MAX_PAGE_SIZE_JOIN_REQUESTS)) {
            throw new OpenCloudError(
                "INVALID_ARGUMENT",
                `maxPageSize must be between 1 and ${MAX_PAGE_SIZE_JOIN_REQUESTS}; Roblox silently clamps larger values.`,
            );
        }
        return {
            params: { groupId: input.groupId },
            query: {
                maxPageSize: input.maxPageSize ?? MAX_PAGE_SIZE_JOIN_REQUESTS,
                pageToken: input.pageToken,
                filter: input.userId === undefined ? undefined : `user == 'users/${input.userId}'`,
            },
        };
    },
    transform: (data) => {
        const d = asRecord(data);
        const rows = Array.isArray(d.groupJoinRequests) ? d.groupJoinRequests : [];
        return {
            items: rows.map((row: unknown) => {
                const r = asRecord(row);
                return { robloxId: lastSegment(r.user, "user"), createdAt: isoString(r.createTime) };
            }),
            ...nextPageToken(d),
        };
    },
});

export interface JoinRequestActionInput {
    groupId: string | number;
    /** The pending applicant's user id. */
    userId: string | number;
}

// Both actions require a literal empty JSON body and answer 200 with no body at all.
const action = (name: string, verb: "accept" | "decline") =>
    defineOperation<JoinRequestActionInput, void>({
        name,
        method: "POST",
        path: `/cloud/v2/groups/{groupId}/join-requests/{userId}:${verb}`,
        build: (input) => ({ params: { groupId: input.groupId, userId: input.userId }, body: {} }),
        transform: () => undefined,
    });

export const acceptJoinRequest = action("AcceptJoinRequest", "accept");
export const declineJoinRequest = action("DeclineJoinRequest", "decline");
