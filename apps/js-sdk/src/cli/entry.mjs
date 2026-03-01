#!/usr/bin/env node

// CLI router — dispatches subcommands to daemon/tui entry points
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const command = (process.argv[2] ?? "").trim().toLowerCase().replace(/^--?/, "");
const PACKAGE_NAME = "ultracontext";
const packageRoot = path.resolve(__dirname, "..", "..");
const cliWrapperPath = path.join(packageRoot, "ultracontext.mjs");

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

Usage: ultracontext [command] [options]

Commands:
  (none)   Start daemon if needed, then open TUI
  config   Run the setup wizard
  start    Start the daemon in the background
  stop     Stop a running daemon
  status   Show daemon status
  tui      Launch the interactive terminal UI
  update   Update CLI globally via npm/pnpm/bun
  version  Print version
  help     Show this help message

Environment:
  ULTRACONTEXT_API_KEY   Required. Your UltraContext API key.
  ULTRACONTEXT_BASE_URL  API base URL (default: https://api.ultracontext.ai)
`);
}

function printUpdateHelp() {
  console.log(`Usage: ultracontext update [options]

Options:
  --tag <dist-tag|version>       Package tag/version (default: latest)
  --manager <npm|pnpm|bun>       Force package manager (auto-detected by default)
  --no-restart                   Do not restart daemon after update
  -h, --help                     Show this help message
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

function normalizeTag(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "latest";
  if (trimmed.startsWith(`${PACKAGE_NAME}@`)) return trimmed.slice(`${PACKAGE_NAME}@`.length);
  return trimmed;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function pathsEqual(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function runCapture(commandName, args) {
  const result = spawnSync(commandName, args, {
    env: process.env,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function resolveBunGlobalRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const bunInstall = String(process.env.BUN_INSTALL ?? "").trim() || path.join(home, ".bun");
  return path.join(bunInstall, "install", "global", "node_modules");
}

function detectGlobalInstallManager() {
  const packageRootReal = safeRealpath(packageRoot);
  const npmGlobalRoot = runCapture("npm", ["root", "-g"]);
  if (npmGlobalRoot.ok) {
    const npmRoot = npmGlobalRoot.stdout.trim();
    if (npmRoot) {
      const npmExpected = safeRealpath(path.join(npmRoot, PACKAGE_NAME));
      if (pathsEqual(npmExpected, packageRootReal)) return "npm";
    }
  }

  const pnpmGlobalRoot = runCapture("pnpm", ["root", "-g"]);
  if (pnpmGlobalRoot.ok) {
    const pnpmRoot = pnpmGlobalRoot.stdout.trim();
    if (pnpmRoot) {
      const pnpmExpected = safeRealpath(path.join(pnpmRoot, PACKAGE_NAME));
      if (pathsEqual(pnpmExpected, packageRootReal)) return "pnpm";
    }
  }

  const bunExpected = safeRealpath(path.join(resolveBunGlobalRoot(), PACKAGE_NAME));
  if (pathsEqual(bunExpected, packageRootReal)) return "bun";

  return null;
}

function parseUpdateOptions(args) {
  const opts = {
    tag: "latest",
    manager: null,
    restart: true,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] ?? "").trim();
    if (!arg) continue;

    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }

    if (arg === "--no-restart") {
      opts.restart = false;
      continue;
    }

    if (arg === "--tag") {
      const next = args[i + 1];
      if (!next || String(next).startsWith("-")) {
        throw new Error("Missing value for --tag");
      }
      opts.tag = normalizeTag(next);
      i += 1;
      continue;
    }

    if (arg === "--manager") {
      const next = String(args[i + 1] ?? "").trim().toLowerCase();
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --manager");
      }
      if (!["npm", "pnpm", "bun"].includes(next)) {
        throw new Error(`Invalid --manager value: ${next}`);
      }
      opts.manager = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown update option: ${arg}`);
  }

  return opts;
}

function runCliSubcommand(subcommand) {
  const result = spawnSync(process.execPath, [cliWrapperPath, subcommand], {
    env: process.env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function runGlobalUpdate(manager, tag) {
  const spec = `${PACKAGE_NAME}@${normalizeTag(tag)}`;
  const argvByManager = {
    npm: ["npm", ["i", "-g", spec]],
    pnpm: ["pnpm", ["add", "-g", spec]],
    bun: ["bun", ["add", "-g", spec]],
  };

  const tuple = argvByManager[manager];
  if (!tuple) {
    throw new Error(`Unsupported package manager: ${manager}`);
  }

  const [bin, args] = tuple;
  const result = spawnSync(bin, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Update failed while running: ${bin} ${args.join(" ")}`);
  }
}

function runUpdate(rawArgs) {
  const opts = parseUpdateOptions(rawArgs);
  if (opts.help) {
    printUpdateHelp();
    return;
  }

  const manager = opts.manager ?? detectGlobalInstallManager();
  if (!manager) {
    throw new Error(
      "Could not detect install manager for this CLI. Re-run with --manager <npm|pnpm|bun>.",
    );
  }

  const wasRunning = isDaemonRunning();
  if (wasRunning && opts.restart) {
    console.log("Stopping daemon before update...");
    const stopCode = runCliSubcommand("stop");
    if (stopCode !== 0) {
      throw new Error(`Failed to stop daemon before update (exit ${stopCode}).`);
    }
  }

  console.log(`Updating ${PACKAGE_NAME} via ${manager} (${PACKAGE_NAME}@${opts.tag})...`);
  runGlobalUpdate(manager, opts.tag);
  console.log("Update completed.");

  if (wasRunning && opts.restart) {
    console.log("Restarting daemon...");
    const startCode = runCliSubcommand("start");
    if (startCode !== 0) {
      throw new Error(`Update succeeded but daemon restart failed (exit ${startCode}).`);
    }
  } else if (wasRunning) {
    console.log("Daemon was running before update. Restart manually with: ultracontext start");
  }
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

    case "update":
    case "upgrade":
      runUpdate(process.argv.slice(3));
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
