import { OpenCloudError } from "./errors.js";

export const ROBLOX_API_HOST = "https://apis.roblox.com";
export const CLOUD_V2_BASE = `${ROBLOX_API_HOST}/cloud/v2/`;

/** Extracts the `{name}` placeholders out of a path template as a union of literal names. */
export type PathParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
    ? P | PathParams<Rest>
    : never;

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Substitutes `{name}` placeholders, percent-encoding every value.
 *
 * Only braces are placeholders. Roblox custom-method verbs are colon-suffixed
 * (`:assignRole`, `:accept`, `:listLogs`) and must survive untouched.
 *
 * @param template A path containing `{name}` placeholders.
 * @param params Values to substitute, keyed by placeholder name.
 * @returns The interpolated path.
 */
export function interpolate(template: string, params: Record<string, string | number> = {}): string {
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
        const value = params[name];
        if (value === undefined || value === null || value === "") {
            throw new OpenCloudError("INVALID_ARGUMENT", `Missing path parameter "${name}" for "${template}".`);
        }
        return encodeURIComponent(String(value));
    });
}

/**
 * Serializes a query object, dropping null and undefined entries.
 *
 * Keys are used verbatim, so dotted names such as `idempotencyKey.key` survive intact.
 *
 * @param query The query values to serialize.
 * @returns A query string without its leading `?`, or an empty string.
 */
export function buildQuery(query: Record<string, QueryValue> = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        params.append(key, String(value));
    }
    return params.toString();
}

/**
 * Builds a full request URL from a template, its parameters and a query object.
 *
 * @param base An absolute origin, or the template itself when it is already absolute.
 * @param template A path template, or an absolute URL.
 * @param params Path parameter values.
 * @param query Query values.
 * @returns The absolute URL to request.
 */
export function buildUrl(
    base: string,
    template: string,
    params: Record<string, string | number> = {},
    query: Record<string, QueryValue> = {},
): string {
    const path = interpolate(template, params);
    const url = new URL(path.startsWith("http") ? path : `${base.replace(/\/$/, "")}${path}`);
    const search = buildQuery(query);
    if (search) url.search = search;
    return url.toString();
}

/**
 * Resolves the relative `path` of a long-running Operation resource into a pollable URL.
 *
 * Roblox returns these without a leading slash and usually without a version segment, so
 * concatenating them onto an origin yields `https://apis.roblox.comusers/1/operations/x`.
 *
 * @param operationPath The `path` field of an Operation resource.
 * @returns An absolute URL to poll.
 */
export function resolveOperationUrl(operationPath: string): string {
    if (operationPath.startsWith("http")) return operationPath;
    const trimmed = operationPath.replace(/^\//, "");
    // A path that already carries its own version segment is joined to the origin instead.
    const base = /^(cloud\/v\d+|v\d+)\//.test(trimmed) ? `${ROBLOX_API_HOST}/` : CLOUD_V2_BASE;
    return new URL(trimmed, base).toString();
}

/**
 * Builds the key used to coalesce identical in-flight requests.
 *
 * The credential id is part of the key: without it two credentials hitting the same
 * resource collide, and for a write that silently drops one of them.
 *
 * @param parts The operation name, URL, body and resolving credential id.
 * @returns A stable key.
 */
export function cacheKey(parts: {
    operation: string;
    url: string;
    body?: unknown;
    credentialId: string;
}): string {
    const body = parts.body === undefined ? "" : JSON.stringify(parts.body);
    return [parts.operation, parts.url, body, parts.credentialId].join("\u0000");
}
