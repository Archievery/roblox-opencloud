import type { Credential } from "./auth.js";
import type { HttpAdapter } from "./http.js";
import { axiosAdapter } from "./http.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { RequestQueue } from "./queue.js";
import type { Timings } from "./queue.js";
import * as ops from "./operations/index.js";
import type { OperationDef } from "./operations/define.js";
import { prepare } from "./operations/define.js";
import { ROBLOX_API_HOST, buildUrl } from "./url.js";
import type { QueryValue } from "./url.js";
import type {
    Group,
    GroupJoinRequest,
    GroupMembership,
    GroupRole,
    HttpMethod,
    Page,
    RobloxUser,
    UserRestriction,
    UserRestrictionLog,
    UserThumbnail,
    UsernameLookup,
} from "./types.js";

const DEFAULT_USER_AGENT = "roblox-opencloud (+https://www.npmjs.com/package/@minecraft2fun/roblox-opencloud)";

export interface ClientOptions {
    /** Omit only if every call you make is to an endpoint Roblox serves anonymously. */
    credential?: Credential;
    /** Structurally compatible with pino and bunyan. Defaults to discarding every line. */
    logger?: Logger;
    /** Overrides the axios transport, for tests or a proxy agent. */
    http?: HttpAdapter;
    /** Poll, retry and timeout durations. */
    timings?: Partial<Timings>;
    /** Requests in flight at once. Default 8. */
    maxConcurrent?: number;
    userAgent?: string;
}

/** Per-call options accepted by every method. */
export interface CallOptions {
    signal?: AbortSignal;
}

/** Arguments for the generic escape hatch. */
export interface RequestOptions extends CallOptions {
    method: HttpMethod;
    /** An absolute URL, or a path resolved against https://apis.roblox.com. */
    url: string;
    /** Substituted into {braces} in `url`. */
    params?: Record<string, string | number>;
    query?: Record<string, QueryValue>;
    body?: unknown;
    /** Default `required`. */
    auth?: "required" | "none";
    /** Poll the returned Operation resource and resolve with its `response`. Default false. */
    longPoll?: boolean;
    /** Gates coalescing with an identical in-flight call. Defaults to method === GET. */
    idempotent?: boolean;
    contentType?: string;
}

/** A typed Roblox Open Cloud client sharing one queue, rate-limit view and credential. */
export class OpenCloudClient {
    private readonly queue: RequestQueue;

    constructor(options: ClientOptions = {}) {
        this.queue = new RequestQueue({
            http: options.http ?? axiosAdapter,
            logger: options.logger ?? noopLogger,
            ...(options.credential ? { credential: options.credential } : {}),
            ...(options.timings ? { timings: options.timings } : {}),
            ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
            userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
        });
    }

    /**
     * Runs any operation, including one you defined yourself with `defineOperation`.
     *
     * @param def The operation to run.
     * @param input Its arguments.
     * @param options Per-call options.
     * @returns The operation's transformed result.
     */
    call<TInput, TOutput>(def: OperationDef<TInput, TOutput>, input: TInput, options: CallOptions = {}): Promise<TOutput> {
        return this.queue.execute(prepare(def, input, options.signal));
    }

    /**
     * Walks every page of a paginated operation, following `nextPageToken` for you.
     *
     * @param def A paginated operation.
     * @param input Its arguments; `pageToken` is managed here.
     * @param options Per-call options.
     * @returns An async iterator over every item across every page.
     */
    async *paginate<TInput extends { pageToken?: string }, TItem>(
        def: OperationDef<TInput, Page<TItem>>,
        input: TInput,
        options: CallOptions = {},
    ): AsyncGenerator<TItem, void, undefined> {
        let pageToken: string | undefined;
        do {
            const page: Page<TItem> = await this.call(def, { ...input, pageToken }, options);
            for (const item of page.items) yield item;
            pageToken = page.nextPageToken;
        } while (pageToken);
    }

    // ── Users ───────────────────────────────────────────────────────────────

    /** Reads one user's public profile. */
    getUser(input: ops.GetUserInput, options?: CallOptions): Promise<RobloxUser> {
        return this.call(ops.getUser, input, options);
    }

    /** Resolves usernames to ids. Served anonymously by Roblox and rate-limited per source IP. */
    getUsersByUsername(input: ops.GetUsersByUsernameInput, options?: CallOptions): Promise<UsernameLookup[]> {
        return this.call(ops.getUsersByUsername, input, options);
    }

    /** Generates an avatar thumbnail, polling the resulting operation until it completes. */
    generateUserThumbnail(input: ops.GenerateUserThumbnailInput, options?: CallOptions): Promise<UserThumbnail> {
        return this.call(ops.generateUserThumbnail, input, options);
    }

