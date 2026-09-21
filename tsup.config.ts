import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/index.ts", "server/index": "src/server/index.ts" },
    format: ["esm", "cjs"],
    target: "node20",
    dts: true,
    clean: true,
    treeshake: true,
    sourcemap: true,
    external: ["hono", "axios"],
});
