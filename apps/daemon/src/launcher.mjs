// daemon launcher — spawns daemon in background, exported as launchDaemon()
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveDaemonWsInfoFile } from "@ultracontext/protocol";

import { resolveLockPath } from "./lock.mjs";
import { expandHome } from "./utils.mjs";

const DEFAULT_LOG_FILE = "~/.ultracontext/daemon.log";

// ── ANSI helpers ────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const reset = esc(0);
const bold = esc(1);
const dim = esc(2);
const blue = esc("38;2;47;111;179");
const cyan = esc("38;2;126;195;255");
const green = esc("38;2;80;200;120");
const red = esc("38;2;220;80;80");
const gray = esc("38;5;245");

// ── process helpers ─────────────────────────────────────────────

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return false;
  }
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readLogTail(logPath, lines = 12) {
  try {
    const raw = await fs.readFile(logPath, "utf8");
    const allLines = raw.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    return allLines.length === 0 ? [] : allLines.slice(-Math.max(lines, 1));
  } catch {
    return [];
  }
}

function resolveDaemonLogFile(env = process.env) {
  return expandHome(env.ULTRACONTEXT_DAEMON_LOG_FILE ?? DEFAULT_LOG_FILE);
}

async function resolveRunningProcess(lockPath) {
  const lock = await readJsonFile(lockPath);
  const lockPid = Number.parseInt(String(lock?.pid ?? ""), 10);
  if (isPidAlive(lockPid)) {
    return { pid: lockPid, startedAt: String(lock?.startedAt ?? ""), engineerId: String(lock?.engineerId ?? ""), host: String(lock?.host ?? "") };
  }
  return null;
}

async function resolveWritableLogPath(preferredPath) {
  const primary = path.resolve(preferredPath);
  try {
    await fs.mkdir(path.dirname(primary), { recursive: true });
    fsSync.accessSync(path.dirname(primary), fsSync.constants.W_OK);
    return primary;
  } catch {
    const fallback = path.resolve(process.cwd(), ".ultracontext-daemon.log");
    await fs.mkdir(path.dirname(fallback), { recursive: true });
    return fallback;
  }
}

// ── exported entry point ────────────────────────────────────────

export async function launchDaemon({ entryPath, diagnosticsHint } = {}) {
  const resolvedEntry = entryPath ?? fileURLToPath(new URL("./index.mjs", import.meta.url));
  const hint = diagnosticsHint ?? "pnpm --filter @ultracontext/daemon run start:verbose";

  const lockPath = path.resolve(resolveLockPath(process.env));
  const infoPath = path.resolve(resolveDaemonWsInfoFile(process.env));
  const preferredLogPath = resolveDaemonLogFile(process.env);

  console.log("");
  console.log(`  ${blue}${bold}UltraContext${reset} ${dim}Daemon${reset}`);
  console.log("");

  // already running
  const running = await resolveRunningProcess(lockPath);
  if (running) {
    console.log(`  ${cyan}●${reset} ${bold}Already running${reset}  ${gray}PID ${running.pid}${reset}`);
    console.log("");
    process.exit(2);
    return;
  }

  // spawn daemon
  const logPath = await resolveWritableLogPath(preferredLogPath);
  const outFd = fsSync.openSync(logPath, "a");
  const errFd = fsSync.openSync(logPath, "a");

  let child;
  try {
    child = spawn(process.execPath, [resolvedEntry, "--daemon"], {
      env: process.env,
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.unref();
  } finally {
    try { fsSync.closeSync(outFd); } catch { /* ignore */ }
    try { fsSync.closeSync(errFd); } catch { /* ignore */ }
  }

  await new Promise((resolve) => setTimeout(resolve, 350));

  // failed
  if (!isPidAlive(child.pid)) {
    console.log(`  ${red}✕${reset} ${bold}Failed to start${reset}`);
    const tail = await readLogTail(logPath);
    if (tail.length > 0) {
      console.log("");
      for (const line of tail) console.error(`    ${gray}${line}${reset}`);
    }
    console.log("");
    console.log(`  ${dim}Try: ${hint}${reset}`);
    console.log("");
    process.exit(1);
    return;
  }

  // success
  console.log(`  ${green}✓${reset} ${bold}Started${reset}  ${gray}PID ${child.pid}${reset}`);
  console.log(`    ${gray}${logPath}${reset}`);
  console.log("");
}

// auto-exec when run directly
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  launchDaemon().catch((error) => {
    console.error(`  ${red}✕${reset} ${error instanceof Error ? error.message : String(error)}`);
    console.error("");
    process.exit(1);
  });
}
