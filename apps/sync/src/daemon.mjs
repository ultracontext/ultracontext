// daemon core — receives store factory as param so callers control env/sqlite
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import fg from "fast-glob";
import { UltraContext } from "ultracontext";
import {
  createBootstrapStateKey,
  normalizeBootstrapMode,
  parseProtocolJson,
} from "./protocol.mjs";

import { acquireFileLock, resolveLockPath } from "./lock.mjs";
import { redact } from "./redact.mjs";
import { parseClaudeCodeLine, parseCodexLine, parseGstackLine, parseOpenClawLine } from "@ultracontext/parsers";
import { boolFromEnv, expandHome, extractProjectPathFromFile, sha256, toInt } from "./utils.mjs";

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_RUNTIME_CONFIG_FILE = "~/.ultracontext/config.json";
const BOOTSTRAP_OPTIONS = [
  { id: "new_only", label: "New only (recommended)" },
  { id: "last_24h", label: "Last 24h" },
  { id: "all", label: "All" },
  { id: "prompt", label: "Ask on startup" },
];
const cliArgs = new Set(process.argv.slice(2));

// file-based IPC paths
const STATUS_FILE = path.join(os.homedir(), ".ultracontext", "status.json");
const CONFIG_FILE = path.join(os.homedir(), ".ultracontext", "config.json");

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

// ── file-based IPC helpers ─────────────────────────────────────

