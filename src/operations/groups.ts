// Every path here says "groups", never "communities". Roblox renamed Groups to Communities in
// the web UI only; Open Cloud v2 still routes on /cloud/v2/groups and still names its resources
// groups/{id}/roles/{id}. Renaming any of it 404s every group call.

import { OpenCloudError } from "../errors.js";
import type { Group, GroupMembership, GroupRole, Page } from "../types.js";
import { asRecord, defineOperation, isoString, lastSegment, nextPageToken } from "./define.js";

/** Roblox clamps rather than rejects an oversized page, so these are enforced client-side. */
export const MAX_PAGE_SIZE_ROLES = 20;
export const MAX_PAGE_SIZE_MEMBERSHIPS = 100;

function assertPageSize(value: number | undefined, cap: number, field: string): void {
    if (value !== undefined && (value < 1 || value > cap)) {
        throw new OpenCloudError(
            "INVALID_ARGUMENT",
            `${field} must be between 1 and ${cap}; Roblox silently clamps larger values, which truncates the page.`,
        );
    }
}

function toRole(row: unknown): GroupRole {
    const r = asRecord(row);
    return {
        roleId: String(r.id ?? ""),
        displayName: String(r.displayName ?? ""),
        description: typeof r.description === "string" ? r.description : "",
        rank: Number(r.rank ?? 0),
        memberCount: Number(r.memberCount ?? 0),
        createdAt: isoString(r.createTime),
        updatedAt: isoString(r.updateTime),
    };
}

function toMembership(row: unknown): GroupMembership {
    const m = asRecord(row);
    // `role` is only the member's highest-ranked role; `roles` carries the full set.
    const roles = Array.isArray(m.roles) ? m.roles : [];
    return {
        robloxId: lastSegment(m.user, "user"),
        roleId: lastSegment(m.role, "role"),
        roleIds: roles.length > 0 ? roles.map((r) => lastSegment(r, "roles[]")) : [lastSegment(m.role, "role")],
        createdAt: isoString(m.createTime),
        updatedAt: isoString(m.updateTime),
    };
}

export interface GetGroupInput {
    groupId: string | number;
}

export const getGroup = defineOperation<GetGroupInput, Group>({
    name: "GetGroup",
    method: "GET",
    path: "/cloud/v2/groups/{groupId}",
    build: (input) => ({ params: { groupId: input.groupId } }),
    transform: (data) => {
        const d = asRecord(data);
        return {
            groupId: String(d.id ?? ""),
            name: String(d.displayName ?? ""),
            description: typeof d.description === "string" ? d.description : "",
            // Roblox omits `owner` entirely when a group has been abandoned.
            ownerRobloxId: typeof d.owner === "string" ? lastSegment(d.owner, "owner") : null,
            publicEntryAllowed: Boolean(d.publicEntryAllowed),
            locked: Boolean(d.locked),
            verified: Boolean(d.verified),
            memberCount: Number(d.memberCount ?? 0),
            createdAt: isoString(d.createTime),
            updatedAt: isoString(d.updateTime),
        };
    },
});

export interface GetGroupRoleInput {
    groupId: string | number;
    roleId: string | number;
}

export const getGroupRole = defineOperation<GetGroupRoleInput, GroupRole>({
    name: "GetGroupRole",
    method: "GET",
    path: "/cloud/v2/groups/{groupId}/roles/{roleId}",
    build: (input) => ({ params: { groupId: input.groupId, roleId: input.roleId } }),
    transform: (data) => toRole(data),
});

export interface ListGroupRolesInput {
    groupId: string | number;
    /** Maximum 20. Roblox clamps larger values, silently truncating the page. */
    maxPageSize?: number;
    pageToken?: string;
}

