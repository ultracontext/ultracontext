import "./env.mjs";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import fg from "fast-glob";
import { UltraContext } from "ultracontext";
import {
  DAEMON_WS_MESSAGE_TYPES,
  createBootstrapStateKey,
  normalizeBootstrapMode,
  parseProtocolJson,
  resolveDaemonWsHost,
  resolveDaemonWsInfoFile,
  resolveDaemonWsPort,
} from "@ultracontext/protocol";

import { acquireFileLock, resolveLockPath } from "./lock.mjs";
import { redact } from "./redact.mjs";
import { parseClaudeCodeLine, parseCodexLine, parseOpenClawLine } from "./sources.mjs";
import { createStore, resolveDbPath } from "./store.mjs";
import { boolFromEnv, expandHome, sha256, toInt } from "./utils.mjs";
import { createWsServer } from "./ws-server.mjs";

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_RUNTIME_CONFIG_FILE = "~/.ultracontext/config.json";
const BOOTSTRAP_OPTIONS = [
  { id: "new_only", label: "New only (recommended)" },
  { id: "last_24h", label: "Last 24h" },
  { id: "all", label: "All" },
  { id: "prompt", label: "Ask on startup" },
];
const PERSISTED_CONFIG_FIELDS = ["bootstrapMode", "claudeIncludeSubagents"];
const STORE_CONFIG_PREFS_KEY = "daemon:prefs";
const cliArgs = new Set(process.argv.slice(2));

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function shouldUseColor() {
  return Boolean(process.stdout?.isTTY) && !boolFromEnv(process.env.NO_COLOR, false);
}

function levelColor(level) {
  if (level === "error") return ANSI.red;
  if (level === "warn") return ANSI.yellow;
  if (level === "debug") return ANSI.gray;
  return ANSI.cyan;
}

function colorize(text, color) {
  if (!shouldUseColor()) return String(text ?? "");
  return `${color}${String(text ?? "")}${ANSI.reset}`;
}