async function writeStatusJson(cfg, stats, state, runtime) {
  const snapshot = {
    pid: process.pid,
    startedAt: new Date(stats.startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    host: cfg.host,
    userId: cfg.userId,
    mode: runtime.ingestMode,
    running: runtime.daemonRunning,
    stats: { ...stats },
    sources: state.sourceOrder.map(name => {
      const s = state.sourceStats.get(name) || {};
      return { name, ...s };
    }),
    recentLogs: state.recentLogs.slice(-240),
    config: { bootstrapMode: cfg.bootstrapMode, claudeIncludeSubagents: cfg.claudeIncludeSubagents },
  };
  const tmp = STATUS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  await fs.rename(tmp, STATUS_FILE);
}

async function readConfigJson() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeConfigJson(data) {
  const tmp = CONFIG_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(tmp, CONFIG_FILE);
}

// ── bootstrap state (persisted in config.json under _bootstrapState) ──

function getBootstrapState(key) {
  try {
    const raw = fsSync.readFileSync(CONFIG_FILE, "utf8");
    const data = JSON.parse(raw);
    return data?._bootstrapState?.[key] ?? "";
  } catch { return ""; }
}

function setBootstrapState(key, value) {
  try {
    let data = {};
    try { data = JSON.parse(fsSync.readFileSync(CONFIG_FILE, "utf8")); } catch { /* empty */ }
    if (!data._bootstrapState) data._bootstrapState = {};
    data._bootstrapState[key] = String(value);
    const tmp = CONFIG_FILE + ".tmp.bs";
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fsSync.renameSync(tmp, CONFIG_FILE);
  } catch { /* best effort */ }
}

function deleteBootstrapState(key) {
  try {
    let data = {};
    try { data = JSON.parse(fsSync.readFileSync(CONFIG_FILE, "utf8")); } catch { /* empty */ }
    if (data._bootstrapState) delete data._bootstrapState[key];
    const tmp = CONFIG_FILE + ".tmp.bs";
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fsSync.renameSync(tmp, CONFIG_FILE);
  } catch { /* best effort */ }
}

// ── exported boot function ──────────────────────────────────────

export async function daemonBoot({ createStore, resolveDbPath }) {
  const cfg = {
    apiKey: normalizeApiKey(process.env.ULTRACONTEXT_API_KEY),
    baseUrl: (process.env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai").trim(),
    userId: process.env.DAEMON_USER_ID ?? process.env.USER ?? "unknown-user",
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
    dedupeTtlSec: toInt(process.env.DAEMON_DEDUPE_TTL_SEC, 60 * 60 * 24 * 30),
    maxReadBytes: toInt(process.env.DAEMON_MAX_READ_BYTES, 4 * 1024 * 1024),
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

  let stdioErrorHandled = false;

  const runtime = {
    uc: null,
    stop: null,
    store: null,
    sources: null,
    ingestMode: "all",
    daemonRunning: false,
    lockHandle: null,
  };

  // ── stdio guards ──

  function isBenignStdioError(error) {
    const code = String(error?.code ?? "");
    return code === "EIO" || code === "EPIPE" || code === "ENXIO";
  }

  function handleStdioError(error, streamName) {
    if (!isBenignStdioError(error)) return;
    if (stdioErrorHandled) return;
    stdioErrorHandled = true;
    try { runtime.stop?.("stdio"); } catch { /* ignore */ }
    if (LOG_LEVELS[cfg.logLevel] >= LOG_LEVELS.debug) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[debug] Ignored stdio ${streamName} error (${error?.code ?? "?"}): ${msg}`);
    }
  }

  process.stdin?.on?.("error", (error) => handleStdioError(error, "stdin"));
  process.stdout?.on?.("error", (error) => handleStdioError(error, "stdout"));
  process.stderr?.on?.("error", (error) => handleStdioError(error, "stderr"));

  // ── helpers ──

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
    return entries.map(([k, v]) => `${k}=${compactValue(v)}`).join(" ");
  }

  function ensureSourceStats(sourceName) {
    if (!state.sourceStats.has(sourceName)) {
      state.sourceStats.set(sourceName, {
        filesScanned: 0, linesRead: 0, parsedEvents: 0,
        appended: 0, deduped: 0, contextsCreated: 0, errors: 0,
        lastEventType: "-", lastSessionId: "-", lastAt: 0, lastFile: "-",
      });
    }
    return state.sourceStats.get(sourceName);
  }

  function bumpSourceStat(sourceName, key, delta = 1) {
    const current = ensureSourceStats(sourceName);
    current[key] = (current[key] ?? 0) + delta;
  }

  function noteSourceActivity(sourceName, patch) {
    Object.assign(ensureSourceStats(sourceName), patch ?? {});
  }

  function logSourceFromData(data) {
    if (!data || typeof data !== "object") return "";
    for (const value of [data.source, data.context_source, data.contextSource, data?.metadata?.source]) {
      const raw = String(value ?? "").trim();
      if (raw) return raw.toLowerCase();
    }
    return "";
  }

  function pushRecentLog(level, message, data) {
    let line = String(message ?? "");
    if (line.startsWith("Appended event to session context")) line = "context append";
    if (line.startsWith("Context created")) line = "Context created";
    if (line.startsWith("Context created without metadata fallback")) line = "Context created (fallback)";
    if (line.startsWith("UltraContext daemon started")) line = "Daemon started";
    if (line.startsWith("UltraContext daemon stopped")) line = "Daemon stopped";
    if (line.startsWith("Failed to process file")) line = "File processing warning";
    if (line.startsWith("Failed to create context with metadata")) line = "Context create warning";

    const suffix = level === "error" ? formatDataInline(data) : "";
    if (suffix) line = `${line} ${suffix}`;

    state.recentLogs.push({ ts: formatTime(), level, source: logSourceFromData(data), text: line });
    const keep = runtimeLogsKeep();
    while (state.recentLogs.length > keep) state.recentLogs.shift();
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
        for (const line of JSON.stringify(data, null, 2).split("\n")) {
          console.log(`${colorize("  |", ANSI.gray)} ${line}`);
        }
      }
      return;
    }

    const now = formatTime();
    const suffix = formatDataInline(data);
    const finalLine = suffix ? `${message} ${suffix}` : message;
    console.log(`${now} ${String(level).toUpperCase().padEnd(5)} ${finalLine}`);
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
    console.log([
      "STATUS", `uptime=${humanUptime(Date.now() - stats.startedAt)}`,
      `cycles=${stats.cycles}`, `files=${stats.filesScanned}`, `lines=${stats.linesRead}`,
      `parsed=${stats.parsedEvents}`, `append=${stats.appended}`, `dedupe=${stats.deduped}`,
      `ctx_new=${stats.contextsCreated}`, `errors=${stats.errors}`,
    ].join(" "));
  }

  function printVerboseBanner() {
    if (!cfg.verboseLogs) return;
    for (const row of [
      "+------------------------------------------+",
      "|        UltraContext Daemon (Verbose)     |",
      "+------------------------------------------+",
    ]) console.log(colorize(row, ANSI.cyan));
  }

  function errorDetails(error) {
    if (!error || typeof error !== "object") return { message: String(error) };
    const details = { message: error.message ?? String(error) };
    if ("status" in error) details.status = error.status;
    if ("url" in error) details.url = error.url;
    if ("bodyText" in error) details.bodyText = error.bodyText;
    return details;
  }

  // ── config persistence (file-only) ──

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
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
    } catch { /* ignore */ }

    const payload = JSON.stringify({ ...existing, ...serializeConfigPrefs() }, null, 2);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${payload}\n`, "utf8");
    return { saved: true, file: target };
  }

  async function loadConfigPrefsFromPath(target) {
    let raw = "";
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { loaded: false, missing: true, raw: "" };
      log("warn", "Failed to read config prefs file", { file: target, ...errorDetails(error) });
      return { loaded: false, missing: false, raw: "" };
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (error) {
      log("warn", "Failed to parse config prefs file", { file: target, ...errorDetails(error) });
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

  function applyConfigPrefs(prefs) {
    if (!prefs || typeof prefs !== "object") return;
    const fields = ["bootstrapMode", "claudeIncludeSubagents"];
    for (const field of fields) {
      if (!(field in prefs)) continue;
      if (field === "bootstrapMode") {
        cfg.bootstrapMode = normalizeBootstrapModeWithPrompt(prefs.bootstrapMode) || "prompt";
        continue;
      }
      cfg[field] = Boolean(prefs[field]);
    }
  }

  // ── config.json reading each cycle ──

  async function refreshConfigFromFile() {
    const data = await readConfigJson();
    if (!data || typeof data !== "object") return;

    // apply setting changes
    const before = serializeConfigPrefs();
    applyConfigPrefs(data);
    const after = serializeConfigPrefs();

    // rebuild sources if subagent toggle changed
    if (before.claudeIncludeSubagents !== after.claudeIncludeSubagents) {
      applyRuntimeSources(buildSources());
    }

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      log("info", "Reloaded config from config.json", {
        claude_subagents: after.claudeIncludeSubagents ? "on" : "off",
        bootstrap_mode: after.bootstrapMode,
      });
    }

    // handle bootstrapReset command flag
    if (data.bootstrapReset) {
      cfg.bootstrapReset = true;
      await resetBootstrapState();
      log("info", "Bootstrap reset triggered via config.json");

      // clear the flag by writing config.json back
      const cleaned = { ...data };
      delete cleaned.bootstrapReset;
      await writeConfigJson(cleaned);
    }
  }

  // ── sources ──

  function applyRuntimeSources(sources) {
    runtime.sources = sources;
    state.sourceOrder = sources.map((s) => s.name);
    for (const name of state.sourceOrder) ensureSourceStats(name);
  }

  function buildSources() {
    const codexGlob = expandHome(process.env.CODEX_GLOB ?? "~/.codex/sessions/**/*.jsonl");
    const claudeGlob = expandHome(process.env.CLAUDE_GLOB ?? "~/.claude/projects/**/*.jsonl");
    const openclawGlob = expandHome(process.env.OPENCLAW_GLOB ?? "~/.openclaw/agents/*/sessions/**/*.jsonl");

    const sources = [];
    if (boolFromEnv(process.env.INGEST_CODEX, true)) {
      sources.push({ name: "codex", enabled: true, globs: [codexGlob], parseLine: parseCodexLine });
    }
    if (boolFromEnv(process.env.INGEST_CLAUDE, true)) {
      sources.push({
        name: "claude", enabled: true, globs: [claudeGlob],
        ignoreGlobs: cfg.claudeIncludeSubagents ? [] : ["**/subagents/**"],
        parseLine: parseClaudeCodeLine,
      });
    }
    if (boolFromEnv(process.env.INGEST_OPENCLAW, true)) {
      sources.push({ name: "openclaw", enabled: true, globs: [openclawGlob], parseLine: parseOpenClawLine });
    }

    // gstack — skill artifacts (learnings, timeline, reviews, resources)
    const gstackGlob = expandHome(process.env.GSTACK_GLOB ?? "~/.gstack/projects/**/*.jsonl");
    if (boolFromEnv(process.env.INGEST_GSTACK, true)) {
      sources.push({ name: "gstack", enabled: true, globs: [gstackGlob], parseLine: parseGstackLine });
    }

    return sources;
  }

  async function listSourceFiles(source) {
    return fg(source.globs, {
      onlyFiles: true, absolute: true, followSymbolicLinks: false,
      unique: true, suppressErrors: true, ignore: source.ignoreGlobs ?? [],
    });
  }

  // ── bootstrap ──

  function bootstrapStateStoreKey(sources) {
    return createBootstrapStateKey({
      host: cfg.host, userId: cfg.userId,
      sourceNames: sources.map((s) => s.name),
    });
  }

  function bootstrapModeLabel(mode) {
    return BOOTSTRAP_OPTIONS.find((o) => o.id === mode)?.label ?? mode;
  }

  function isWithinLast24h(timestamp, nowMs = Date.now()) {
    if (!timestamp) return false;
    const d = new Date(String(timestamp));
    if (Number.isNaN(d.getTime())) return false;
    return nowMs - d.getTime() <= 24 * 60 * 60 * 1000;
  }

  function offsetStoreKey(sourceName, fileId) { return `offset:${sourceName}:${fileId}`; }
  function seenEventStoreKey(sourceName, eventId) { return `seen:${sourceName}:${eventId}`; }
  function sessionContextStoreKey(sourceName, sessionId) { return `ctx:session:${sourceName}:${cfg.host}:${cfg.userId}:${sessionId}`; }

  async function primeOffsetsToEof(store, source, shouldStop = () => false) {
    if (shouldStop()) return;
    const files = await listSourceFiles(source);
    for (const filePath of files) {
      if (shouldStop()) break;
      try {
        const stat = await fs.stat(filePath);
        store.setOffset(offsetStoreKey(source.name, `${stat.dev}:${stat.ino}`), stat.size);
      } catch { /* ignore */ }
    }
  }

  function resolveBootstrapPlan({ sources }) {
    const key = bootstrapStateStoreKey(sources);
    if (cfg.bootstrapReset) {
      deleteBootstrapState(key);
      log("info", "Bootstrap state reset by configuration", { key });
    }
    const forcedMode = normalizeBootstrapMode(cfg.bootstrapMode);
    if (forcedMode) return { mode: forcedMode, needsBootstrap: true, forced: true };
    const stored = normalizeBootstrapMode(getBootstrapState(key));
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
    setBootstrapState(bootstrapStateStoreKey(sources), selected);
    if (selected === "last_24h") return "last_24h";
    return "all";
  }

  // ── validation ──

  function validateConfig() {
    if (!cfg.apiKey) throw new Error("Missing ULTRACONTEXT_API_KEY. Run `ultracontext config` to set up your API key.");
    if (!cfg.apiKey.startsWith("uc_live_") && !cfg.apiKey.startsWith("uc_test_")) {
      log("warn", "ULTRACONTEXT_API_KEY format looks unusual", { key_prefix: cfg.apiKey.slice(0, 8), key_len: cfg.apiKey.length });
    }
  }

  // ── process helpers ──

  function readProcessInfo(pid) {
    try {
      const out = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { stdio: "pipe", encoding: "utf8" });
      const raw = String(out.stdout ?? "").trim();
      if (!raw) return null;
      const match = raw.match(/^(\d+)\s+(.*)$/);
      if (!match) return null;
      return { ppid: Number(match[1]), command: match[2] ?? "" };
    } catch { return null; }
  }

  function isWatchCommand(command) {
    const raw = String(command ?? "").trim();
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
        try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
      }
      pid = Number(info.ppid);
    }
    return false;
  }

  // ── event ingestion ──

  function markEventSeen(store, sourceName, eventId) {
    return store.markEventSeen(seenEventStoreKey(sourceName, eventId), cfg.dedupeTtlSec);
  }

  // prevent duplicate context creation when files are processed in parallel
  const contextCreateInflight = new Map();

  async function getOrCreateContext(store, uc, cacheKey, metadata, sourceName) {
    const cached = store.getContextCache(cacheKey);
    if (cached) return cached;

    // coalesce concurrent creates for the same cache key
    if (contextCreateInflight.has(cacheKey)) return contextCreateInflight.get(cacheKey);

    const pending = (async () => {
      try {
        const created = await uc.create({ metadata });
        store.setContextCache(cacheKey, created.id);
        bumpStat("contextsCreated");
        bumpSourceStat(sourceName, "contextsCreated");
        if (cfg.logAppends) {
          log("info", "Context created", {
            source: sourceName, context_id: created.id,
            session_id: metadata?.session_id ?? "",
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
          if (cfg.logAppends) {
            log("warn", "Context created without metadata fallback", {
              source: sourceName, context_id: created.id,
            });
          }
          return created.id;
        }
        throw error;
      } finally {
        contextCreateInflight.delete(cacheKey);
      }
    })();

    contextCreateInflight.set(cacheKey, pending);
    return pending;
  }

  async function appendToUltraContext({ store, uc, sourceName, normalized, eventId, filePath, lineOffset }) {

    // enrich context metadata with project path + first event timestamp
    const contextMeta = {
      source: sourceName, host: cfg.host, user_id: cfg.userId,
      session_id: normalized.sessionId,
      started_at: normalized.timestamp,
    };
    const projectPath = extractProjectPathFromFile(filePath);
    if (projectPath) contextMeta.project_path = projectPath;

    const sessionContextId = await getOrCreateContext(store, uc,
      sessionContextStoreKey(sourceName, normalized.sessionId),
      contextMeta, sourceName,
    );

    const safeRaw = redact(normalized.raw);
    const payload = {
      role: normalized.kind,
      content: { message: normalized.message, event_type: normalized.eventType, timestamp: normalized.timestamp, raw: safeRaw },
      metadata: { source: sourceName, host: cfg.host, user_id: cfg.userId, session_id: normalized.sessionId, event_id: eventId, file_path: filePath, file_offset: lineOffset },
    };

    await uc.append(sessionContextId, payload);
    bumpStat("appended");
    bumpSourceStat(sourceName, "appended");
    noteSourceActivity(sourceName, { lastEventType: normalized.eventType, lastSessionId: normalized.sessionId, lastAt: Date.now() });

    if (cfg.logAppends) {
      log("info", "Appended event to session context", {
        source: sourceName, session_id: normalized.sessionId, context_id: sessionContextId,
        event_type: normalized.eventType, role: normalized.kind, event_id: eventId,
      });
    }
  }

  // bulk ingestion tunables
  const BULK_BATCH_SIZE = 50;
  const FILE_CONCURRENCY = 8;
  const SESSION_CONCURRENCY = 6;

  // run async tasks with bounded concurrency
  async function parallelMap(items, concurrency, fn) {
    const results = [];
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
  }

  async function appendBulkToUltraContext({ store, uc, sourceName, events, filePath }) {

    // group events by session id
    const bySession = new Map();
    for (const ev of events) {
      const key = ev.normalized.sessionId;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(ev);
    }

    // resolve all context ids first (sequential — touches local store)
    const sessionEntries = [...bySession.entries()];
    const projectPath = extractProjectPathFromFile(filePath);
    const contextIds = new Map();
    for (const [sessionId, sessionEvents] of sessionEntries) {
      const contextMeta = {
        source: sourceName, host: cfg.host, user_id: cfg.userId,
        session_id: sessionId,
        started_at: sessionEvents[0].normalized.timestamp,
      };
      if (projectPath) contextMeta.project_path = projectPath;

      // extract title from first real user message
      const isRealUserEvent = (ev) => {
        if (ev.normalized.kind !== "user") return false;
        const et = ev.normalized.eventType ?? "";
        const msg = ev.normalized.message ?? "";
        // skip codex system-injected user messages (AGENTS.md, permissions)
        if (et === "response_item.message") return false;
        // skip openclaw session init + claude tool results + xml tags
        if (msg.startsWith("A new session was started")) return false;
        if (msg.startsWith("[result]")) return false;
        if (msg.startsWith("<")) return false;
        return true;
      };
      const firstUserEvent = sessionEvents.find(isRealUserEvent)
        ?? sessionEvents.find(ev => ev.normalized.kind === "user");
      if (firstUserEvent?.normalized?.message) {
        contextMeta.title = firstUserEvent.normalized.message.replace(/[\r\n\t\v\f\x00-\x1f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 120);
      }
      const ctxId = await getOrCreateContext(store, uc,
        sessionContextStoreKey(sourceName, sessionId),
        contextMeta, sourceName,
      );
      contextIds.set(sessionId, ctxId);
    }

    // send bulk requests in parallel across sessions
    await parallelMap(sessionEntries, SESSION_CONCURRENCY, async ([sessionId, sessionEvents]) => {
      const sessionContextId = contextIds.get(sessionId);

      // build payloads array
      const payloads = sessionEvents.map(({ normalized, eventId, lineOffset }) => {
        const safeRaw = redact(normalized.raw);
        return {
          role: normalized.kind,
          content: { message: normalized.message, event_type: normalized.eventType, timestamp: normalized.timestamp, raw: safeRaw },
          metadata: { source: sourceName, host: cfg.host, user_id: cfg.userId, session_id: sessionId, event_id: eventId, file_path: filePath, file_offset: lineOffset },
        };
      });

      // send in batches of BULK_BATCH_SIZE
      for (let i = 0; i < payloads.length; i += BULK_BATCH_SIZE) {
        const batch = payloads.slice(i, i + BULK_BATCH_SIZE);
        await uc.append(sessionContextId, batch);
      }

      // update stats
      bumpStat("appended", sessionEvents.length);
      bumpSourceStat(sourceName, "appended", sessionEvents.length);
      const last = sessionEvents[sessionEvents.length - 1].normalized;
      noteSourceActivity(sourceName, { lastEventType: last.eventType, lastSessionId: sessionId, lastAt: Date.now() });

      if (cfg.logAppends) {
        const lastMsg = (last.message ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 60);
        log("info", `${sessionEvents.length} events → [${last.eventType}] ${lastMsg}`, {
          source: sourceName, session_id: sessionId, context_id: sessionContextId, count: sessionEvents.length,
        });
      }
    });
  }

  // ── file reading ──

  async function readNewLines(filePath, offset) {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      let start = offset;
      if (start > stat.size) start = 0;
      const unread = stat.size - start;
      if (unread <= 0) return { lines: [], nextOffset: start, fileId: `${stat.dev}:${stat.ino}` };

      const readLen = Math.min(unread, cfg.maxReadBytes);
      const buffer = Buffer.allocUnsafe(readLen);
      const { bytesRead } = await handle.read(buffer, 0, readLen, start);
      const chunk = buffer.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline === -1) return { lines: [], nextOffset: start, fileId: `${stat.dev}:${stat.ino}` };

      const text = chunk.subarray(0, lastNewline + 1).toString("utf8");
      const lines = [];
      let consumed = 0;
      for (const line of text.split("\n")) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        const lineOffset = start + consumed;
        consumed += lineBytes;
        if (!line.trim()) continue;
        lines.push({ line, lineOffset });
      }
      return { lines, nextOffset: start + lastNewline + 1, fileId: `${stat.dev}:${stat.ino}` };
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
      noteSourceActivity(source.name, { lastFile: filePath, lastAt: Date.now() });
      if (lines.length === 0) return;

      // collect all new events, then bulk-append per session
      const pendingEvents = [];

      for (const { line, lineOffset } of lines) {
        if (shouldStop()) break;
        const normalized = source.parseLine({ line, filePath });
        if (!normalized || !normalized.sessionId) continue;
        if (ingestMode === "last_24h" && !isWithinLast24h(normalized.timestamp)) continue;

        bumpStat("parsedEvents");
        bumpSourceStat(source.name, "parsedEvents");
        noteSourceActivity(source.name, { lastEventType: normalized.eventType, lastSessionId: normalized.sessionId, lastAt: Date.now() });

        const eventId = sha256(`${source.name}|${cfg.host}|${cfg.userId}|${normalized.sessionId}|${fileId}|${lineOffset}|${sha256(line)}`);
        const isNew = markEventSeen(store, source.name, eventId);
        if (!isNew) { bumpStat("deduped"); bumpSourceStat(source.name, "deduped"); continue; }

        pendingEvents.push({ normalized, eventId, lineOffset });
      }

      // bulk append all collected events
      if (pendingEvents.length > 0) {
        await appendBulkToUltraContext({ store, uc, sourceName: source.name, events: pendingEvents, filePath });
      }

      store.setOffset(offsetKey, nextOffset);
    } catch (error) {
      bumpStat("errors");
      bumpSourceStat(source.name, "errors");
      log("warn", `Failed to process file for source=${source.name}`, { filePath, ...errorDetails(error) });
    }
  }

  async function processSource({ store, uc, source, shouldStop = () => false, ingestMode = "all" }) {
    if (shouldStop()) return;
    let files = [];
    try { files = await listSourceFiles(source); } catch (error) {
      bumpStat("errors");
      log("warn", `Failed to list files for source=${source.name}`, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    // process files concurrently
    await parallelMap(
      files.filter(() => !shouldStop()),
      FILE_CONCURRENCY,
      (filePath) => processFile({ store, uc, source, filePath, shouldStop, ingestMode }),
    );
  }

  // ── runtime commands ──

  async function resetBootstrapState() {
    const sources = runtime.sources ?? buildSources();
    deleteBootstrapState(bootstrapStateStoreKey(sources));
  }

  // ── cleanup ──

  async function stopRuntimeResources() {
    runtime.daemonRunning = false;
    if (runtime.lockHandle) { try { await runtime.lockHandle.release(); } catch (e) { log("warn", "Failed to release daemon lock", errorDetails(e)); } runtime.lockHandle = null; }
    if (runtime.store) { try { runtime.store.close(); } catch (e) { log("warn", "Failed to close local store", errorDetails(e)); } runtime.store = null; }
    runtime.uc = null;
    runtime.stop = null;
    runtime.sources = null;
    runtime.ingestMode = "all";
  }

  // ── main loop ──

  async function daemonMain() {
    validateConfig();
    printVerboseBanner();

    const store = createStore({ dbPath: cfg.dbFile });
    runtime.store = store;

    // load persisted config from file
    try {
      const fileLoad = await loadConfigPrefsFromFile();
      if (fileLoad.loaded) {
        log("info", "Loaded persisted config preferences", {
          file_source: fileLoad.source, file_path: fileLoad.file,
        });
      } else {
        await persistConfigPrefsToFile();
        log("info", "Created default runtime config file", { file: path.resolve(cfg.configFile) });
      }
    } catch (error) {
      log("warn", "Failed to load persisted config preferences", errorDetails(error));
    }

    // sources + lock
    const sources = buildSources();
    if (sources.length === 0) throw new Error("No sources enabled. Set INGEST_CODEX=true, INGEST_CLAUDE=true, and/or INGEST_GSTACK=true");
    applyRuntimeSources(sources);

    runtime.lockHandle = await acquireFileLock({ lockPath: cfg.lockFile, userId: cfg.userId, host: cfg.host });

    const uc = new UltraContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    runtime.uc = uc;

    // connectivity check
    try { await uc.get({ limit: 1 }); } catch (error) {
      const details = errorDetails(error);
      throw new Error(`UltraContext auth/connectivity check failed (status=${details.status ?? "?"}, url=${details.url ?? cfg.baseUrl}, body=${details.bodyText ?? details.message}). Check your API key at https://ultracontext.ai`);
    }

    log("info", "UltraContext daemon started", {
      user_id: cfg.userId, host: cfg.host, poll_ms: cfg.pollMs, mode: "headless",
      db_file: cfg.dbFile,
      sources: sources.map((s) => ({ name: s.name, globs: s.globs })),
    });

    runtime.daemonRunning = true;

    // main poll loop
    let running = true;
    let stopRequested = false;
    const stop = (reason = "internal") => {
      if (stopRequested) return;
      stopRequested = true;
      if (reason === "user" || reason === "sigint") stopWatchParentProcess();
      running = false;
    };
    runtime.stop = stop;

    process.on("SIGINT", () => stop("sigint"));
    process.on("SIGTERM", () => stop("sigterm"));

    // bootstrap
    runtime.ingestMode = "all";
    if (running) {
      const bootstrapPlan = resolveBootstrapPlan({ store, sources });
      if (running) {
        runtime.ingestMode = await applyBootstrapMode({
          store, sources, mode: bootstrapPlan.mode,
          needsBootstrap: bootstrapPlan.needsBootstrap, shouldStop: () => !running,
        });
        log("info", "Bootstrap mode resolved", {
          mode: bootstrapPlan.mode, mode_label: bootstrapModeLabel(bootstrapPlan.mode),
          applied: bootstrapPlan.needsBootstrap ? "yes" : "no", ingest_mode: runtime.ingestMode,
        });
      }
    }

    while (running) {
      // check config.json for setting changes + commands
      try { await refreshConfigFromFile(); } catch (error) {
        log("warn", "Failed to refresh config from config.json", errorDetails(error));
      }

      bumpStat("cycles");
      const cycleStart = Date.now();

      // process all sources in parallel
      const activeSources = (runtime.sources ?? []);
      await Promise.all(activeSources.map((source) =>
        processSource({ store, uc, source, shouldStop: () => !running, ingestMode: runtime.ingestMode ?? "all" }),
      ));

      if (stats.cycles % cfg.cleanupEveryCycles === 0) { try { store.cleanupExpired(); } catch { /* ignore */ } }

      // write status.json atomically after each cycle
      try { await writeStatusJson(cfg, stats, state, runtime); } catch { /* ignore */ }

      if (!running) break;
      const waitMs = Math.max(cfg.pollMs - (Date.now() - cycleStart), 10);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    runtime.daemonRunning = false;

    // final status write
    try { await writeStatusJson(cfg, stats, state, runtime); } catch { /* ignore */ }

    emitStatusLine();
    await stopRuntimeResources();
    log("info", "UltraContext daemon stopped");
  }

  // ── run ──

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
}
