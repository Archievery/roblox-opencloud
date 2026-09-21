// Root entry. Must never import hono or ./server - those live behind the /server subpath.

export { OpenCloudClient } from "./client.js";
export type { ClientOptions, CallOptions, RequestOptions } from "./client.js";

export { apiKey, oauth, pool, custom } from "./auth.js";
export type {
    Credential,
    CredentialContext,
    ResolvedCredential,
    RateLimitSnapshot,
    OAuthCredentialOptions,
    RefreshedTokens,
    PoolOptions,
} from "./auth.js";

export { OpenCloudError } from "./errors.js";
export type { OpenCloudErrorCode, OpenCloudErrorOptions } from "./errors.js";

export type { Logger } from "./logger.js";
export type { HttpAdapter, RawRequest, RawResponse } from "./http.js";
export type { Timings } from "./queue.js";
export { DEFAULT_TIMINGS } from "./queue.js";

// defineOperation lets a consumer add an endpoint we do not cover yet and run it through
// client.call() with full typing, rather than forking the package.
export { defineOperation } from "./operations/define.js";
export type { OperationDef, RequestParts } from "./operations/define.js";

export {
    THUMBNAIL_SIZES,
    MAX_PAGE_SIZE_ROLES,
    MAX_PAGE_SIZE_MEMBERSHIPS,
    MAX_PAGE_SIZE_JOIN_REQUESTS,
    MAX_PAGE_SIZE_RESTRICTIONS,
} from "./operations/index.js";

export type {
    GetUserInput,
    GetUsersByUsernameInput,
    GenerateUserThumbnailInput,
    GetThumbnailOperationInput,
    GetGroupInput,
    GetGroupRoleInput,
    ListGroupRolesInput,
    ListGroupMembershipsInput,
    AssignGroupRoleInput,
    UnassignGroupRoleInput,
    ListJoinRequestsInput,
    JoinRequestActionInput,
    ListUserRestrictionsInput,
    GetUserRestrictionInput,
    SetUserRestrictionInput,
    ListUserRestrictionLogsInput,
    IdempotencyKey,
} from "./operations/index.js";

export type * from "./types.js";