function normalizeApiKey(raw) {
  if (!raw) return "";
  return String(raw).trim().replace(/^['"]|['"]$/g, "");
}

function resolveRuntimeConfigPath() {
  return expandHome(process.env.ULTRACONTEXT_CONFIG_FILE ?? DEFAULT_RUNTIME_CONFIG_FILE);
}

function normalizeBootstrapModeWithPrompt(raw) {
  return normalizeBootstrapMode(raw, { allowPrompt: true }) || "";
}

const cfg = {
  apiKey: normalizeApiKey(process.env.ULTRACONTEXT_API_KEY),
  baseUrl: (process.env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai").trim(),
  engineerId: process.env.DAEMON_ENGINEER_ID ?? process.env.USER ?? "unknown-engineer",
  host: (process.env.DAEMON_HOST || os.hostname() || "unknown-host").trim(),
  pollMs: toInt(process.env.DAEMON_POLL_MS, 1500),
  logLevel: process.env.DAEMON_LOG_LEVEL ?? "info",
  verboseLogs: cliArgs.has("--verbose") || boolFromEnv(process.env.DAEMON_VERBOSE, false),
  logAppends: boolFromEnv(process.env.DAEMON_LOG_APPENDS, true),
  uiRefreshMs: toInt(process.env.TUI_REFRESH_MS, 1200),
  uiRecentLimit: toInt(process.env.TUI_RECENT_LIMIT, 240),
  configFile: resolveRuntimeConfigPath(),
  dbFile: resolveDbPath(process.env),
  lockFile: resolveLockPath(process.env),
  wsHost: resolveDaemonWsHost(process.env),
  wsPort: resolveDaemonWsPort(process.env),
  wsInfoFile: resolveDaemonWsInfoFile(process.env),
  dedupeTtlSec: toInt(process.env.DAEMON_DEDUPE_TTL_SEC, 60 * 60 * 24 * 30),
  maxReadBytes: toInt(process.env.DAEMON_MAX_READ_BYTES, 512 * 1024),
  enableDailyContext: boolFromEnv(process.env.DAEMON_ENABLE_DAILY_CONTEXT, false),
  bootstrapMode: normalizeBootstrapModeWithPrompt(process.env.DAEMON_BOOTSTRAP_MODE ?? "prompt") || "prompt",
  bootstrapReset: boolFromEnv(process.env.DAEMON_BOOTSTRAP_RESET, false),
  claudeIncludeSubagents: boolFromEnv(process.env.CLAUDE_INCLUDE_SUBAGENTS, false),
  cleanupEveryCycles: Math.max(toInt(process.env.DAEMON_STORE_CLEANUP_CYCLES, 20), 1),
};

const stats = {
  startedAt: Date.now(),
  cycles: 0,
  filesScanned: 0,
  linesRead: 0,
  parsedEvents: 0,
  appended: 0,
  deduped: 0,
  contextsCreated: 0,
  errors: 0,
};

const state = {
  recentLogs: [],
  sourceStats: new Map(),
  sourceOrder: [],
};

let daemonStateTimer = null;
let stdioErrorHandled = false;

const runtime = {
  uc: null,
  stop: null,
  store: null,
  sources: null,
  ingestMode: "all",
  daemonRunning: false,
  wsServer: null,
  lockHandle: null,
};

function isBenignStdioError(error) {
  const code = String(error?.code ?? "");
  return code === "EIO" || code === "EPIPE" || code === "ENXIO";
}

function handleStdioError(error, streamName) {
  if (!isBenignStdioError(error)) return;
  if (stdioErrorHandled) return;
  stdioErrorHandled = true;

  try {
    runtime.stop?.("stdio");
  } catch {
    // ignore
  }

  if (LOG_LEVELS[cfg.logLevel] >= LOG_LEVELS.debug) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[debug] Ignored stdio ${streamName} error (${error?.code ?? "?"}): ${msg}`);
  }
}

function installStdioErrorGuards() {
  process.stdin?.on?.("error", (error) => handleStdioError(error, "stdin"));
  process.stdout?.on?.("error", (error) => handleStdioError(error, "stdout"));
  process.stderr?.on?.("error", (error) => handleStdioError(error, "stderr"));
}

function runtimeLogsKeep() {
  return Math.max(cfg.uiRecentLimit, 180);
}

function formatTime(value = Date.now()) {
  return new Date(value).toISOString().slice(11, 19);
}

function safeText(value) {
  return String(value ?? "");
}

function compactValue(value) {
  const raw = safeText(value);
  if (raw.length <= 32) return raw;
  return `${raw.slice(0, 14)}...${raw.slice(-12)}`;
}

function formatDataInline(data) {
  if (!data || typeof data !== "object") return "";
  const entries = Object.entries(data).slice(0, 8);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => `${k}=${compactValue(v)}`);
  return parts.join(" ");
}

function ensureSourceStats(sourceName) {
  if (!state.sourceStats.has(sourceName)) {
    state.sourceStats.set(sourceName, {
      filesScanned: 0,
      linesRead: 0,
      parsedEvents: 0,
      appended: 0,
      deduped: 0,
      contextsCreated: 0,
      errors: 0,
      lastEventType: "-",
      lastSessionId: "-",
      lastAt: 0,
      lastFile: "-",
    });
  }
  return state.sourceStats.get(sourceName);
}

function bumpSourceStat(sourceName, key, delta = 1) {
  const current = ensureSourceStats(sourceName);
  current[key] = (current[key] ?? 0) + delta;
}

function noteSourceActivity(sourceName, patch) {
  const current = ensureSourceStats(sourceName);
  Object.assign(current, patch ?? {});
}

function logSourceFromData(data) {
  if (!data || typeof data !== "object") return "";
  const direct = [data.source, data.context_source, data.contextSource, data?.metadata?.source];
  for (const value of direct) {
    const raw = String(value ?? "").trim();
    if (raw) return raw.toLowerCase();
  }
  return "";
}

function pushRecentLog(level, message, data) {
  let line = String(message ?? "");
  if (line.startsWith("Appended event to session context")) line = "context append (session)";
  if (line.startsWith("Appended event to daily context")) line = "context append (daily)";
  if (line.startsWith("Context created")) line = "Context created";
  if (line.startsWith("Context created without metadata fallback")) line = "Context created (fallback)";
  if (line.startsWith("UltraContext daemon started")) line = "Daemon started";
  if (line.startsWith("UltraContext daemon stopped")) line = "Daemon stopped";
  if (line.startsWith("Failed to process file")) line = "File processing warning";
  if (line.startsWith("Failed to create context with metadata")) line = "Context create warning";

  const suffix = level === "error" ? formatDataInline(data) : "";
  if (suffix) line = `${line} ${suffix}`;

  state.recentLogs.push({
    ts: formatTime(),
    level,
    source: logSourceFromData(data),
    text: line,
  });

  const keep = Math.max(cfg.uiRecentLimit, 1);
  while (state.recentLogs.length > keep) state.recentLogs.shift();

  const last = state.recentLogs[state.recentLogs.length - 1];
  if (runtime.wsServer && last) {
    runtime.wsServer.broadcastLog(last);
  }
}

function log(level, message, data) {
  const current = LOG_LEVELS[cfg.logLevel] ?? LOG_LEVELS.info;
  const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (target > current) return;

  pushRecentLog(level, message, data);

  if (cfg.verboseLogs) {
    const stamp = colorize(new Date().toISOString(), ANSI.dim);
    const badge = colorize(`[${String(level).toUpperCase()}]`, levelColor(level));
    console.log(`${stamp} ${badge} ${message}`);
    if (data && typeof data === "object" && Object.keys(data).length > 0) {
      const pretty = JSON.stringify(data, null, 2);
      for (const line of pretty.split("\n")) {
        console.log(`${colorize("  |", ANSI.gray)} ${line}`);
      }
    }
    return;
  }

  const now = formatTime();
  const suffix = formatDataInline(data);
  const line = suffix ? `${message} ${suffix}` : message;
  console.log(`${now} ${String(level).toUpperCase().padEnd(5)} ${line}`);
}

function bumpStat(name, delta = 1) {
  stats[name] = (stats[name] ?? 0) + delta;
}

function humanUptime(ms) {
  const totalSec = Math.max(Math.floor(ms / 1000), 0);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function emitStatusLine() {
  const uptime = humanUptime(Date.now() - stats.startedAt);
  const line = [
    "STATUS",
    `uptime=${uptime}`,
    `cycles=${stats.cycles}`,
    `files=${stats.filesScanned}`,
    `lines=${stats.linesRead}`,
    `parsed=${stats.parsedEvents}`,
    `append=${stats.appended}`,
    `dedupe=${stats.deduped}`,
    `ctx_new=${stats.contextsCreated}`,
    `errors=${stats.errors}`,
  ].join(" ");
  console.log(line);
}

function printVerboseBanner() {
  if (!cfg.verboseLogs) return;
  const rows = [
    "+------------------------------------------+",
    "|        UltraContext Daemon (Verbose)     |",
    "+------------------------------------------+",
  ];
  for (const row of rows) {
    console.log(colorize(row, ANSI.cyan));
  }
}

function errorDetails(error) {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }

  const details = {
    message: error.message ?? String(error),
  };

  if ("status" in error) details.status = error.status;
  if ("url" in error) details.url = error.url;
  if ("bodyText" in error) details.bodyText = error.bodyText;
  return details;
}

function parseBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function serializeConfigPrefs() {
  return {
    bootstrapMode: normalizeBootstrapModeWithPrompt(cfg.bootstrapMode) || "prompt",
    claudeIncludeSubagents: Boolean(cfg.claudeIncludeSubagents),
  };
}

async function persistConfigPrefsToFile(targetFile = cfg.configFile) {
  const target = path.resolve(targetFile);
  let existing = {};
  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed;
    }
  } catch {
    // ignore missing/invalid config file and write fresh merged payload below
  }

  const payload = JSON.stringify(
    {
      ...existing,
      ...serializeConfigPrefs(),
    },
    null,
    2
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${payload}\n`, "utf8");
  return { saved: true, file: target };
}

function persistConfigPrefsToStore(store = runtime.store) {
  if (!store) return;
  store.setConfig(STORE_CONFIG_PREFS_KEY, JSON.stringify(serializeConfigPrefs()));
}

async function loadConfigPrefsFromPath(target) {
  let raw = "";
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { loaded: false, missing: true, raw: "" };
    log("warn", "Failed to read config prefs file", {
      file: target,
      ...errorDetails(error),
    });
    return { loaded: false, missing: false, raw: "" };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log("warn", "Failed to parse config prefs file", {
      file: target,
      ...errorDetails(error),
    });
    return { loaded: false, missing: false, raw };
  }

  applyConfigPrefs(parsed);
  return { loaded: true, missing: false, raw };
}

async function loadConfigPrefsFromFile() {
  const primary = path.resolve(cfg.configFile);
  const loaded = await loadConfigPrefsFromPath(primary);
  return {
    loaded: loaded.loaded,
    source: loaded.loaded ? "primary" : "none",
    file: loaded.loaded ? primary : "",
    raw: loaded.raw ?? "",
  };
}

async function backupConfigFileAsBak(targetFile, sourceRaw = "") {
  const source = path.resolve(targetFile);
  const backup = `${source}.bak`;
  let raw = sourceRaw;

  if (!raw) {
    try {
      raw = await fs.readFile(source, "utf8");
    } catch {
      return { backedUp: false, reason: "missing", backup };
    }
  }

  try {
    await fs.access(backup);
    return { backedUp: false, reason: "exists", backup };
  } catch {
    // continue
  }

  await fs.rename(source, backup);
  await fs.writeFile(source, raw, "utf8");
  return { backedUp: true, reason: "ok", backup };
}

function applyConfigPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  for (const field of PERSISTED_CONFIG_FIELDS) {
    if (!(field in prefs)) continue;
    if (field === "bootstrapMode") {
      cfg.bootstrapMode = normalizeBootstrapModeWithPrompt(prefs.bootstrapMode) || "prompt";
      continue;
    }
    cfg[field] = Boolean(prefs[field]);
  }
}

