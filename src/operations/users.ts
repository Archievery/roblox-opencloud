import { OpenCloudError } from "../errors.js";
import type {
    RobloxUser,
    ThumbnailFormat,
    ThumbnailShape,
    ThumbnailSize,
    UserThumbnail,
    UsernameLookup,
} from "../types.js";
import { asRecord, defineOperation, isoString } from "./define.js";

/** The sizes Roblox accepts for a generated thumbnail; anything else is rejected server-side. */
export const THUMBNAIL_SIZES: readonly ThumbnailSize[] = [48, 50, 60, 75, 100, 110, 150, 180, 352, 420, 720];

export interface GetUserInput {
    userId: string | number;
}

export const getUser = defineOperation<GetUserInput, RobloxUser>({
    name: "GetUser",
    method: "GET",
    path: "/cloud/v2/users/{userId}",
    build: (input) => ({ params: { userId: input.userId } }),
    transform: (data) => {
        const d = asRecord(data);
        return {
            robloxId: String(d.id ?? ""),
            username: String(d.name ?? ""),
            displayName: String(d.displayName ?? ""),
            about: typeof d.about === "string" ? d.about : "",
            createdAt: isoString(d.createTime),
            ...(typeof d.locale === "string" ? { locale: d.locale } : {}),
            ...(typeof d.premium === "boolean" ? { premium: d.premium } : {}),
            // Absent rather than false when the credential lacks user.advanced:read.
            ...("idVerified" in d ? { idVerified: Boolean(d.idVerified) } : {}),
        };
    },
});

export interface GetUsersByUsernameInput {
    usernames: string[];
    /** Omits users Roblox has banned. Default false. */
    excludeBannedUsers?: boolean;
}

// Open Cloud v2 has no username lookup, so this is the legacy users.roblox.com endpoint. It
// accepts neither an API key nor an OAuth token and is rate-limited per source IP, which means
// a credential pool cannot spread its load.
export const getUsersByUsername = defineOperation<GetUsersByUsernameInput, UsernameLookup[]>({
    name: "GetUsersByUsername",
    method: "POST",
    path: "https://users.roblox.com/v1/usernames/users",
    auth: "none",
    idempotent: true,
    build: (input) => ({
        body: {
            usernames: input.usernames,
            excludeBannedUsers: input.excludeBannedUsers ?? false,
        },
    }),
    transform: (data) => {
        const rows = asRecord(data).data;
        if (!Array.isArray(rows)) {
            throw new OpenCloudError("MALFORMED_RESPONSE", "Username lookup returned no data array.");
        }
        return rows.map((row: unknown) => {
            const r = asRecord(row);
            return {
                requestedUsername: String(r.requestedUsername ?? ""),
                robloxId: String(r.id ?? ""),
                username: String(r.name ?? ""),
                displayName: String(r.displayName ?? ""),
                hasVerifiedBadge: Boolean(r.hasVerifiedBadge),
            };
        });
    },
});

export interface GenerateUserThumbnailInput {
    userId: string | number;
    /** One of THUMBNAIL_SIZES. Default 420. */
    size?: ThumbnailSize;
    /** Default PNG. */
    format?: ThumbnailFormat;
    /** Default ROUND. */
    shape?: ThumbnailShape;
}

export const generateUserThumbnail = defineOperation<GenerateUserThumbnailInput, UserThumbnail>({
    name: "GenerateUserThumbnail",
    method: "GET",
    path: "/cloud/v2/users/{userId}:generateThumbnail",
    longPoll: true,
    idempotent: true,
    build: (input) => {
        if (input.size !== undefined && !THUMBNAIL_SIZES.includes(input.size)) {
            throw new OpenCloudError(
                "INVALID_ARGUMENT",
                `size must be one of ${THUMBNAIL_SIZES.join(", ")}; got ${input.size}.`,
            );
        }
        return {
            params: { userId: input.userId },
            query: {
                size: input.size ?? 420,
                format: input.format ?? "PNG",
                shape: input.shape ?? "ROUND",
            },
        };
    },
    transform: (data) => {
        const response = asRecord(asRecord(data).response);
        if (typeof response.imageUri !== "string") {
            throw new OpenCloudError("MALFORMED_RESPONSE", "The thumbnail operation carried no imageUri.");
        }
        return { imageUrl: response.imageUri };
    },
});

export interface GetThumbnailOperationInput {
    userId: string | number;
    operationId: string;
}

/** The explicit poll target for generateUserThumbnail, exposed so a long-poll can be resumed. */
export const getThumbnailOperation = defineOperation<GetThumbnailOperationInput, UserThumbnail>({
    name: "GetThumbnailOperation",
    method: "GET",
    path: "/cloud/v2/users/{userId}/operations/{operationId}",
    longPoll: true,
    build: (input) => ({ params: { userId: input.userId, operationId: input.operationId } }),
    transform: (data) => {
        const response = asRecord(asRecord(data).response);
        if (typeof response.imageUri !== "string") {
            throw new OpenCloudError("MALFORMED_RESPONSE", "The thumbnail operation carried no imageUri.");
        }
        return { imageUrl: response.imageUri };
    },
});
