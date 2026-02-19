import os from "node:os";
import path from "node:path";

const VERSION = "v1";
const DEFAULT_DAEMON_WS_HOST = "127.0.0.1";
const DEFAULT_DAEMON_WS_PORT = 0;
const DEFAULT_DAEMON_INFO_FILE = "~/.ultracontext/daemon.info";

export const DAEMON_WS_MESSAGE_TYPES = Object.freeze({
  SNAPSHOT: "snapshot",
  STATE: "state",
  LOG: "log",
  CONTEXT_EVENT: "context:event",
  CONFIG_STATE: "config:state",
  REQUEST_ACK: "ack",
  PING: "ping",
  PONG: "pong",
  CONFIG_GET: "config:get",
  CONFIG_SET: "config:set",
  BOOTSTRAP_RESET: "bootstrap:reset",
});

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

export function resolveDaemonWsHost(env = process.env) {
  const raw = String(env.ULTRACONTEXT_DAEMON_WS_HOST ?? env.ULTRACONTEXT_WS_HOST ?? "").trim();
  return raw || DEFAULT_DAEMON_WS_HOST;
}

export function resolveDaemonWsPort(env = process.env) {
  const raw = Number.parseInt(String(env.ULTRACONTEXT_DAEMON_WS_PORT ?? env.ULTRACONTEXT_WS_PORT ?? ""), 10);
  if (Number.isInteger(raw) && raw >= 0 && raw <= 65535) return raw;
  return DEFAULT_DAEMON_WS_PORT;
}

export function resolveDaemonWsInfoFile(env = process.env) {
  return expandHome(
    env.ULTRACONTEXT_DAEMON_INFO_FILE ??
      env.ULTRACONTEXT_DAEMON_WS_PORT_FILE ??
      env.ULTRACONTEXT_WS_INFO_FILE ??
      DEFAULT_DAEMON_INFO_FILE
  );
}

export function resolveDaemonWsPortFile(env = process.env) {
  return resolveDaemonWsInfoFile(env);
}

export function createBootstrapStateKey({ host, engineerId, sourceNames }) {
  const names = Array.isArray(sourceNames) ? sourceNames.map((name) => String(name ?? "").trim()).filter(Boolean) : [];
  const namesKey = names.sort().join(",");
  return `uc:daemon:bootstrap:${VERSION}:${norm(host)}:${norm(engineerId)}:${namesKey}`;
}

export function normalizeBootstrapMode(raw, { allowPrompt = false } = {}) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (allowPrompt && value === "prompt") return "prompt";
  if (value === "new" || value === "new_only" || value === "latest") return "new_only";
  if (value === "24h" || value === "last_24h" || value === "last24h") return "last_24h";
  if (value === "all" || value === "full") return "all";
  return "";
}

export function parseProtocolJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function buildDaemonWsMessage(type, data = {}) {
  return { type: String(type ?? ""), data: data ?? {} };
}

export function parseDaemonWsMessage(raw, fallback = null) {
  const parsed = typeof raw === "string" ? parseProtocolJson(raw, fallback) : raw;
  if (!parsed || typeof parsed !== "object") return fallback;
  const type = String(parsed.type ?? "").trim();
  if (!type) return fallback;
  return {
    ...parsed,
    type,
    data: parsed.data ?? {},
  };
}