function loadConfigPrefsFromStore(store = runtime.store) {
  if (!store) return false;
  const raw = store.getConfig(STORE_CONFIG_PREFS_KEY);
  const parsed = parseProtocolJson(raw, null);
  if (!parsed || typeof parsed !== "object") return false;
  applyConfigPrefs(parsed);
  return true;
}

function applyRuntimeSources(sources) {
  runtime.sources = sources;
  state.sourceOrder = sources.map((source) => source.name);
  for (const sourceName of state.sourceOrder) ensureSourceStats(sourceName);
}

function refreshDaemonConfigFromStore(store = runtime.store) {
  if (!store) return false;
  const before = serializeConfigPrefs();
  const loaded = loadConfigPrefsFromStore(store);
  if (!loaded) return false;

  const after = serializeConfigPrefs();
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (!changed) return false;

  if (before.claudeIncludeSubagents !== after.claudeIncludeSubagents) {
    applyRuntimeSources(buildSources());
  }

  log("info", "Reloaded config prefs from local store", {
    claude_subagents: after.claudeIncludeSubagents ? "on" : "off",
    bootstrap_mode: after.bootstrapMode,
  });

  runtime.wsServer?.broadcastConfig();
  return true;
}

function buildDaemonRuntimeSnapshot() {
  return {
    ts: Date.now(),
    mode: "daemon",
    running: Boolean(runtime.daemonRunning),
    pid: process.pid,
    host: cfg.host,
    engineerId: cfg.engineerId,
    stats: { ...stats },
    sourceStats: state.sourceOrder.map((name) => ({
      name,
      ...ensureSourceStats(name),
    })),
  };
}

