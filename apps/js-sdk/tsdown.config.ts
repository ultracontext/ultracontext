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
      "cli/daemon/launcher": "src/cli/daemon/launcher.mjs",
      "cli/daemon/ctl": "src/cli/daemon/ctl.mjs",
      "cli/daemon/index": "src/cli/daemon/index.mjs",
      "cli/onboarding": "src/cli/onboarding.mjs",
      "cli/tui/index": "src/cli/tui/index.mjs",
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
    ],
  },
]);