export const listGroupRoles = defineOperation<ListGroupRolesInput, Page<GroupRole>>({
    name: "ListGroupRoles",
    method: "GET",
    path: "/cloud/v2/groups/{groupId}/roles",
    build: (input) => {
        assertPageSize(input.maxPageSize, MAX_PAGE_SIZE_ROLES, "maxPageSize");
        return {
            params: { groupId: input.groupId },
            query: { maxPageSize: input.maxPageSize ?? MAX_PAGE_SIZE_ROLES, pageToken: input.pageToken },
        };
    },
    transform: (data) => {
        const d = asRecord(data);
        const rows = Array.isArray(d.groupRoles) ? d.groupRoles : [];
        return { items: rows.map(toRole), ...nextPageToken(d) };
    },
});

export interface ListGroupMembershipsInput {
    /** A group id, or "-" to search across every group the credential can see. */
    groupId: string | number;
    /** Maximum 100. */
    maxPageSize?: number;
    pageToken?: string;
    /** Restricts the listing to one user. */
    userId?: string | number;
    /** Restricts the listing to up to 50 users. Only valid with groupId "-". */
    userIds?: Array<string | number>;
    /** Restricts the listing to one role. */
    roleId?: string | number;
}

export const listGroupMemberships = defineOperation<ListGroupMembershipsInput, Page<GroupMembership>>({
    name: "ListGroupMemberships",
    method: "GET",
    path: "/cloud/v2/groups/{groupId}/memberships",
    build: (input) => {
        assertPageSize(input.maxPageSize, MAX_PAGE_SIZE_MEMBERSHIPS, "maxPageSize");
        return {
            params: { groupId: input.groupId },
            query: {
                maxPageSize: input.maxPageSize ?? 10,
                pageToken: input.pageToken,
                filter: membershipFilter(input),
            },
        };
    },
    transform: (data) => {
        const d = asRecord(data);
        const rows = Array.isArray(d.groupMemberships) ? d.groupMemberships : [];
        return { items: rows.map(toMembership), ...nextPageToken(d) };
    },
});

/** Builds the CEL filter Roblox accepts on memberships: `==` on user or role, or `in` on users. */
function membershipFilter(input: ListGroupMembershipsInput): string | undefined {
    if (input.userIds && input.userIds.length > 0) {
        if (input.userIds.length > 50) {
            throw new OpenCloudError("INVALID_ARGUMENT", "userIds accepts at most 50 ids.");
        }
        return `user in [${input.userIds.map((id) => `'users/${id}'`).join(", ")}]`;
    }
    if (input.userId !== undefined) return `user == 'users/${input.userId}'`;
    if (input.roleId !== undefined) return `role == 'groups/${input.groupId}/roles/${input.roleId}'`;
    return undefined;
}

export interface AssignGroupRoleInput {
    groupId: string | number;
    /** A user id may be used in place of a membership id. */
    userId: string | number;
    roleId: string | number;
}

export const assignGroupRole = defineOperation<AssignGroupRoleInput, GroupMembership>({
    name: "AssignGroupRole",
    method: "POST",
    path: "/cloud/v2/groups/{groupId}/memberships/{userId}:assignRole",
    build: (input) => ({
        params: { groupId: input.groupId, userId: input.userId },
        body: { role: `groups/${input.groupId}/roles/${input.roleId}` },
    }),
    transform: (data) => toMembership(data),
});

export interface UnassignGroupRoleInput {
    groupId: string | number;
    userId: string | number;
    /** Required: with multi-role memberships Roblox must be told which role to remove. */
    roleId: string | number;
}

export const unassignGroupRole = defineOperation<UnassignGroupRoleInput, GroupMembership>({
    name: "UnassignGroupRole",
    method: "POST",
    path: "/cloud/v2/groups/{groupId}/memberships/{userId}:unassignRole",
    build: (input) => ({
        params: { groupId: input.groupId, userId: input.userId },
        body: { role: `groups/${input.groupId}/roles/${input.roleId}` },
    }),
    transform: (data) => toMembership(data),
});
