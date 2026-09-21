import { OpenCloudError } from "../errors.js";
import type { RawResponse } from "../http.js";
import type { PreparedRequest } from "../queue.js";
import type { HttpMethod } from "../types.js";
import { ROBLOX_API_HOST, buildUrl } from "../url.js";
import type { QueryValue } from "../url.js";

/** What an operation contributes to the outgoing request for a given input. */
export interface RequestParts {
    params?: Record<string, string | number>;
    query?: Record<string, QueryValue>;
    body?: unknown;
}

/** One Open Cloud endpoint: how to address it, and how to read what comes back. */
export interface OperationDef<TInput, TOutput> {
    name: string;
    method: HttpMethod;
    /** A path template using {braces}, or a function of the input when the shape varies.
     *  Colons are Roblox custom-method verbs, never placeholders. */
    path: string | ((input: TInput) => string);
    /** Origin to resolve the path against. Defaults to https://apis.roblox.com. */
    host?: string;
    /** `none` skips credential resolution, for Roblox's anonymous endpoints. Default `required`. */
    auth?: "required" | "none";
    /** True when Roblox answers with an Operation resource that must be polled. */
    longPoll?: boolean;
    /** Whether an identical in-flight call may be coalesced. Defaults to method === GET. */
    idempotent?: boolean;
    contentType?: string;
    /** Turns the caller's input into path params, query values and a request body. */
    build: (input: TInput) => RequestParts;
    /** Pure transform from the raw response into the public DTO. */
    transform: (data: unknown, response: RawResponse) => TOutput;
}

/** Identity helper that infers an operation's input and output types from its literal. */
export function defineOperation<TInput, TOutput>(def: OperationDef<TInput, TOutput>): OperationDef<TInput, TOutput> {
    return def;
}

/**
 * Resolves an operation and its input into a request the queue can run.
 *
 * @param def The operation definition.
 * @param input The caller's arguments.
 * @param signal An optional abort signal.
 * @returns A prepared request.
 */
export function prepare<TInput, TOutput>(
    def: OperationDef<TInput, TOutput>,
    input: TInput,
    signal?: AbortSignal,
): PreparedRequest<TOutput> {
    const parts = def.build(input);
    const path = typeof def.path === "function" ? def.path(input) : def.path;
    return {
        operation: def.name,
        method: def.method,
        url: buildUrl(def.host ?? ROBLOX_API_HOST, path, parts.params ?? {}, parts.query ?? {}),
        ...(parts.body === undefined ? {} : { body: parts.body }),
        contentType: def.contentType ?? "application/json",
        auth: def.auth ?? "required",
        longPoll: def.longPoll ?? false,
        idempotent: def.idempotent ?? def.method === "GET",
        transform: (response) => def.transform(response.data, response),
        ...(signal ? { signal } : {}),
    };
}

/** Returns the id at the end of a Roblox resource name such as `groups/7/roles/99`. */
export function lastSegment(resourceName: unknown, field: string): string {
    if (typeof resourceName !== "string" || resourceName.length === 0) {
        throw new OpenCloudError("MALFORMED_RESPONSE", `Expected a resource name in "${field}".`);
    }
    const segments = resourceName.split("/");
    return segments[segments.length - 1] as string;
}

/** Reads a protobuf Duration such as "3600s". Returns null for an absent or permanent duration. */
export function durationToSeconds(value: unknown): number | null {
    if (typeof value !== "string" || value === "") return null;
    const seconds = Number(value.replace(/s$/, ""));
    return Number.isFinite(seconds) ? seconds : null;
}

/** Reads an ISO-8601 timestamp, tolerating Roblox omitting it. */
export function isoString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Narrows a response body to a plain object so field reads are safe. */
export function asRecord(data: unknown): Record<string, unknown> {
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/** Reads a paginated listing's `nextPageToken`, which Roblox omits on the final page. */
export function nextPageToken(data: Record<string, unknown>): { nextPageToken?: string } {
    return typeof data.nextPageToken === "string" && data.nextPageToken !== ""
        ? { nextPageToken: data.nextPageToken }
        : {};
}