function publishDaemonRuntimeSnapshot() {
  runtime.wsServer?.broadcastState();
}

function buildSources() {
  const codexGlob = expandHome(process.env.CODEX_GLOB ?? "~/.codex/sessions/**/*.jsonl");
  const claudeGlob = expandHome(process.env.CLAUDE_GLOB ?? "~/.claude/projects/**/*.jsonl");
  const openclawGlob = expandHome(process.env.OPENCLAW_GLOB ?? "~/.openclaw/agents/*/sessions/**/*.jsonl");
  const codexEnabled = boolFromEnv(process.env.INGEST_CODEX, true);
  const claudeEnabled = boolFromEnv(process.env.INGEST_CLAUDE, true);
  const openclawEnabled = boolFromEnv(process.env.INGEST_OPENCLAW, true);

  const sources = [];
  if (codexEnabled) {
    sources.push({
      name: "codex",
      enabled: true,
      globs: [codexGlob],
      parseLine: parseCodexLine,
    });
  }

  if (claudeEnabled) {
    sources.push({
      name: "claude",
      enabled: true,
      globs: [claudeGlob],
      ignoreGlobs: cfg.claudeIncludeSubagents ? [] : ["**/subagents/**"],
      parseLine: parseClaudeCodeLine,
    });
  }

  if (openclawEnabled) {
    sources.push({
      name: "openclaw",
      enabled: true,
      globs: [openclawGlob],
      parseLine: parseOpenClawLine,
    });
  }

  return sources;
}

async function listSourceFiles(source) {
  return fg(source.globs, {
    onlyFiles: true,
    absolute: true,
    followSymbolicLinks: false,
    unique: true,
    suppressErrors: true,
    ignore: source.ignoreGlobs ?? [],
  });
}

function bootstrapStateStoreKey(sources) {
  return createBootstrapStateKey({
    host: cfg.host,
    engineerId: cfg.engineerId,
    sourceNames: sources.map((source) => source.name),
  });
}

function bootstrapModeLabel(mode) {
  return BOOTSTRAP_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
}

function isWithinLast24h(timestamp, nowMs = Date.now()) {
  if (!timestamp) return false;
  const d = new Date(String(timestamp));
  if (Number.isNaN(d.getTime())) return false;
  return nowMs - d.getTime() <= 24 * 60 * 60 * 1000;
}

function offsetStoreKey(sourceName, fileId) {
  return `offset:${sourceName}:${fileId}`;
}

function seenEventStoreKey(sourceName, eventId) {
  return `seen:${sourceName}:${eventId}`;
}

function sessionContextStoreKey(sourceName, sessionId) {
  return `ctx:session:${sourceName}:${cfg.host}:${cfg.engineerId}:${sessionId}`;
}

function dailyContextStoreKey(sourceName, dayKey) {
  return `ctx:daily:${sourceName}:${cfg.host}:${cfg.engineerId}:${dayKey}`;
}

async function primeOffsetsToEof(store, source, shouldStop = () => false) {
  if (shouldStop()) return;
  const files = await listSourceFiles(source);
  for (const filePath of files) {
    if (shouldStop()) break;
    try {
      const stat = await fs.stat(filePath);
      const fileId = `${stat.dev}:${stat.ino}`;
      store.setOffset(offsetStoreKey(source.name, fileId), stat.size);
    } catch {
      // Ignore missing/ephemeral files during bootstrap.
    }
  }
}

function resolveBootstrapPlan({ store, sources }) {
  const key = bootstrapStateStoreKey(sources);
  if (cfg.bootstrapReset) {
    store.deleteConfig(key);
    log("info", "Bootstrap state reset by configuration", { key });
  }

  const forcedMode = normalizeBootstrapMode(cfg.bootstrapMode);
  if (forcedMode) return { mode: forcedMode, needsBootstrap: true, forced: true };

  const stored = normalizeBootstrapMode(store.getConfig(key));
  if (stored) return { mode: stored, needsBootstrap: false, forced: false };

  return { mode: "new_only", needsBootstrap: true, forced: false };
}

async function applyBootstrapMode({ store, sources, mode, needsBootstrap, shouldStop = () => false }) {
  const selected = normalizeBootstrapMode(mode) || "new_only";
  if (!needsBootstrap) return "all";

  if (selected === "new_only") {
    for (const source of sources) {
      if (shouldStop()) break;
      await primeOffsetsToEof(store, source, shouldStop);
    }
  }

  if (shouldStop()) return "all";
  const key = bootstrapStateStoreKey(sources);
  store.setConfig(key, selected);
  if (selected === "last_24h") return "last_24h";
  return "all";
}

