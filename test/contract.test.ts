import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/operations/index.js";
import type { OperationDef } from "../src/operations/define.js";

function walk(dir: string, extensions: string[]): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return walk(path, extensions);
        return extensions.some((ext) => path.endsWith(ext)) ? [path] : [];
    });
}

const operations = Object.values(ops).filter(
    (v): v is OperationDef<unknown, unknown> =>
        typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string",
);

describe("Open Cloud paths say groups, never communities", () => {
    it("has no occurrence of the word anywhere in src", () => {
        // Roblox renamed Groups to Communities in the web UI only. Open Cloud v2 still routes on
        // /cloud/v2/groups and still names resources groups/{id}/roles/{id}, so a find-and-replace
        // 404s every group call - and the assignRole body value is data, not a URL, so a
        // URL-only audit would miss it.
        const offenders = walk("src", [".ts"]).filter((file) =>
            /communit/i.test(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")),
        );
        expect(offenders).toEqual([]);
    });

    it("has no occurrence in the built output either", () => {
        const files = walk("dist", [".js", ".cjs", ".d.ts", ".d.cts"]);
        if (files.length === 0) return; // dist is built in CI before this runs
        expect(files.filter((f) => /communit/i.test(readFileSync(f, "utf8")))).toEqual([]);
    });

    it("spells every group path and resource name with groups", () => {
        const groupOps = operations.filter((o) => o.name.includes("Group") || o.name.includes("JoinRequest"));
        expect(groupOps.length).toBeGreaterThan(0);
        for (const operation of groupOps) {
            const path = typeof operation.path === "function" ? operation.path({} as never) : operation.path;
            if (path.includes("group")) expect(path).toContain("/groups/");
        }
    });
});

describe("operation definitions", () => {
    it("uses brace placeholders, never colon placeholders", () => {
        // A colon in a path is a Roblox custom-method verb. If any path used :colon placeholders
        // the two syntaxes would be indistinguishable and an interpolator would eat the verbs.
        for (const operation of operations) {
            const path = typeof operation.path === "function" ? operation.path({ placeId: 1 } as never) : operation.path;
            const verbs = path.match(/:[a-zA-Z]\w*/g) ?? [];
            for (const verb of verbs) {
                expect(["listLogs", "accept", "decline", "assignRole", "unassignRole", "generateThumbnail"]).toContain(
                    verb.slice(1),
                );
            }
        }
    });

    it("gives every operation a unique name", () => {
        const names = operations.map((o) => o.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it("declares a method the queue and escape hatch both support", () => {
        for (const operation of operations) {
            expect(["GET", "POST", "PATCH", "PUT", "DELETE"]).toContain(operation.method);
        }
    });
});

describe("the published entry points stay separable", () => {
    it("does not let the root barrel reach hono or the server", () => {
        // hono is an optional peer dependency: importing the root entry must not require it.
        const roots = ["src/index.ts", "src/client.ts", "src/queue.ts", "src/auth.ts"];
        for (const file of roots) {
            const source = readFileSync(file, "utf8");
            expect(source).not.toMatch(/from\s+["']hono["']/);
            expect(source).not.toMatch(/from\s+["']\.\/server/);
        }
    });

    it("keeps axios confined to the transport adapter", () => {
        // Anywhere else and AxiosResponse leaks into the published types, making an axios major
        // a breaking change here and pinning the transport forever.
        const importers = walk("src", [".ts"]).filter((file) => /from\s+["']axios["']/.test(readFileSync(file, "utf8")));
        expect(importers.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/http.ts"]);
    });

    it("contains no NUL bytes, which would hide a file from every grep-based audit", () => {
        // A stray NUL makes grep classify the file as binary and skip it silently, so a
        // repo-wide search for a bad rename reports clean while the file still carries it.
        const offenders = walk("src", [".ts"]).filter((file) => readFileSync(file).includes(0));
        expect(offenders).toEqual([]);
    });

    it("uses no environment variables", () => {
        // A library reads its configuration from its constructor, not from the ambient process.
        const offenders = walk("src", [".ts"]).filter((file) => /process\.env/.test(readFileSync(file, "utf8")));
        expect(offenders).toEqual([]);
    });
});