    /** Resumes polling a thumbnail operation started earlier. */
    getThumbnailOperation(input: ops.GetThumbnailOperationInput, options?: CallOptions): Promise<UserThumbnail> {
        return this.call(ops.getThumbnailOperation, input, options);
    }

    // ── Groups ──────────────────────────────────────────────────────────────

    /** Reads a group. `ownerRobloxId` is null when the group has been abandoned. */
    getGroup(input: ops.GetGroupInput, options?: CallOptions): Promise<Group> {
        return this.call(ops.getGroup, input, options);
    }

    /** Reads one role without paging the whole list. */
    getGroupRole(input: ops.GetGroupRoleInput, options?: CallOptions): Promise<GroupRole> {
        return this.call(ops.getGroupRole, input, options);
    }

    /** Lists one page of roles. Roblox caps this at 20 per page - use `paginate` for all of them. */
    listGroupRoles(input: ops.ListGroupRolesInput, options?: CallOptions): Promise<Page<GroupRole>> {
        return this.call(ops.listGroupRoles, input, options);
    }

    /** Lists one page of memberships, optionally filtered to one user, many users, or one role. */
    listGroupMemberships(input: ops.ListGroupMembershipsInput, options?: CallOptions): Promise<Page<GroupMembership>> {
        return this.call(ops.listGroupMemberships, input, options);
    }

    /** Adds a role to a member. Roblox refuses any role at or above the credential's own rank. */
    assignGroupRole(input: ops.AssignGroupRoleInput, options?: CallOptions): Promise<GroupMembership> {
        return this.call(ops.assignGroupRole, input, options);
    }

    /** Removes one role from a member. */
    unassignGroupRole(input: ops.UnassignGroupRoleInput, options?: CallOptions): Promise<GroupMembership> {
        return this.call(ops.unassignGroupRole, input, options);
    }

    // ── Join requests ───────────────────────────────────────────────────────

    /** Lists one page of pending join requests. Roblox caps this at 20 per page. */
    listJoinRequests(input: ops.ListJoinRequestsInput, options?: CallOptions): Promise<Page<GroupJoinRequest>> {
        return this.call(ops.listJoinRequests, input, options);
    }

    /** Accepts a pending join request. */
    acceptJoinRequest(input: ops.JoinRequestActionInput, options?: CallOptions): Promise<void> {
        return this.call(ops.acceptJoinRequest, input, options);
    }

    /** Declines a pending join request. */
    declineJoinRequest(input: ops.JoinRequestActionInput, options?: CallOptions): Promise<void> {
        return this.call(ops.declineJoinRequest, input, options);
    }

    // ── User restrictions ───────────────────────────────────────────────────

    /** Lists everyone ever restricted in a universe, or in one of its places. */
    listUserRestrictions(input: ops.ListUserRestrictionsInput, options?: CallOptions): Promise<Page<UserRestriction>> {
        return this.call(ops.listUserRestrictions, input, options);
    }

    /** Reads one user's restriction. An unrestricted user reads back as `active: false`. */
    getUserRestriction(input: ops.GetUserRestrictionInput, options?: CallOptions): Promise<UserRestriction> {
        return this.call(ops.getUserRestriction, input, options);
    }

    /** Bans, edits or lifts a restriction. Lifting one is `restriction: { active: false }`. */
    setUserRestriction(input: ops.SetUserRestrictionInput, options?: CallOptions): Promise<UserRestriction> {
        return this.call(ops.setUserRestriction, input, options);
    }

    /** Lists restriction changes, including who made them. */
    listUserRestrictionLogs(
        input: ops.ListUserRestrictionLogsInput,
        options?: CallOptions,
    ): Promise<Page<UserRestrictionLog>> {
        return this.call(ops.listUserRestrictionLogs, input, options);
    }

    // ── Escape hatch ────────────────────────────────────────────────────────

    /**
     * Calls any Roblox endpoint through the same queue, credential and error handling.
     *
     * Use this for the legacy thumbnails.roblox.com and /legacy-groups/v1 surfaces, and for
     * anything Roblox ships before this package catches up.
     *
     * @param options The request to make.
     * @returns The parsed response body, typed by the caller.
     */
    request<T = unknown>(options: RequestOptions): Promise<T> {
        const url = buildUrl(ROBLOX_API_HOST, options.url, options.params ?? {}, options.query ?? {});
        return this.queue.execute<T>({
            operation: "request",
            method: options.method,
            url,
            ...(options.body === undefined ? {} : { body: options.body }),
            contentType: options.contentType ?? "application/json",
            auth: options.auth ?? "required",
            longPoll: options.longPoll ?? false,
            idempotent: options.idempotent ?? options.method === "GET",
            transform: (response) =>
                (options.longPoll ? (response.data as { response?: unknown })?.response : response.data) as T,
            ...(options.signal ? { signal: options.signal } : {}),
        });
    }
}
