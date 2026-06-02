import { defineConfig } from "tsdown";

export default defineConfig([
  // SDK bundle (TypeScript → JS + DTS)
  {
    entry: ["src/index.ts"],
    outDir: "dist",
    format: "esm",
    platform: "node",
    dts: true,
    clean: true,
  },
]);
