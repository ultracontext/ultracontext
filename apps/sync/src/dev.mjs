// dev entry — boots daemon in background + TUI in foreground (mirrors prod)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// skip update check in dev
process.env.ULTRACONTEXT_DEV = "1";

// spawn daemon with --watch in background
const daemon = spawn("node", ["--watch", path.join(__dirname, "index.mjs")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

// suppress daemon output (TUI owns the terminal)
daemon.unref();

// small delay for daemon to initialize
await new Promise(r => setTimeout(r, 1500));

// boot TUI in foreground
await import("./env.mjs");
const { tuiBoot } = await import("./tui.mjs");
await tuiBoot();
