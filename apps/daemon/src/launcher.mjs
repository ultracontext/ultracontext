import "./env.mjs";

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

function resolveDaemonLogFile(env = process.env) {
  return expandHome(env.ULTRACONTEXT_DAEMON_LOG_FILE ?? DEFAULT_LOG_FILE);
}

function printBranding() {
  const lines = [
    "+------------------------------------------+",
    "|             UltraContext Daemon          |",
    "+------------------------------------------+",
  ];
  for (const line of lines) console.log(line);
}

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

async function main() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lockPath = path.resolve(resolveLockPath(process.env));
  const infoPath = path.resolve(resolveDaemonWsInfoFile(process.env));
  const preferredLogPath = resolveDaemonLogFile(process.env);

  printBranding();

  const running = await resolveRunningProcess(lockPath);
  if (running) {
    console.log(`Daemon is already running (PID ${running.pid}).`);
    console.log(`lock: ${lockPath}`);
    console.log(`info: ${infoPath}`);
    process.exit(2);
    return;
  }

  const logPath = await resolveWritableLogPath(preferredLogPath);
  const outFd = fsSync.openSync(logPath, "a");
  const errFd = fsSync.openSync(logPath, "a");

  let child;
  try {
    child = spawn(process.execPath, ["src/index.mjs", "--daemon"], {
      cwd: appRoot,
      env: process.env,
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.unref();
  } finally {
    try {
      fsSync.closeSync(outFd);
    } catch {
      // ignore
    }
    try {
      fsSync.closeSync(errFd);
    } catch {
      // ignore
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 350));
  if (!isPidAlive(child.pid)) {
    console.error("Failed to start daemon in the background.");
    console.error("Run `pnpm --filter ultracontext-daemon run start:verbose` for diagnostics.");
    process.exit(1);
    return;
  }

  console.log("Daemon started in the background successfully.");
  console.log(`pid:  ${child.pid}`);
  console.log(`log:  ${logPath}`);
  console.log(`info: ${infoPath}`);
  console.log("verbose: pnpm --filter ultracontext-daemon run start:verbose");
  console.log("stop:    pnpm --filter ultracontext-daemon run stop");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start launcher: ${message}`);
  process.exit(1);
});
