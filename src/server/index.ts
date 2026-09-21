import { Hono } from "hono";
import type { Credential } from "../auth.js";
import { OpenCloudClient } from "../client.js";
import type { ClientOptions } from "../client.js";
import { OpenCloudError } from "../errors.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import * as ops from "../operations/index.js";
import type { OperationDef } from "../operations/define.js";
import { JobStore } from "./jobStore.js";

export { JobStore } from "./jobStore.js";
export type { Job, JobStatus, JobError } from "./jobStore.js";

/** Recognises an operation definition so the route table can be derived rather than written. */
function isOperationDef(value: unknown): value is OperationDef<unknown, unknown> {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.name === "string" && typeof v.build === "function" && typeof v.transform === "function";
}

// Derived from the operations module, so adding an operation needs no edit here.
const OPERATIONS: ReadonlyMap<string, OperationDef<unknown, unknown>> = new Map(
    Object.values(ops)
        .filter(isOperationDef)
        .map((def) => [def.name, def]),
);

/** Every operation this server will dispatch, for a consumer building its own allowlist. */
export const SUPPORTED_OPERATIONS: readonly string[] = [...OPERATIONS.keys()].sort();

export interface ServerOptions {
    /**
     * Credentials addressable by name. A request names one; raw keys never cross the wire.
     */
    credentials: Record<string, Credential>;
    /** Used when a request omits `credential`. */
    defaultCredential?: string;
    /** Shared secret required as `Authorization: Bearer <token>`. Omitting it logs a warning. */
    authToken?: string;
    logger?: Logger;
    /** Applied to every client this server builds. */
    client?: Pick<ClientOptions, "timings" | "maxConcurrent" | "userAgent" | "http">;
    /** How long a finished job is retained. Default 300000. */
    jobTtlMs?: number;
}

export interface OpenCloudServer {
    app: Hono;
    /** Stops the job store's sweep timer. */
    close(): void;
}

/**
 * Builds a Hono app exposing the client over HTTP, for sharing one queue across services.
 *
 * It returns the app rather than binding a port, because the runtime is the caller's choice.
 *
 * @param options Named credentials, an optional shared secret and client settings.
 * @returns The app and a close function.
 */
export function createServer(options: ServerOptions): OpenCloudServer {
    const logger = options.logger ?? noopLogger;
    const names = Object.keys(options.credentials);
    if (names.length === 0) throw new Error("createServer() requires at least one credential.");
    if (!options.authToken) {
        logger.warn({}, "createServer() has no authToken - anyone who can reach this port can spend your credentials");
    }
    if (options.defaultCredential && !options.credentials[options.defaultCredential]) {
        throw new Error(`defaultCredential "${options.defaultCredential}" is not present in credentials.`);
    }

    const jobs = new JobStore(options.jobTtlMs ?? 300_000);
    const clients = new Map<string, OpenCloudClient>(
        names.map((name) => [
            name,
            new OpenCloudClient({
                ...options.client,
                credential: options.credentials[name] as Credential,
                logger,
            }),
        ]),
    );

    const app = new Hono();

    app.use("*", async (c, next) => {
        if (!options.authToken || c.req.path === "/health") return next();
        if (c.req.header("authorization") !== `Bearer ${options.authToken}`) {
            return c.json({ error: "Unauthorized." }, 401);
        }
        return next();
    });

    app.get("/health", (c) => c.json({ status: "ok", operations: SUPPORTED_OPERATIONS.length }));

    app.post("/request", async (c) => {
        let body: { operation?: string; input?: unknown; credential?: string };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: "Invalid JSON body." }, 400);
        }

        const def = body.operation ? OPERATIONS.get(body.operation) : undefined;
        if (!def) return c.json({ error: `Unknown operation "${body.operation ?? ""}".` }, 400);

        const name = body.credential ?? options.defaultCredential;
        if (!name) return c.json({ error: "No credential named, and no defaultCredential is configured." }, 400);
        const client = clients.get(name);
        if (!client) return c.json({ error: `Unknown credential "${name}".` }, 400);

        const id = jobs.create();
        jobs.markRunning(id);

        void client
            .call(def, body.input)
            .then((data) => jobs.complete(id, data))
            .catch((err: unknown) => {
                const error =
                    err instanceof OpenCloudError
                        ? { code: err.code, message: err.message }
                        : { code: "INTERNAL", message: (err as Error)?.message ?? "Unknown error." };
                logger.warn({ jobId: id, operation: def.name, ...error }, "job failed");
                jobs.fail(id, error);
            });

        return c.json({ id }, 202);
    });

    app.get("/jobs/:id", async (c) => {
        const id = c.req.param("id");
        if (!jobs.get(id)) return c.json({ error: "Job not found." }, 404);

        const timeoutMs = Math.min(Number(c.req.query("timeout") ?? 30_000) || 30_000, 60_000);
        const job = await jobs.waitForTerminal(id, timeoutMs);
        if (!job) return c.json({ error: "Job not found." }, 404);

        if (job.status === "completed") return c.json({ status: "completed", data: job.data ?? null }, 200);
        if (job.status === "failed") return c.json({ status: "failed", error: job.error }, 200);
        // Still running: the client should poll again.
        return c.json({ status: job.status }, 408);
    });

    return { app, close: () => jobs.close() };
}
