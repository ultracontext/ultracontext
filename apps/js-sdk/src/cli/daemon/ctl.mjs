import "./env.mjs";

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { resolveDaemonWsInfoFile } from "../protocol/index.mjs";

import { resolveLockPath } from "./lock.mjs";

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

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

function pickPid(lock, info) {
  const lockPid = Number.parseInt(String(lock?.pid ?? ""), 10);
  if (Number.isInteger(lockPid) && lockPid > 1) return lockPid;
  const infoPid = Number.parseInt(String(info?.pid ?? ""), 10);
  if (Number.isInteger(infoPid) && infoPid > 1) return infoPid;
  return 0;
}

// ── ANSI helpers ────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const r = esc(0);
const b = esc(1);
const d = esc(2);
const blue = esc("38;2;47;111;179");
const cyan = esc("38;2;126;195;255");
const green = esc("38;2;80;200;120");
const red = esc("38;2;220;80;80");
const gray = esc("38;5;245");

// ── commands ────────────────────────────────────────────────────

async function status({ lockPath, infoPath }) {
  const lock = await readJsonFile(lockPath);
  const info = await readJsonFile(infoPath);
  const pid = pickPid(lock, info);

  console.log("");
  console.log(`  ${blue}${b}UltraContext${r} ${d}Daemon${r}`);
  console.log("");

  if (!isPidAlive(pid)) {
    console.log(`  ${gray}○${r} ${d}Offline${r}`);
    console.log("");
    return 0;
  }

  const port = Number.parseInt(String(info?.port ?? ""), 10);
  const portStr = Number.isInteger(port) && port > 0 ? `  ${gray}Port ${port}${r}` : "";
  const sinceStr = info?.startedAt ? `  ${gray}Since ${info.startedAt}${r}` : "";
  console.log(`  ${green}●${r} ${b}Online${r}  ${gray}PID ${pid}${r}${portStr}`);
  if (sinceStr) console.log(`  ${sinceStr}`);
  console.log("");
  return 0;
}

async function stop({ lockPath, infoPath }) {
  const lock = await readJsonFile(lockPath);
  const info = await readJsonFile(infoPath);
  const pid = pickPid(lock, info);

  console.log("");
  console.log(`  ${blue}${b}UltraContext${r} ${d}Daemon${r}`);
  console.log("");

  if (!isPidAlive(pid)) {
    await removeFileIfExists(lockPath);
    await removeFileIfExists(infoPath);
    console.log(`  ${gray}○${r} ${d}Already stopped${r}`);
    console.log("");
    return 0;
  }

  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (isPidAlive(pid)) {
    console.error(`  ${red}✕${r} ${b}Timed out${r}  ${gray}PID ${pid} still running${r}`);
    console.error("");
    return 1;
  }

  await removeFileIfExists(lockPath);
  await removeFileIfExists(infoPath);
  console.log(`  ${green}✓${r} ${b}Stopped${r}  ${gray}PID ${pid}${r}`);
  console.log("");
  return 0;
}

async function main() {
  const cmd = String(process.argv[2] ?? "status").trim().toLowerCase();
  const lockPath = path.resolve(resolveLockPath(process.env));
  const infoPath = path.resolve(resolveDaemonWsInfoFile(process.env));

  if (cmd === "status") {
    const code = await status({ lockPath, infoPath });
    process.exit(code);
    return;
  }

  if (cmd === "stop") {
    const code = await stop({ lockPath, infoPath });
    process.exit(code);
    return;
  }

  console.error(`Invalid command: ${cmd}`);
  console.error("Use: ultracontext [status|stop]");
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Daemon control failed: ${message}`);
  process.exit(1);
});