function validateConfig() {
  if (!cfg.apiKey) {
    throw new Error("Missing ULTRACONTEXT_API_KEY");
  }
  if (!cfg.apiKey.startsWith("uc_live_") && !cfg.apiKey.startsWith("uc_test_")) {
    log("warn", "ULTRACONTEXT_API_KEY format looks unusual", {
      key_prefix: cfg.apiKey.slice(0, 8),
      key_len: cfg.apiKey.length,
    });
  }
}

function readProcessInfo(pid) {
  try {
    const out = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
      stdio: "pipe",
      encoding: "utf8",
    });
    const raw = String(out.stdout ?? "").trim();
    if (!raw) return null;
    const match = raw.match(/^(\d+)\s+(.*)$/);
    if (!match) return null;
    return {
      ppid: Number(match[1]),
      command: match[2] ?? "",
    };
  } catch {
    return null;
  }
}

function isWatchCommand(command) {
  const raw = String(command ?? "").trim();
  if (!raw) return false;
  return raw.includes("node --watch") || raw.includes(" --watch ");
}

function stopWatchParentProcess() {
  let pid = Number(process.ppid);
  const seen = new Set();
  for (let depth = 0; depth < 10; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    if (seen.has(pid)) return false;
    seen.add(pid);

    const info = readProcessInfo(pid);
    if (!info) return false;
    if (isWatchCommand(info.command)) {
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    }
    pid = Number(info.ppid);
  }
  return false;
}

function markEventSeen(store, sourceName, eventId) {
  return store.markEventSeen(seenEventStoreKey(sourceName, eventId), cfg.dedupeTtlSec);
}

async function getOrCreateContext(store, uc, cacheKey, metadata, sourceName) {
  const cached = store.getContextCache(cacheKey);
  if (cached) return cached;

  try {
    const created = await uc.create({ metadata });
    store.setContextCache(cacheKey, created.id);
    bumpStat("contextsCreated");
    bumpSourceStat(sourceName, "contextsCreated");
    runtime.wsServer?.broadcastEvent({
      action: "created",
      source: sourceName,
      sessionId: String(metadata?.session_id ?? ""),
      contextKind: String(metadata?.context_kind ?? "session"),
      contextId: created.id,
    });
    if (cfg.logAppends) {
      log("info", "Context created", {
        source: sourceName,
        context_id: created.id,
        kind: metadata?.context_kind ?? "session",
        session_id: metadata?.session_id ?? "",
        day: metadata?.day ?? "",
      });
    }
    return created.id;
  } catch (error) {
    const details = errorDetails(error);
    bumpStat("errors");
    bumpSourceStat(sourceName, "errors");
    log("warn", "Failed to create context with metadata", details);

    if (details.status === 400) {
      const created = await uc.create();
      store.setContextCache(cacheKey, created.id);
      bumpStat("contextsCreated");
      bumpSourceStat(sourceName, "contextsCreated");
      runtime.wsServer?.broadcastEvent({
        action: "created",
        source: sourceName,
        sessionId: String(metadata?.session_id ?? ""),
        contextKind: String(metadata?.context_kind ?? "session"),
        contextId: created.id,
      });
      if (cfg.logAppends) {
        log("warn", "Context created without metadata fallback", {
          source: sourceName,
          context_id: created.id,
          kind: metadata?.context_kind ?? "session",
        });
      }
      return created.id;
    }

    throw error;
  }
}

