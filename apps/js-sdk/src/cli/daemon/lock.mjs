import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { expandHome } from "./utils.mjs";

const DEFAULT_LOCK_PATH = "~/.ultracontext/daemon.lock";

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

async function readExistingLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveLockPath(env = process.env) {
  return expandHome(env.ULTRACONTEXT_LOCK_FILE ?? DEFAULT_LOCK_PATH);
}

export async function acquireFileLock({
  lockPath = resolveLockPath(process.env),
  engineerId = "",
  host = "",
} = {}) {
  const resolved = path.resolve(lockPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  let handle;
  try {
    handle = await fs.open(resolved, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;

    const existing = await readExistingLock(resolved);
    const existingPid = Number.parseInt(String(existing?.pid ?? ""), 10);
    if (!isPidAlive(existingPid)) {
      try {
        await fs.unlink(resolved);
      } catch {
        // ignore
      }
      handle = await fs.open(resolved, "wx");
    } else {
      const reason = existingPid
        ? `UltraContext daemon already running (PID: ${existingPid})`
        : "UltraContext daemon already running";
      const lockError = new Error(reason);
      lockError.code = "ELOCKED";
      lockError.pid = existingPid;
      throw lockError;
    }
  }

  const payload = {
    pid: process.pid,
    host: String(host ?? ""),
    engineerId: String(engineerId ?? ""),
    startedAt: new Date().toISOString(),
  };
  await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await fs.unlink(resolved);
    } catch {
      // ignore
    }
  };

  return {
    lockPath: resolved,
    payload,
    release,
  };
}
