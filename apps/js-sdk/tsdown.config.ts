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

  // CLI bundles (plain ESM, externalize heavy deps)
  {
    entry: {
      "cli/entry": "src/cli/entry.mjs",
      "cli/onboarding": "src/cli/onboarding.mjs",
      "cli/sdk-daemon": "src/cli/sdk-daemon.mjs",
    },
    outDir: "dist",
    format: "esm",
    platform: "node",
    external: [
      "react",
      "ink",
      "@mishieck/ink-titled-box",
      "figlet",
      "ws",
      "fast-glob",
      "ultracontext",
      "@ultracontext/protocol",
      "@ultracontext/daemon",
      "@ultracontext/tui",
    ],
  },
]);
