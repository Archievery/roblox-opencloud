import axios from "axios";
import { OpenCloudError } from "./errors.js";

/**
 * A transport-agnostic response. Keeping axios behind this is what stops `AxiosResponse`
 * becoming part of the published type surface.
 */
export interface RawResponse {
    status: number;
    headers: Record<string, string>;
    data: unknown;
}

export interface RawRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    /** Already serialized by the caller, so the adapter never has to know a content type. */
    body?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

/** Sends one request and resolves for every HTTP status, throwing only on transport failure. */
export type HttpAdapter = (request: RawRequest) => Promise<RawResponse>;

function normalizeHeaders(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (typeof raw !== "object" || raw === null) return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number") out[key.toLowerCase()] = String(value);
    }
    return out;
}

/** The default transport: axios, with every status treated as a resolution. */
export const axiosAdapter: HttpAdapter = async (request) => {
    try {
        const response = await axios.request({
            url: request.url,
            method: request.method,
            headers: request.headers,
            data: request.body,
            timeout: request.timeoutMs,
            signal: request.signal,
            validateStatus: () => true,
            transformRequest: [(d) => d],
        });
        return {
            status: response.status,
            headers: normalizeHeaders(response.headers),
            data: response.data,
        };
    } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e?.code === "ERR_CANCELED" || e?.code === "ABORT_ERR") {
            throw new OpenCloudError("ABORTED", "The request was aborted.", { cause: err });
        }
        if (e?.code === "ECONNABORTED" || e?.code === "ETIMEDOUT") {
            throw new OpenCloudError("TIMEOUT", `Request timed out after ${request.timeoutMs}ms.`, { cause: err });
        }
        throw new OpenCloudError("NETWORK", e?.message ?? "Could not reach Roblox.", { cause: err });
    }
};
