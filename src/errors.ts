/** Every failure this library throws is an OpenCloudError carrying one of these codes. */
export type OpenCloudErrorCode =
    // Raised locally, before any HTTP request is made.
    | "NO_CREDENTIAL"
    | "INVALID_ARGUMENT"
    // Raised while resolving a credential.
    | "AUTH_REVOKED"
    | "AUTH_MISCONFIGURED"
    | "AUTH_UNAVAILABLE"
    // Raised from a Roblox HTTP response.
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "BAD_REQUEST"
    | "RATE_LIMITED"
    | "ROBLOX_ERROR"
    // Raised by the transport or the queue.
    | "TIMEOUT"
    | "NETWORK"
    | "ABORTED"
    | "MALFORMED_RESPONSE";

const RETRYABLE: ReadonlySet<OpenCloudErrorCode> = new Set<OpenCloudErrorCode>([
    "AUTH_UNAVAILABLE",
    "RATE_LIMITED",
    "ROBLOX_ERROR",
    "TIMEOUT",
    "NETWORK",
]);

export interface OpenCloudErrorOptions {
    /** The operation that failed, or "request" for the generic escape hatch. */
    operation?: string;
    /** HTTP status, when a response was received. */
    status?: number;
    /** Roblox's own code: a v2 string enum, a legacy integer, or an OAuth `error` value. */
    robloxCode?: string | number;
    /** The `details` array a v2 error envelope carried, if any. */
    details?: unknown[];
    /** Overrides the default retryability implied by `code`. */
    retryable?: boolean;
    cause?: unknown;
}

/** The single error type thrown by every operation, the queue and every credential provider. */
export class OpenCloudError extends Error {
    override readonly name = "OpenCloudError";
    readonly code: OpenCloudErrorCode;
    readonly operation: string;
    readonly status: number | undefined;
    readonly robloxCode: string | number | undefined;
    readonly details: unknown[] | undefined;
    /** True when retrying the same call could plausibly succeed. */
    readonly retryable: boolean;

    constructor(code: OpenCloudErrorCode, message: string, options: OpenCloudErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.code = code;
        this.operation = options.operation ?? "request";
        this.status = options.status;
        this.robloxCode = options.robloxCode;
        this.details = options.details;
        this.retryable = options.retryable ?? RETRYABLE.has(code);
    }
}

/** A failure parsed out of one of Roblox's four error body shapes. */
export interface ParsedErrorBody {
    message?: string;
    robloxCode?: string | number;
    details?: unknown[];
    /** True for the legacy `{errors:[...]}` shape, which the ingress uses for auth failures. */
    legacy: boolean;
}

/**
 * Reads whichever of Roblox's four error envelopes a body happens to use.
 *
 * @param data A parsed response body, of unknown shape.
 * @returns The extracted message, code and details, or null when the body is not an error.
 */
export function parseErrorBody(data: unknown): ParsedErrorBody | null {
    if (typeof data !== "object" || data === null) return null;
    const d = data as Record<string, unknown>;

    // Legacy / ingress: {"errors":[{"code":0,"message":"Invalid authentication data provided"}]}
    if (Array.isArray(d.errors) && d.errors.length > 0) {
        const first = d.errors[0] as Record<string, unknown>;
        return {
            message: typeof first?.message === "string" ? first.message : undefined,
            robloxCode: typeof first?.code === "number" || typeof first?.code === "string" ? first.code : undefined,
            legacy: true,
        };
    }

    // OAuth token endpoint (RFC 6749): {"error":"invalid_grant","error_description":"..."}
    if (typeof d.error === "string") {
        return {
            message: typeof d.error_description === "string" ? d.error_description : d.error,
            robloxCode: d.error,
            legacy: false,
        };
    }

    // Open Cloud v2: {"code":"INVALID_ARGUMENT","message":"...","details":[...]}
    if (typeof d.message === "string" && (typeof d.code === "string" || typeof d.code === "number")) {
        return {
            message: d.message,
            robloxCode: d.code,
            details: Array.isArray(d.details) ? d.details : undefined,
            legacy: false,
        };
    }

    // Operation-level: {"done":true,"error":{"code":3,"message":"..."}} - note `code` is an integer here.
    if (typeof d.error === "object" && d.error !== null) {
        const e = d.error as Record<string, unknown>;
        if (typeof e.message === "string") {
            return {
                message: e.message,
                robloxCode: typeof e.code === "number" || typeof e.code === "string" ? e.code : undefined,
                details: Array.isArray(e.details) ? e.details : undefined,
                legacy: false,
            };
        }
    }

    return null;
}

const STATUS_CODES: Readonly<Record<number, OpenCloudErrorCode>> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    429: "RATE_LIMITED",
};

/**
 * Builds an OpenCloudError from a non-success HTTP response.
 *
 * A 403 carrying the legacy `{errors:[...]}` body is reported as UNAUTHORIZED, not FORBIDDEN:
 * an unauthenticated /cloud/v2 call never reaches the v2 service and the ingress answers 403.
 *
 * @param status The HTTP status code.
 * @param data The parsed response body.
 * @param operation The operation name, for the error's `operation` field.
 * @returns The error to throw.
 */
export function errorFromResponse(status: number, data: unknown, operation: string): OpenCloudError {
    const parsed = parseErrorBody(data);
    const mapped: OpenCloudErrorCode = STATUS_CODES[status] ?? "ROBLOX_ERROR";
    const code: OpenCloudErrorCode = status === 403 && parsed?.legacy ? "UNAUTHORIZED" : mapped;

    return new OpenCloudError(code, parsed?.message ?? `Roblox returned HTTP ${status}.`, {
        operation,
        status,
        robloxCode: parsed?.robloxCode,
        details: parsed?.details,
    });
}
