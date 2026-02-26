import { defineConfig } from "bunup";

export default defineConfig([
  {
    name: "esm",
    entry: "src/index.ts",
    format: "esm",
    outDir: "dist/esm",
    dts: true,
    splitting: false,
    sourcemap: false,
    clean: true,
    target: "node",
    external: ["@x402/core", "@x402/extensions", "elysia"],
  },
  {
    name: "cjs",
    entry: "src/index.ts",
    format: "cjs",
    outDir: "dist/cjs",
    dts: true,
    splitting: false,
    sourcemap: false,
    clean: false,
    target: "node",
    external: ["@x402/core", "@x402/extensions", "elysia"],
  },
]);
