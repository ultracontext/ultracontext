// env resolution + bootstrap helpers (extracted from packages/protocol)
import os from "node:os";
import path from "node:path";

const VERSION = "v1";
const DEFAULT_DAEMON_INFO_FILE = "~/.ultracontext/daemon.info";

// ── helpers ────────────────────────────────────────────

function norm(value, fallback = "unknown") {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function expandHome(inputPath) {
  const raw = String(inputPath ?? "");
  if (!raw || !raw.startsWith("~")) return raw;
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

// ── env resolution ─────────────────────────────────────

export function resolveDaemonInfoFile(env = process.env) {
  return expandHome(
    env.ULTRACONTEXT_DAEMON_INFO_FILE ??
      DEFAULT_DAEMON_INFO_FILE
  );
}

// ── bootstrap helpers ──────────────────────────────────

export function createBootstrapStateKey({ host, userId, sourceNames }) {
  const names = Array.isArray(sourceNames) ? sourceNames.map((name) => String(name ?? "").trim()).filter(Boolean) : [];
  const namesKey = names.sort().join(",");
  return `uc:daemon:bootstrap:${VERSION}:${norm(host)}:${norm(userId)}:${namesKey}`;
}

export function normalizeBootstrapMode(raw, { allowPrompt = false } = {}) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (allowPrompt && value === "prompt") return "prompt";
  if (value === "new" || value === "new_only" || value === "latest") return "new_only";
  if (value === "24h" || value === "last_24h" || value === "last24h") return "last_24h";
  if (value === "all" || value === "full") return "all";
  return "";
}

// ── json parsing ───────────────────────────────────────

export function parseProtocolJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
