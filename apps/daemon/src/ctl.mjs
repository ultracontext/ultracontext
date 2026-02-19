import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { resolveDaemonWsInfoFile } from "@ultracontext/protocol";

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

async function status({ lockPath, infoPath }) {
  const lock = await readJsonFile(lockPath);
  const info = await readJsonFile(infoPath);
  const pid = pickPid(lock, info);

  if (!isPidAlive(pid)) {
    console.log("UltraContext daemon: offline");
    return 0;
  }

  const port = Number.parseInt(String(info?.port ?? ""), 10);
  console.log("UltraContext daemon: online");
  console.log(`pid:  ${pid}`);
  if (Number.isInteger(port) && port > 0) console.log(`port: ${port}`);
  if (info?.startedAt) console.log(`since: ${info.startedAt}`);
  return 0;
}

async function stop({ lockPath, infoPath }) {
  const lock = await readJsonFile(lockPath);
  const info = await readJsonFile(infoPath);
  const pid = pickPid(lock, info);

  if (!isPidAlive(pid)) {
    await removeFileIfExists(lockPath);
    await removeFileIfExists(infoPath);
    console.log("Daemon was already stopped.");
    return 0;
  }

  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (isPidAlive(pid)) {
    console.error(`Could not stop daemon (PID ${pid}) before timeout.`);
    return 1;
  }

  await removeFileIfExists(lockPath);
  await removeFileIfExists(infoPath);
  console.log(`Daemon stopped (PID ${pid}).`);
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
  console.error("Use: node src/ctl.mjs [status|stop]");
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Daemon control failed: ${message}`);
  process.exit(1);
});
