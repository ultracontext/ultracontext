import "./env.mjs";

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveDaemonWsInfoFile } from "../protocol/index.mjs";

import { resolveLockPath } from "./lock.mjs";
import { expandHome } from "./utils.mjs";

const DEFAULT_LOG_FILE = "~/.ultracontext/daemon.log";

// ── ANSI helpers ────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const reset = esc(0);
const bold = esc(1);
const dim = esc(2);
const blue = esc("38;2;47;111;179");   // UC_BRAND_BLUE
const cyan = esc("38;2;126;195;255");  // UC_BLUE_LIGHT
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
    const allLines = raw
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (allLines.length === 0) return [];
    return allLines.slice(-Math.max(lines, 1));
  } catch {
    return [];
  }
}

function resolveDaemonLogFile(env = process.env) {
  return expandHome(env.ULTRACONTEXT_DAEMON_LOG_FILE ?? DEFAULT_LOG_FILE);
}

// ── resolve running daemon ──────────────────────────────────────

async function resolveRunningProcess(lockPath) {
  const lock = await readJsonFile(lockPath);
  const lockPid = Number.parseInt(String(lock?.pid ?? ""), 10);
  if (isPidAlive(lockPid)) {
    return {
      pid: lockPid,
      startedAt: String(lock?.startedAt ?? ""),
      engineerId: String(lock?.engineerId ?? ""),
      host: String(lock?.host ?? ""),
    };
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

// ── main ────────────────────────────────────────────────────────

async function main() {
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
    const entryPath = fileURLToPath(new URL("./index.mjs", import.meta.url));
    child = spawn(process.execPath, [entryPath, "--daemon"], {
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
    console.log(`  ${dim}Try: DAEMON_VERBOSE=1 ultracontext start${reset}`);
    console.log("");
    process.exit(1);
    return;
  }

  // success
  console.log(`  ${green}✓${reset} ${bold}Started${reset}  ${gray}PID ${child.pid}${reset}`);
  console.log(`    ${gray}${logPath}${reset}`);
  console.log("");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`  ${red}✕${reset} ${message}`);
  console.error("");
  process.exit(1);
});
