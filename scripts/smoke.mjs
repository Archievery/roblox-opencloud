// Loads the built package the way a consumer would: both module formats, both entry points.
// Run after `npm run build`. The companion type check is `tsc -p scripts/tsconfig.smoke.json`.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);

const esm = await import("../dist/index.js");
const esmServer = await import("../dist/server/index.js");
const cjs = require("../dist/index.cjs");
const cjsServer = require("../dist/server/index.cjs");

for (const [label, mod, server] of [
    ["esm", esm, esmServer],
    ["cjs", cjs, cjsServer],
]) {
    for (const name of ["OpenCloudClient", "OpenCloudError", "apiKey", "oauth", "pool", "custom", "defineOperation"]) {
        assert.ok(mod[name], `${label}: missing export ${name}`);
    }

    const client = new mod.OpenCloudClient({ credential: mod.apiKey("k") });
    for (const method of ["getUser", "getGroup", "listGroupRoles", "setUserRestriction", "request", "call", "paginate"]) {
        assert.equal(typeof client[method], "function", `${label}: missing method ${method}`);
    }

    assert.equal(new mod.OpenCloudError("RATE_LIMITED", "x").retryable, true, `${label}: retryable`);
    assert.equal(new mod.OpenCloudError("NOT_FOUND", "x").retryable, false, `${label}: terminal`);

    const instance = server.createServer({ credentials: { a: mod.apiKey("k") } });
    assert.ok(instance.app, `${label}: server app`);
    assert.ok(server.SUPPORTED_OPERATIONS.length >= 17, `${label}: operation table`);
    instance.close();

    console.log(`${label}: ok`);
}

console.log("dist smoke passed");