function toDayKey(timestamp) {
  if (timestamp === undefined || timestamp === null) {
    return new Date().toISOString().slice(0, 10);
  }

  if (typeof timestamp === "number" || /^\d+$/.test(String(timestamp))) {
    const asNum = Number(timestamp);
    const ms = asNum > 1e12 ? asNum : asNum * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  const d = new Date(String(timestamp));
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

async function appendToUltraContext({ store, uc, sourceName, normalized, eventId, filePath, lineOffset }) {
  const dayKey = toDayKey(normalized.timestamp);

  const sessionContextId = await getOrCreateContext(
    store,
    uc,
    sessionContextStoreKey(sourceName, normalized.sessionId),
    {
      source: sourceName,
      host: cfg.host,
      engineer_id: cfg.engineerId,
      session_id: normalized.sessionId,
      context_kind: "session",
    },
    sourceName
  );

  const safeRaw = redact(normalized.raw);

  const payload = {
    role: normalized.kind,
    content: {
      message: normalized.message,
      event_type: normalized.eventType,
      timestamp: normalized.timestamp,
      raw: safeRaw,
    },
    metadata: {
      source: sourceName,
      host: cfg.host,
      engineer_id: cfg.engineerId,
      session_id: normalized.sessionId,
      event_id: eventId,
      file_path: filePath,
      file_offset: lineOffset,
      day: dayKey,
    },
  };

  await uc.append(sessionContextId, payload);
  bumpStat("appended");
  bumpSourceStat(sourceName, "appended");
  runtime.wsServer?.broadcastEvent({
    action: "appended",
    source: sourceName,
    sessionId: normalized.sessionId,
    contextKind: "session",
    contextId: sessionContextId,
  });
  noteSourceActivity(sourceName, {
    lastEventType: normalized.eventType,
    lastSessionId: normalized.sessionId,
    lastAt: Date.now(),
  });

  if (cfg.logAppends) {
    log("info", "Appended event to session context", {
      source: sourceName,
      session_id: normalized.sessionId,
      context_id: sessionContextId,
      event_type: normalized.eventType,
      role: normalized.kind,
      event_id: eventId,
    });
  }

  if (!cfg.enableDailyContext) return;

  const dailyContextId = await getOrCreateContext(
    store,
    uc,
    dailyContextStoreKey(sourceName, dayKey),
    {
      source: sourceName,
      host: cfg.host,
      engineer_id: cfg.engineerId,
      day: dayKey,
      context_kind: "daily",
    },
    sourceName
  );

  await uc.append(dailyContextId, payload);
  bumpStat("appended");
  bumpSourceStat(sourceName, "appended");
  if (cfg.logAppends) {
    log("info", "Appended event to daily context", {
      source: sourceName,
      day: dayKey,
      context_id: dailyContextId,
      event_type: normalized.eventType,
      session_id: normalized.sessionId,
      event_id: eventId,
    });
  }
}

async function readNewLines(filePath, offset) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    let start = offset;
    if (start > stat.size) start = 0;
    const unread = stat.size - start;
    if (unread <= 0) {
      return { lines: [], nextOffset: start, fileId: `${stat.dev}:${stat.ino}` };
    }

    const readLen = Math.min(unread, cfg.maxReadBytes);
    const buffer = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await handle.read(buffer, 0, readLen, start);
    const chunk = buffer.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);

    if (lastNewline === -1) {
      return { lines: [], nextOffset: start, fileId: `${stat.dev}:${stat.ino}` };
    }

    const processChunk = chunk.subarray(0, lastNewline + 1);
    const text = processChunk.toString("utf8");
    const split = text.split("\n");

    const lines = [];
    let consumed = 0;
    for (const line of split) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      const lineOffset = start + consumed;
      consumed += lineBytes;
      if (!line.trim()) continue;
      lines.push({ line, lineOffset });
    }

    return {
      lines,
      nextOffset: start + lastNewline + 1,
      fileId: `${stat.dev}:${stat.ino}`,
    };
  } finally {
    await handle.close();
  }
}

async function processFile({ store, uc, source, filePath, shouldStop = () => false, ingestMode = "all" }) {
  if (shouldStop()) return;
  try {
    const stat = await fs.stat(filePath);
    bumpStat("filesScanned");
    bumpSourceStat(source.name, "filesScanned");

    const fileId = `${stat.dev}:${stat.ino}`;
    const offsetKey = offsetStoreKey(source.name, fileId);
    const currentOffset = toInt(store.getOffset(offsetKey), 0);
    const { lines, nextOffset } = await readNewLines(filePath, currentOffset);

    bumpStat("linesRead", lines.length);
    bumpSourceStat(source.name, "linesRead", lines.length);
    noteSourceActivity(source.name, {
      lastFile: filePath,
      lastAt: Date.now(),
    });

    if (lines.length === 0) return;

    for (const { line, lineOffset } of lines) {
      if (shouldStop()) break;
      const normalized = source.parseLine({ line, filePath });
      if (!normalized) continue;
      if (!normalized.sessionId) continue;
      if (ingestMode === "last_24h" && !isWithinLast24h(normalized.timestamp)) continue;

      bumpStat("parsedEvents");
      bumpSourceStat(source.name, "parsedEvents");
      noteSourceActivity(source.name, {
        lastEventType: normalized.eventType,
        lastSessionId: normalized.sessionId,
        lastAt: Date.now(),
      });

      const eventId = sha256(
        `${source.name}|${cfg.host}|${cfg.engineerId}|${normalized.sessionId}|${fileId}|${lineOffset}|${sha256(line)}`
      );

      const isNew = markEventSeen(store, source.name, eventId);
      if (!isNew) {
        bumpStat("deduped");
        bumpSourceStat(source.name, "deduped");
        continue;
      }

      await appendToUltraContext({
        store,
        uc,
        sourceName: source.name,
        normalized,
        eventId,
        filePath,
        lineOffset,
      });
    }

    store.setOffset(offsetKey, nextOffset);
  } catch (error) {
    bumpStat("errors");
    bumpSourceStat(source.name, "errors");
    log("warn", `Failed to process file for source=${source.name}`, {
      filePath,
      ...errorDetails(error),
    });
  }
}

