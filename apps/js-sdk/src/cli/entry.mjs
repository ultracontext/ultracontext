#!/usr/bin/env node

// CLI router — dispatches subcommands to daemon/tui entry points
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const command = (process.argv[2] ?? "").trim().toLowerCase().replace(/^--?/, "");

// resolve package version
function readVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp() {
  const version = readVersion();
  console.log(`ultracontext v${version}

Usage: ultracontext [command]

Commands:
  (none)   Start daemon if needed, then open TUI
  config   Run the setup wizard
  start    Start the daemon in the background
  stop     Stop a running daemon
  status   Show daemon status
  tui      Launch the interactive terminal UI
  version  Print version
  help     Show this help message

Environment:
  ULTRACONTEXT_API_KEY   Required. Your UltraContext API key.
  ULTRACONTEXT_BASE_URL  API base URL (default: https://api.ultracontext.ai)
`);
}

// commands that need an API key
const NEEDS_KEY = new Set(["", "start", "tui"]);

// interactive onboarding wizard (Ink-based), returns { launchTui }
async function runOnboarding() {
  const { onboard } = await import("./onboarding.mjs");
  return onboard();
}

// check if daemon is already running via lock file
function isDaemonRunning() {
  try {
    const lockPath = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".ultracontext", "daemon.lock");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const pid = Number.parseInt(String(lock?.pid ?? ""), 10);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// try loading key from config file if env is empty
function loadApiKeyFromConfig() {
  if (process.env.ULTRACONTEXT_API_KEY) return;
  try {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".ultracontext", "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (cfg.apiKey) process.env.ULTRACONTEXT_API_KEY = String(cfg.apiKey);
  } catch { /* no config */ }
}

async function run() {
  // load saved key, then onboard if still missing
  let onboardResult = null;
  if (NEEDS_KEY.has(command)) {
    loadApiKeyFromConfig();
    if (!process.env.ULTRACONTEXT_API_KEY) onboardResult = await runOnboarding();
  }

  switch (command) {
    case "start":
      await import("./daemon/launcher.mjs");
      if (onboardResult?.launchTui) await import("./tui/index.mjs");
      break;

    case "stop":
      process.argv[2] = "stop";
      await import("./daemon/ctl.mjs");
      break;

    case "status":
      process.argv[2] = "status";
      await import("./daemon/ctl.mjs");
      break;

    case "config": {
      const configResult = await runOnboarding();
      if (configResult?.launchTui) {
        if (!isDaemonRunning()) await import("./daemon/launcher.mjs");
        await import("./tui/index.mjs");
      }
      break;
    }

    case "tui":
      await import("./tui/index.mjs");
      break;

    case "version":
    case "v":
      console.log(readVersion());
      break;

    // default: ensure daemon running, then open TUI
    case "": {
      if (!isDaemonRunning()) await import("./daemon/launcher.mjs");
      await import("./tui/index.mjs");
      break;
    }

    case "help":
    case "h":
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${process.argv[2]}`);
      printHelp();
      process.exit(1);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
