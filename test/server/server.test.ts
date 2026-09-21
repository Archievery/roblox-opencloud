import { describe, it, expect, afterEach } from "vitest";
import { apiKey } from "../../src/index.js";
import { SUPPORTED_OPERATIONS, createServer } from "../../src/server/index.js";
import type { OpenCloudServer } from "../../src/server/index.js";
import { fastTimings, response, stubHttp } from "../helpers.js";
import { USER_ID, rawUser } from "../fixtures.js";

const servers: OpenCloudServer[] = [];

function makeServer(http: ReturnType<typeof stubHttp>, options: Record<string, unknown> = {}) {
    const server = createServer({
        credentials: { primary: apiKey("key-1", { id: "primary" }), spare: apiKey("key-2", { id: "spare" }) },
        defaultCredential: "primary",
        client: { http: http.adapter, timings: fastTimings },
        ...options,
    });
    servers.push(server);
    return server;
}

afterEach(() => {
    while (servers.length) servers.pop()?.close();
});

/** Submits a job and long-polls it to completion, the way a real client would. */
async function runJob(server: OpenCloudServer, body: unknown, headers: Record<string, string> = {}) {
    const submit = await server.app.request("/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    if (submit.status !== 202) return { submit, job: undefined };
    const { id } = (await submit.json()) as { id: string };
    const poll = await server.app.request(`/jobs/${id}?timeout=1000`, { headers });
    return { submit, job: { status: poll.status, body: await poll.json() } };
}

describe("createServer - construction", () => {
    it("derives its operation table from the operations module", () => {
        // Adding an operation must not require editing the server.
        expect(SUPPORTED_OPERATIONS).toContain("GetUser");
        expect(SUPPORTED_OPERATIONS).toContain("SetUserRestriction");
        expect(SUPPORTED_OPERATIONS).toContain("AcceptJoinRequest");
        expect(SUPPORTED_OPERATIONS.length).toBeGreaterThanOrEqual(17);
    });

    it("refuses to start with no credentials or an unknown default", () => {
        expect(() => createServer({ credentials: {} })).toThrow(/at least one credential/);
        expect(() =>
            createServer({ credentials: { a: apiKey("k") }, defaultCredential: "missing" }),
        ).toThrow(/not present in credentials/);
    });
});

describe("createServer - auth", () => {
    it("rejects a request without the shared secret but leaves /health open", async () => {
        const http = stubHttp();
        const server = makeServer(http, { authToken: "s3cret" });

        expect((await server.app.request("/request", { method: "POST" })).status).toBe(401);
        expect((await server.app.request("/health")).status).toBe(200);
    });

    it("accepts a request carrying the shared secret", async () => {
        const http = stubHttp();
        http.push(response(rawUser));
        const server = makeServer(http, { authToken: "s3cret" });

        const { job } = await runJob(
            server,
            { operation: "GetUser", input: { userId: USER_ID } },
            { Authorization: "Bearer s3cret" },
        );
        expect(job?.status).toBe(200);
    });
});

describe("createServer - dispatch", () => {
    it("runs a job and returns its result over the long poll", async () => {
        const http = stubHttp();
        http.push(response(rawUser));
        const server = makeServer(http);

        const { submit, job } = await runJob(server, { operation: "GetUser", input: { userId: USER_ID } });

        expect(submit.status).toBe(202);
        expect(job?.status).toBe(200);
        expect(job?.body).toMatchObject({ status: "completed", data: { username: "Builderman" } });
    });

    it("reports a failed job with its error code rather than a bare string", async () => {
        const http = stubHttp();
        http.push(response({}, 404));
        const server = makeServer(http);

        const { job } = await runJob(server, { operation: "GetUser", input: { userId: USER_ID } });

        expect(job?.body).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    });

    it("selects a credential by name, so raw keys never cross the wire", async () => {
        const http = stubHttp();
        http.push(response(rawUser));
        const server = makeServer(http);

        await runJob(server, { operation: "GetUser", input: { userId: USER_ID }, credential: "spare" });

        expect(http.calls[0]?.headers["x-api-key"]).toBe("key-2");
    });

    it("rejects an unknown operation, an unknown credential and a malformed body", async () => {
        const http = stubHttp();
        const server = makeServer(http);

        const unknownOp = await server.app.request("/request", {
            method: "POST",
            body: JSON.stringify({ operation: "DropDatabase", input: {} }),
        });
        expect(unknownOp.status).toBe(400);

        const unknownCredential = await server.app.request("/request", {
            method: "POST",
            body: JSON.stringify({ operation: "GetUser", input: { userId: "1" }, credential: "nope" }),
        });
        expect(unknownCredential.status).toBe(400);

        const badJson = await server.app.request("/request", { method: "POST", body: "{{{" });
        expect(badJson.status).toBe(400);
    });

    it("404s a poll for an unknown job", async () => {
        const http = stubHttp();
        const server = makeServer(http);
        expect((await server.app.request("/jobs/does-not-exist")).status).toBe(404);
    });

    it("answers 408 while a job is still running, so the client polls again", async () => {
        // An adapter that never settles, so the job is still running when the poll expires.
        const server = createServer({
            credentials: { primary: apiKey("k") },
            defaultCredential: "primary",
            client: { http: () => new Promise(() => {}), timings: fastTimings },
        });
        servers.push(server);
        const submit = await server.app.request("/request", {
            method: "POST",
            body: JSON.stringify({ operation: "GetUser", input: { userId: USER_ID } }),
        });
        const { id } = (await submit.json()) as { id: string };

        const poll = await server.app.request(`/jobs/${id}?timeout=20`);

        expect(poll.status).toBe(408);
        expect(await poll.json()).toMatchObject({ status: "running" });
    });
});
