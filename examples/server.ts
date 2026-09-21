// Run with: npx tsx examples/server.ts
//
// Share one queue, rate-limit view and credential set across several services. Callers name a
// credential; raw keys never cross the wire.
//
// Under Node use @hono/node-server; under Bun use Bun.serve. createServer returns the app rather
// than binding a port, because the runtime is yours to choose.
import { apiKey, pool } from "../src/index.js";
import { createServer } from "../src/server/index.js";

const { app, close } = createServer({
    credentials: {
        // A pool spreads load across keys and prefers whichever has the most observed headroom.
        groups: pool([apiKey(process.env.ROBLOX_KEY_A ?? ""), apiKey(process.env.ROBLOX_KEY_B ?? "")]),
        moderation: apiKey(process.env.ROBLOX_MOD_KEY ?? ""),
    },
    defaultCredential: "groups",
    // Without this anyone who can reach the port can spend your credentials.
    authToken: process.env.SHARED_SECRET,
    logger: { debug: console.debug, warn: console.warn, error: console.error },
});

// Bun:
//   const server = Bun.serve({ port: 3100, fetch: app.fetch });
// Node:
//   import { serve } from "@hono/node-server";
//   const server = serve({ fetch: app.fetch, port: 3100 });
console.log(`ready; ${app.routes.length} routes`);

process.on("SIGTERM", () => close());

// A caller then does:
//
//   const submit = await fetch("http://localhost:3100/request", {
//       method: "POST",
//       headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
//       body: JSON.stringify({ operation: "GetUser", input: { userId: "1" }, credential: "groups" }),
//   });
//   const { id } = await submit.json();
//   const result = await fetch(`http://localhost:3100/jobs/${id}?timeout=30000`, {
//       headers: { Authorization: `Bearer ${secret}` },
//   });
//
// A 408 means "still running, poll again"; 200 carries { status: "completed" | "failed" }.