async function processSource({ store, uc, source, shouldStop = () => false, ingestMode = "all" }) {
  if (shouldStop()) return;

  let files = [];
  try {
    files = await listSourceFiles(source);
  } catch (error) {
    bumpStat("errors");
    log("warn", `Failed to list files for source=${source.name}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (files.length === 0) return;
  for (const filePath of files) {
    if (shouldStop()) break;
    await processFile({ store, uc, source, filePath, shouldStop, ingestMode });
  }
}

async function resetBootstrapState() {
  if (!runtime.store) return;
  const sources = runtime.sources ?? buildSources();
  const key = bootstrapStateStoreKey(sources);
  runtime.store.deleteConfig(key);
}

async function persistDaemonConfigEverywhere() {
  persistConfigPrefsToStore(runtime.store);
  await persistConfigPrefsToFile();
  publishDaemonRuntimeSnapshot();
  runtime.wsServer?.broadcastConfig();
}

async function handleWsCommand(message) {
  if (!message || typeof message !== "object") return { ok: true };

  if (message.type === DAEMON_WS_MESSAGE_TYPES.CONFIG_GET) {
    return { config: serializeConfigPrefs() };
  }

  if (message.type === DAEMON_WS_MESSAGE_TYPES.CONFIG_SET) {
    const key = String(message?.data?.key ?? "").trim();
    const value = message?.data?.value;

    if (!key) throw new Error("config key is required");

    if (key === "claudeIncludeSubagents") {
      cfg.claudeIncludeSubagents = parseBool(value, cfg.claudeIncludeSubagents);
      applyRuntimeSources(buildSources());
      await persistDaemonConfigEverywhere();
      log("info", "Config updated via TUI", {
        key,
        value: cfg.claudeIncludeSubagents ? "on" : "off",
      });
      return { config: serializeConfigPrefs() };
    }

    if (key === "bootstrapMode") {
      const next = normalizeBootstrapModeWithPrompt(value);
      if (!next) throw new Error("invalid bootstrap mode");
      cfg.bootstrapMode = next;
      cfg.bootstrapReset = next === "prompt";
      await persistDaemonConfigEverywhere();
      log("info", "Config updated via TUI", {
        key,
        value: cfg.bootstrapMode,
      });
      return { config: serializeConfigPrefs() };
    }

    if (key === "bootstrapReset") {
      cfg.bootstrapReset = parseBool(value, false);
      if (cfg.bootstrapReset) {
        await resetBootstrapState();
      }
      await persistDaemonConfigEverywhere();
      log("info", "Config updated via TUI", {
        key,
        value: cfg.bootstrapReset ? "on" : "off",
      });
      return { config: serializeConfigPrefs() };
    }

    throw new Error(`unsupported config key: ${key}`);
  }

  if (message.type === DAEMON_WS_MESSAGE_TYPES.BOOTSTRAP_RESET) {
    const profile = normalizeBootstrapModeWithPrompt(message?.data?.profile) || "prompt";
    cfg.bootstrapMode = profile;
    cfg.bootstrapReset = true;
    await resetBootstrapState();
    await persistDaemonConfigEverywhere();
    log("info", "Bootstrap reset requested via TUI", {
      profile,
    });
    return {
      ok: true,
      config: serializeConfigPrefs(),
      reset: true,
    };
  }

  return { ignored: true };
}

async function stopRuntimeResources() {
  if (daemonStateTimer) {
    clearInterval(daemonStateTimer);
    daemonStateTimer = null;
  }

  runtime.daemonRunning = false;

  try {
    publishDaemonRuntimeSnapshot();
  } catch {
    // ignore
  }

  if (runtime.wsServer) {
    try {
      await runtime.wsServer.stop();
    } catch (error) {
      log("warn", "Failed to stop WS server", errorDetails(error));
    }
    runtime.wsServer = null;
  }

  if (runtime.lockHandle) {
    try {
      await runtime.lockHandle.release();
    } catch (error) {
      log("warn", "Failed to release daemon lock", errorDetails(error));
    }
    runtime.lockHandle = null;
  }

  if (runtime.store) {
    try {
      runtime.store.close();
    } catch (error) {
      log("warn", "Failed to close local store", errorDetails(error));
    }
    runtime.store = null;
  }

  runtime.uc = null;
  runtime.stop = null;
  runtime.sources = null;
  runtime.ingestMode = "all";
}

async function daemonMain() {
  validateConfig();
  printVerboseBanner();

  const store = createStore({ dbPath: cfg.dbFile });
  runtime.store = store;

  try {
    const fileLoad = await loadConfigPrefsFromFile();
    const loadedFromFile = fileLoad.loaded;
    const loadedFromStore = loadConfigPrefsFromStore(store);

    if (loadedFromFile || loadedFromStore) {
      log("info", "Loaded persisted config preferences", {
        file: loadedFromFile ? "yes" : "no",
        file_source: loadedFromFile ? fileLoad.source : "none",
        file_path: loadedFromFile ? fileLoad.file : "",
        store: loadedFromStore ? "yes" : "no",
        db_path: cfg.dbFile,
      });
    }

    if (loadedFromStore && !loadedFromFile) {
      await persistConfigPrefsToFile();
      log("info", "Materialized store config prefs into file", {
        file_saved: "yes",
      });
    }

    if (loadedFromFile && !loadedFromStore) {
      persistConfigPrefsToStore(store);
      const backup = await backupConfigFileAsBak(fileLoad.file || cfg.configFile, fileLoad.raw);
      log("info", "Materialized file config prefs into store", {
        db_saved: "yes",
        file_backup: backup.backedUp ? "yes" : "no",
        backup_path: backup.backup,
      });
    }

    if (!loadedFromFile && !loadedFromStore) {
      persistConfigPrefsToStore(store);
      await persistConfigPrefsToFile();
      log("info", "Created default runtime config file", {
        file: path.resolve(cfg.configFile),
      });
    }
  } catch (error) {
    log("warn", "Failed to load persisted config preferences", errorDetails(error));
  }

  const sources = buildSources();
  if (sources.length === 0) {
    throw new Error("No sources enabled. Set INGEST_CODEX=true and/or INGEST_CLAUDE=true");
  }
  applyRuntimeSources(sources);

  runtime.lockHandle = await acquireFileLock({
    lockPath: cfg.lockFile,
    engineerId: cfg.engineerId,
    host: cfg.host,
  });

  const uc = new UltraContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  runtime.uc = uc;

  try {
    await uc.get({ limit: 1 });
  } catch (error) {
    const details = errorDetails(error);
    throw new Error(
      `UltraContext auth/connectivity check failed (status=${details.status ?? "?"}, url=${details.url ?? cfg.baseUrl}, body=${details.bodyText ?? details.message})`
    );
  }

  const wsServer = createWsServer({
    host: cfg.wsHost,
    port: cfg.wsPort,
    infoFilePath: cfg.wsInfoFile,
    heartbeatMs: 5000,
    getSnapshot: buildDaemonRuntimeSnapshot,
    getLogs: () => state.recentLogs.slice(-runtimeLogsKeep()),
    getConfig: serializeConfigPrefs,
    onCommand: handleWsCommand,
  });
  runtime.wsServer = wsServer;
  const wsInfo = await wsServer.start();

  log("info", "UltraContext daemon started", {
    engineer_id: cfg.engineerId,
    host: cfg.host,
    poll_ms: cfg.pollMs,
    mode: "headless",
    ws_host: wsInfo.host,
    ws_port: wsInfo.port,
    ws_info_file: cfg.wsInfoFile,
    db_file: cfg.dbFile,
    sources: sources.map((s) => ({ name: s.name, globs: s.globs })),
  });

  runtime.daemonRunning = true;
  publishDaemonRuntimeSnapshot();

  daemonStateTimer = setInterval(() => {
    try {
      publishDaemonRuntimeSnapshot();
    } catch {
      // ignore
    }
  }, Math.max(cfg.uiRefreshMs, 500));
  daemonStateTimer.unref?.();

  let running = true;
  let stopRequested = false;
  const stop = (reason = "internal") => {
    if (stopRequested) return;
    stopRequested = true;
    if (reason === "user" || reason === "sigint") {
      stopWatchParentProcess();
    }
    running = false;
  };
  runtime.stop = stop;

  process.on("SIGINT", () => stop("sigint"));
  process.on("SIGTERM", () => stop("sigterm"));

  runtime.ingestMode = "all";
  if (running) {
    const bootstrapPlan = resolveBootstrapPlan({ store, sources });
    if (running) {
      runtime.ingestMode = await applyBootstrapMode({
        store,
        sources,
        mode: bootstrapPlan.mode,
        needsBootstrap: bootstrapPlan.needsBootstrap,
        shouldStop: () => !running,
      });
      log("info", "Bootstrap mode resolved", {
        mode: bootstrapPlan.mode,
        mode_label: bootstrapModeLabel(bootstrapPlan.mode),
        applied: bootstrapPlan.needsBootstrap ? "yes" : "no",
        ingest_mode: runtime.ingestMode,
      });
    }
  }

  while (running) {
    try {
      refreshDaemonConfigFromStore(store);
    } catch (error) {
      log("warn", "Failed to refresh daemon config from local store", errorDetails(error));
    }

    bumpStat("cycles");
    const cycleStart = Date.now();
    const cycleSources = runtime.sources ?? [];

    for (const source of cycleSources) {
      if (!running) break;
      await processSource({
        store,
        uc,
        source,
        shouldStop: () => !running,
        ingestMode: runtime.ingestMode ?? "all",
      });
    }

    if (stats.cycles % cfg.cleanupEveryCycles === 0) {
      try {
        store.cleanupExpired();
      } catch {
        // ignore cleanup failures
      }
    }

    publishDaemonRuntimeSnapshot();

    if (!running) break;
    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(cfg.pollMs - elapsed, 10);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  runtime.daemonRunning = false;
  publishDaemonRuntimeSnapshot();

  emitStatusLine();
  await stopRuntimeResources();

  log("info", "UltraContext daemon stopped");
}

installStdioErrorGuards();

daemonMain().catch(async (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isAlreadyRunning = error?.code === "ELOCKED" || errorMessage.startsWith("UltraContext daemon already running");

  await stopRuntimeResources();

  if (isAlreadyRunning) {
    log("warn", "UltraContext already running", { error: errorMessage });
    stopWatchParentProcess();
  } else {
    bumpStat("errors");
    log("error", "UltraContext failed", { error: errorMessage });
  }

  process.exit(isAlreadyRunning ? 2 : 1);
});
