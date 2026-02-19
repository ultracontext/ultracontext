import "dotenv/config";

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import fg from "fast-glob";
import { UltraContext } from "ultracontext";

import { createRedisClient, resolveRedisUrl } from "./redis.mjs";
import {
  hasLocalClaudeSession,
  hasLocalCodexSession,
  materializeClaudeSession,
  materializeCodexSession,
} from "./codex-local-resume.mjs";
import { redact } from "./redact.mjs";
import { parseClaudeCodeLine, parseCodexLine, parseOpenClawLine } from "./sources.mjs";
import { MENU_TABS, createInkUiController } from "./ui.mjs";
import { boolFromEnv, expandHome, sha256, toInt } from "./utils.mjs";

const argv = process.argv.slice(2);
const APP_MODE = argv.includes("--daemon") ? "daemon" : "tui";
const IS_DAEMON_MODE = APP_MODE === "daemon";
const IS_TUI_MODE = APP_MODE === "tui";

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STARTUP_SOUND_FILE = path.join(APP_ROOT, "assets", "sounds", "hello_mf.mp3");
const DEFAULT_CONTEXT_SOUND_FILE = path.join(APP_ROOT, "assets", "sounds", "quack.mp3");
const DEFAULT_RUNTIME_CONFIG_FILE = "~/.ultracontext/config.json";
const BOOTSTRAP_OPTIONS = [
  { id: "new_only", label: "New only (recommended)", description: "Starts from the current tail and ignores older history." },
  { id: "last_24h", label: "Last 24h", description: "Ingests only recent messages (24 hours)." },
  { id: "all", label: "All", description: "Full history backfill (can take a while)." },
];
const CONFIG_BOOTSTRAP_MODES = [
  { id: "prompt", label: "Ask on startup" },
  { id: "new_only", label: "New only" },
  { id: "last_24h", label: "Last 24h" },
  { id: "all", label: "All" },
];
const CONFIG_RESUME_TERMINALS = [
  { id: "terminal", label: "Terminal" },
  { id: "warp", label: "Warp" },
];
const RESUME_TARGET_OPTIONS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];
const PERSISTED_CONFIG_FIELDS = [
  "soundEnabled",
  "startupSoundEnabled",
  "contextSoundEnabled",
  "bootstrapMode",
  "resumeTerminal",
  "claudeIncludeSubagents",
];

function normalizeApiKey(raw) {
  if (!raw) return "";
  // Common pitfall: quoted key from shell/.env (e.g. "uc_live_xxx")
  return String(raw).trim().replace(/^['"]|['"]$/g, "");
}

function normalizeResumeSourceFilter(raw) {
  const value = String(raw ?? "all").trim().toLowerCase();
  if (value === "codex" || value === "claude" || value === "openclaw" || value === "all") return value;
  return "all";
}

function normalizeResumeTerminal(raw) {
  const value = String(raw ?? "terminal").trim().toLowerCase();
  if (value === "warp") return "warp";
  return "terminal";
}

function resolveRuntimeConfigPath() {
  return expandHome(process.env.ULTRACONTEXT_CONFIG_FILE ?? DEFAULT_RUNTIME_CONFIG_FILE);
}

const cfg = {
  apiKey: normalizeApiKey(process.env.ULTRACONTEXT_API_KEY),
  baseUrl: (process.env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai").trim(),
  redisUrl: resolveRedisUrl(process.env),
  engineerId: process.env.DAEMON_ENGINEER_ID ?? process.env.USER ?? "unknown-engineer",
  host: (process.env.DAEMON_HOST || os.hostname() || "unknown-host").trim(),
  pollMs: toInt(process.env.DAEMON_POLL_MS, 1500),
  logLevel: process.env.DAEMON_LOG_LEVEL ?? "info",
  logAppends: boolFromEnv(process.env.DAEMON_LOG_APPENDS, true),
  uiMode: (process.env.TUI_MODE ?? "auto").trim().toLowerCase(),
  uiRefreshMs: toInt(process.env.TUI_REFRESH_MS, 1200),
  uiRecentLimit: toInt(
    process.env.TUI_RECENT_LIMIT,
    Math.max((process.stdout.rows ?? 40) * 6, 180)
  ),
  soundEnabled: boolFromEnv(process.env.DAEMON_SOUND_ENABLED, true),
  startupSoundEnabled: boolFromEnv(process.env.DAEMON_STARTUP_SOUND_ENABLED, true),
  contextSoundEnabled: boolFromEnv(process.env.DAEMON_CONTEXT_SOUND_ENABLED, true),
  startupGreetingFile: expandHome(process.env.DAEMON_STARTUP_GREETING_FILE ?? DEFAULT_STARTUP_SOUND_FILE),
  contextCreatedSoundFile: expandHome(process.env.DAEMON_CONTEXT_SOUND_FILE ?? DEFAULT_CONTEXT_SOUND_FILE),
  configFile: resolveRuntimeConfigPath(),
  dedupeTtlSec: toInt(process.env.DAEMON_DEDUPE_TTL_SEC, 60 * 60 * 24 * 30),
  instanceLockTtlSec: toInt(process.env.DAEMON_INSTANCE_LOCK_TTL_SEC, 45),
  maxReadBytes: toInt(process.env.DAEMON_MAX_READ_BYTES, 512 * 1024),
  enableDailyContext: boolFromEnv(process.env.DAEMON_ENABLE_DAILY_CONTEXT, false),
  bootstrapMode: (process.env.DAEMON_BOOTSTRAP_MODE ?? "prompt").trim().toLowerCase(),
  bootstrapReset: boolFromEnv(process.env.DAEMON_BOOTSTRAP_RESET, false),
  claudeIncludeSubagents: boolFromEnv(process.env.CLAUDE_INCLUDE_SUBAGENTS, false),
  resumeTerminal: normalizeResumeTerminal(process.env.RESUME_TERMINAL),
  resumeContextLimit: toInt(process.env.RESUME_CONTEXT_LIMIT, 1000),
  resumeSourceFilter: normalizeResumeSourceFilter(process.env.RESUME_SOURCE_FILTER),
  resumeSummaryTail: toInt(process.env.RESUME_SUMMARY_TAIL, 14),
  resumeOutputDir: expandHome(process.env.RESUME_OUTPUT_DIR ?? "~/.codex/resume"),
  resumeOpenTab: boolFromEnv(process.env.RESUME_OPEN_TAB, true),
};

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

const prettyUi =
  IS_TUI_MODE && (cfg.uiMode === "pretty" || (cfg.uiMode === "auto" && Boolean(process.stdout.isTTY)));

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

const CONFIG_TOGGLES = [
  {
    key: "soundEnabled",
    label: "Master sounds",
    description: "Enable or disable all app sounds",
  },
  {
    key: "startupSoundEnabled",
    label: "Startup sounds",
    description: "Play sound when the app starts",
  },
  {
    key: "contextSoundEnabled",
    label: "Context sounds",
    description: "Play duck sound when a new context is created",
  },
];

const ui = {
  recentLogs: [],
  onlineClients: [],
  sourceStats: new Map(),
  sourceOrder: [],
  selectedTab: "logs",
  configEditor: {
    selectedIndex: 0,
  },
  resume: {
    loading: false,
    syncing: false,
    contexts: [],
    selectedIndex: 0,
    loadedAt: 0,
    error: "",
    notice: "",
    summaryPath: "",
    command: "",
  },
  resumeTargetPicker: {
    active: false,
    selectedIndex: 0,
    source: "",
    contextId: "",
    options: RESUME_TARGET_OPTIONS,
    recommendedTarget: "",
  },
  bootstrap: {
    active: false,
    selectedIndex: 0,
    options: BOOTSTRAP_OPTIONS,
    sourceNames: [],
    note: "",
  },
};

let statusTimer = null;
let uiController = null;
let remotePollTimer = null;
let daemonStateTimer = null;
const runtime = {
  uc: null,
  stop: null,
  redis: null,
  sources: null,
  ingestMode: "all",
  lock: null,
  lockTimer: null,
  lockRefreshFailures: 0,
  bootstrapResolve: null,
  daemonRunning: false,
};
const sound = { startupFile: "", contextFile: "", warnedNonDarwin: false };
let stdioErrorHandled = false;

function isBenignStdioError(error) {
  const code = String(error?.code ?? "");
  return code === "EIO" || code === "EPIPE" || code === "ENXIO";
}

function handleStdioError(error, streamName) {
  if (!isBenignStdioError(error)) return;
  if (stdioErrorHandled) return;
  stdioErrorHandled = true;

  // TTY detach on Ctrl+C/watch shutdown can emit EIO on stdin; treat as graceful shutdown.
  try {
    runtime.stop?.("stdio");
  } catch {
    // ignore
  }

  if (prettyUi) {
    try {
      uiController?.stop();
      uiController = null;
    } catch {
      // ignore
    }
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

function runtimeStateRedisKey() {
  return `uc:daemon:runtime:v1:${cfg.host}:${cfg.engineerId}`;
}

function runtimeLogsRedisKey() {
  return `uc:daemon:logs:v1:${cfg.host}:${cfg.engineerId}`;
}

function runtimeLogsKeep() {
  return Math.max(cfg.uiRecentLimit, 180);
}

function parseRedisJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseRuntimeStateRedisKey(key) {
  const prefix = "uc:daemon:runtime:v1:";
  if (!String(key).startsWith(prefix)) return null;
  const tail = String(key).slice(prefix.length);
  const splitAt = tail.lastIndexOf(":");
  if (splitAt <= 0 || splitAt >= tail.length - 1) return null;
  return {
    host: tail.slice(0, splitAt),
    engineerId: tail.slice(splitAt + 1),
  };
}

async function scanKeys(redis, { match, count = 100 }) {
  const keys = [];
  let cursor = "0";
  do {
    const result = await redis.scan(cursor, "MATCH", match, "COUNT", count);
    cursor = String(result?.[0] ?? "0");
    const batch = Array.isArray(result?.[1]) ? result[1] : [];
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

async function refreshOnlineClients(redis) {
  const keys = await scanKeys(redis, { match: "uc:daemon:runtime:v1:*", count: 200 });
  if (keys.length === 0) {
    ui.onlineClients = [];
    return;
  }
  const values = await redis.mget(...keys);
  const clients = [];
  const seen = new Set();

  for (let i = 0; i < keys.length; i += 1) {
    const parsedKey = parseRuntimeStateRedisKey(keys[i]);
    if (!parsedKey) continue;
    const id = `${parsedKey.engineerId}@${parsedKey.host}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const snapshot = parseRedisJson(values[i], null);
    if (!snapshot || snapshot.running !== true) continue;
    clients.push({
      host: parsedKey.host,
      engineerId: parsedKey.engineerId,
      ts: Number(snapshot.ts ?? 0),
    });
  }

  clients.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
  ui.onlineClients = clients;
}

function color(text, ansiCode) {
  if (!prettyUi) return text;
  return `${ansiCode}${text}${ANSI.reset}`;
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
  if (!ui.sourceStats.has(sourceName)) {
    ui.sourceStats.set(sourceName, {
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
  return ui.sourceStats.get(sourceName);
}

function bumpSourceStat(sourceName, key, delta = 1) {
  const state = ensureSourceStats(sourceName);
  state[key] = (state[key] ?? 0) + delta;
}

function noteSourceActivity(sourceName, patch) {
  const state = ensureSourceStats(sourceName);
  Object.assign(state, patch ?? {});
}

function logSourceFromData(data) {
  if (!data || typeof data !== "object") return "";
  const direct = [
    data.source,
    data.context_source,
    data.contextSource,
    data?.metadata?.source,
  ];
  for (const value of direct) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    return raw.toLowerCase();
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
  const source = logSourceFromData(data);
  ui.recentLogs.push({
    ts: formatTime(),
    level,
    source,
    text: line,
  });
  const keep = Math.max(cfg.uiRecentLimit, 1);
  while (ui.recentLogs.length > keep) ui.recentLogs.shift();
  const last = ui.recentLogs[ui.recentLogs.length - 1];
  if (IS_DAEMON_MODE && runtime.redis && last) {
    const key = runtimeLogsRedisKey();
    void runtime.redis
      .multi()
      .lpush(key, JSON.stringify(last))
      .ltrim(key, 0, runtimeLogsKeep() - 1)
      .expire(key, Math.max(cfg.instanceLockTtlSec * 8, 120))
      .exec()
      .catch(() => {});
  }
  renderDashboard();
}

function log(level, message, data) {
  const current = LOG_LEVELS[cfg.logLevel] ?? LOG_LEVELS.info;
  const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (target > current) return;

  if (prettyUi) {
    pushRecentLog(level, message, data);
    return;
  }

  if (IS_DAEMON_MODE) {
    pushRecentLog(level, message, data);
  }

  const now = formatTime();
  const tagColor =
    level === "error"
      ? ANSI.red
      : level === "warn"
      ? ANSI.yellow
      : level === "info"
      ? ANSI.green
      : ANSI.cyan;

  const tag = color(level.toUpperCase().padEnd(5), tagColor);
  const ts = color(now, ANSI.gray);
  const suffix = formatDataInline(data);
  const line = suffix ? `${message} ${color(suffix, ANSI.dim)}` : message;
  console.log(`${ts} ${tag} ${line}`);
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

function resumeCompact(value, max = 60) {
  const raw = String(value ?? "");
  if (raw.length <= max) return raw;
  if (max <= 3) return raw.slice(0, max);
  return `${raw.slice(0, max - 3)}...`;
}

function resumeNormalizeRole(message) {
  const role = String(message?.role ?? "system").toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "agent") return "assistant";
  return "system";
}

function resumeMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return resumeCompact(content.replace(/\s+/g, " ").trim(), 220);
  if (content && typeof content === "object") {
    if (typeof content.message === "string") return resumeCompact(content.message.replace(/\s+/g, " ").trim(), 220);
    if (typeof content.text === "string") return resumeCompact(content.text.replace(/\s+/g, " ").trim(), 220);
    return resumeCompact(JSON.stringify(content), 220);
  }
  return "";
}

function resumeMessageTimestamp(message) {
  return message?.content?.timestamp ?? message?.metadata?.timestamp ?? "";
}

function resumeMessageEventType(message) {
  return message?.content?.event_type ?? message?.metadata?.event_type ?? "message";
}

function resumeExtractSessionCwd(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cwd = messages[i]?.content?.raw?.payload?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return "";
}

async function resumeResolveWorkingDirectory(preferredCwd) {
  if (!preferredCwd) return process.cwd();
  try {
    const stat = await fs.stat(preferredCwd);
    if (stat.isDirectory()) return preferredCwd;
  } catch {
    // Fall back to current directory when original path is not available locally.
  }
  return process.cwd();
}

function resumeShellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function resumeAppleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function runAppleScriptLines(scriptLines) {
  const args = [];
  for (const line of scriptLines) args.push("-e", line);
  const out = spawnSync("osascript", args, { stdio: "pipe", encoding: "utf8" });
  if (out.status !== 0) {
    return {
      ok: false,
      reason: out.stderr?.trim() || out.stdout?.trim() || "osascript failed",
    };
  }
  return { ok: true };
}

function warpLaunchConfigDirs() {
  const home = os.homedir();
  return [
    path.join(home, ".warp", "launch_configurations"),
    path.join(home, "Library", "Application Support", "dev.warp.Warp-Stable", "launch_configurations"),
    path.join(home, "Library", "Application Support", "dev.warp.Warp-Preview", "launch_configurations"),
  ];
}

function warpLaunchConfigYaml({ name, cwd, command }) {
  const safeCommand = String(command ?? "").replace(/\r?\n/g, " && ");
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    "windows:",
    "  - tabs:",
    "      - title: UltraContext Resume",
    "        layout:",
    `          cwd: ${JSON.stringify(cwd)}`,
    "          commands:",
    `            - exec: ${JSON.stringify(safeCommand)}`,
    "",
  ].join("\n");
}

function runOpenUri(uri) {
  const out = spawnSync("open", [uri], { stdio: "pipe", encoding: "utf8" });
  if (out.status !== 0) {
    return {
      ok: false,
      reason: out.stderr?.trim() || out.stdout?.trim() || "open uri failed",
    };
  }
  return { ok: true };
}

function resumeWarpPasteAndRun(command, { openNewTab = false } = {}) {
  const scriptLines = [
    "set _uc_prev_clipboard to the clipboard",
    `set the clipboard to ${resumeAppleScriptString(command)}`,
    "tell application \"Warp\" to activate",
    "delay 0.85",
    "tell application \"System Events\"",
  ];
  if (openNewTab) {
    scriptLines.push("keystroke \"t\" using {command down}", "delay 0.45");
  }
  scriptLines.push(
    "keystroke \"v\" using {command down}",
    "delay 0.25",
    "key code 36",
    "delay 0.18",
    "key code 36",
    "end tell",
    "delay 0.05",
    "set the clipboard to _uc_prev_clipboard"
  );
  return runAppleScriptLines(scriptLines);
}

function resumeOpenWarpNewWindowAndRun(command) {
  spawnSync("open", ["-a", "Warp"], { stdio: "ignore" });
  runAppleScriptLines([
    "tell application \"Warp\" to activate",
    "delay 0.12",
  ]);

  const uri = `warp://action/new_window?path=${encodeURIComponent(process.cwd())}`;
  const opened = runOpenUri(uri);
  if (!opened.ok) return opened;

  runAppleScriptLines([
    "tell application \"Warp\" to activate",
    "delay 0.3",
  ]);
  return resumeWarpPasteAndRun(command, { openNewTab: false });
}

function resumeOpenWarpViaUri(command) {
  try {
    const timestamp = Date.now();
    const launchName = `ultracontext_resume_${timestamp}_${process.pid}`;
    const yaml = warpLaunchConfigYaml({
      name: `UltraContext Resume ${timestamp}`,
      cwd: process.cwd(),
      command,
    });
    // Sync write keeps the open flow deterministic for the URI launch call.
    let primaryFilePath = "";
    for (const dir of warpLaunchConfigDirs()) {
      try {
        fsSync.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${launchName}.yaml`);
        fsSync.writeFileSync(filePath, yaml, "utf8");
        if (!primaryFilePath) primaryFilePath = filePath;
      } catch {
        // Best effort: different Warp builds can use different config directories.
      }
    }

    if (!primaryFilePath) {
      return { ok: false, reason: "could not write Warp launch configuration file" };
    }
    const uri = `warp://launch/${encodeURIComponent(primaryFilePath)}`;
    // Force Warp foreground; URI launch can run in background depending OS/window focus.
    spawnSync("open", ["-a", "Warp"], { stdio: "ignore" });
    runAppleScriptLines([
      "tell application \"Warp\" to activate",
      "delay 0.12",
    ]);

    const opened = runOpenUri(uri);
    if (!opened.ok) return opened;

    runAppleScriptLines([
      "tell application \"Warp\" to activate",
      "delay 0.12",
    ]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function resumeOpenAppleTerminalTab(command) {
  const scriptLines = [
    "tell application \"Terminal\"",
    "activate",
    "if (count of windows) = 0 then",
    `  do script ${resumeAppleScriptString(command)}`,
    "else",
    `  do script ${resumeAppleScriptString(command)} in front window`,
    "end if",
    "end tell",
  ];
  const out = runAppleScriptLines(scriptLines);
  return out.ok ? { ...out, method: "terminal_applescript" } : { ...out, method: "terminal_applescript" };
}

function resumeOpenWarpTab(command) {
  const uriLaunch = resumeOpenWarpViaUri(command);
  if (uriLaunch.ok) return { ...uriLaunch, method: "warp_uri_launch" };

  const newWindowFlow = resumeOpenWarpNewWindowAndRun(command);
  if (newWindowFlow.ok) return { ...newWindowFlow, method: "warp_new_window_paste" };

  const firstTry = resumeWarpPasteAndRun(command, { openNewTab: true });
  if (firstTry.ok) return { ...firstTry, method: "warp_new_tab_paste" };

  const fallback = resumeWarpPasteAndRun(command, { openNewTab: false });
  if (fallback.ok) return { ...fallback, method: "warp_current_tab_paste" };

  return {
    ok: false,
    method: "warp_failed",
    reason: `${newWindowFlow.reason}; ${uriLaunch.reason}; ${firstTry.reason}; fallback failed: ${fallback.reason}. Check macOS Accessibility permission for your terminal and osascript/System Events.`,
  };
}

function resumeOpenTerminalTab(command) {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "open-tab is available only on macOS" };
  }
  if (cfg.resumeTerminal === "warp") return resumeOpenWarpTab(command);
  return resumeOpenAppleTerminalTab(command);
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

function resumeDedupeById(contexts) {
  const out = [];
  const seen = new Set();
  for (const item of contexts ?? []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function resumeFilterContexts(contexts) {
  return contexts.filter((ctx) => {
    const md = ctx?.metadata ?? {};
    const source = String(md.source ?? "").toLowerCase();
    const kind = String(md.context_kind ?? "");
    if (cfg.resumeSourceFilter !== "all" && source && source !== cfg.resumeSourceFilter) return false;
    if (kind && kind !== "session") return false;
    return true;
  });
}

function resumeSortContexts(contexts) {
  const ts = (ctx) => {
    const candidates = [
      ctx?.created_at,
      ctx?.updated_at,
      ctx?.metadata?.timestamp,
      ctx?.metadata?.created_at,
    ];
    for (const candidate of candidates) {
      const value = new Date(candidate ?? 0).getTime();
      if (!Number.isNaN(value) && value > 0) return value;
    }
    return 0;
  };

  return contexts.slice().sort((a, b) => {
    const diff = ts(b) - ts(a);
    if (diff !== 0) return diff;
    const aId = String(a?.id ?? "");
    const bId = String(b?.id ?? "");
    return bId.localeCompare(aId);
  });
}

function resumeFormatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function resumeContextSource(context) {
  const raw = String(context?.metadata?.source ?? "").trim().toLowerCase();
  if (raw === "codex") return "codex";
  if (raw === "claude") return "claude";
  return "unknown";
}

function isCodingContextSource(source) {
  return source === "codex" || source === "claude";
}

function resumeTargetAgent(source) {
  if (source === "codex") return "claude";
  if (source === "claude") return "codex";
  return "codex";
}

function resumeTargetOptionsForSource(source) {
  if (!isCodingContextSource(source)) return RESUME_TARGET_OPTIONS.slice();
  const recommended = resumeTargetAgent(source);
  const ordered = RESUME_TARGET_OPTIONS.slice().sort((a, b) => {
    if (a.id === recommended && b.id !== recommended) return -1;
    if (b.id === recommended && a.id !== recommended) return 1;
    return 0;
  });
  return ordered;
}

function resumeAgentLabel(agent) {
  if (agent === "claude") return "Claude Code";
  if (agent === "codex") return "Codex";
  return "Unknown";
}

function resumeSummaryMarkdown({ context, messages }) {
  const counts = { user: 0, assistant: 0, system: 0 };
  for (const msg of messages) counts[resumeNormalizeRole(msg)] += 1;
  const recent = messages.slice(-Math.max(cfg.resumeSummaryTail, 4));
  const lines = [
    "# UltraContext Resume",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Context ID: ${context.id}`,
    `Created at: ${resumeFormatDate(context.created_at)}`,
    `Source: ${context.metadata?.source ?? "-"}`,
    `Engineer: ${context.metadata?.engineer_id ?? "-"}`,
    `Session ID: ${context.metadata?.session_id ?? "-"}`,
    "",
    "## Snapshot",
    `- Messages: ${messages.length}`,
    `- Roles: user=${counts.user}, assistant=${counts.assistant}, system=${counts.system}`,
    "",
    `## Recent Timeline (last ${recent.length})`,
  ];

  for (const msg of recent) {
    const ts = resumeCompact(resumeMessageTimestamp(msg) || "-", 19).padEnd(19);
    const role = resumeNormalizeRole(msg).toUpperCase().padEnd(9);
    const eventType = resumeCompact(resumeMessageEventType(msg), 24).padEnd(24);
    const text = resumeMessageText(msg) || "-";
    lines.push(`- ${ts} ${role} ${eventType} ${text}`);
  }

  lines.push("", "## Resume Instructions", "1. Use the generated adapter command from the Contexts tab.", "2. Continue from the latest unresolved request.", "");
  return lines.join("\n");
}

async function loadResumeContexts() {
  if (!runtime.uc || ui.resume.loading) return;
  ui.resume.loading = true;
  ui.resume.error = "";
  ui.resume.notice = "Loading contexts from UltraContext...";
  if (prettyUi) renderDashboard();

  try {
    const listed = await runtime.uc.get({ limit: Math.max(cfg.resumeContextLimit, 1) });
    const filtered = resumeSortContexts(resumeFilterContexts(resumeDedupeById(listed.data)));
    ui.resume.contexts = filtered;
    if (ui.resume.selectedIndex >= filtered.length) {
      ui.resume.selectedIndex = Math.max(filtered.length - 1, 0);
    }
    ui.resume.loadedAt = Date.now();
    const sourceCounts = { codex: 0, claude: 0, openclaw: 0, other: 0 };
    for (const ctx of filtered) {
      const source = String(ctx?.metadata?.source ?? "").toLowerCase();
      if (source === "codex") sourceCounts.codex += 1;
      else if (source === "claude") sourceCounts.claude += 1;
      else if (source === "openclaw") sourceCounts.openclaw += 1;
      else sourceCounts.other += 1;
    }
    const filterLabel = cfg.resumeSourceFilter === "all" ? "all sources" : cfg.resumeSourceFilter;
    ui.resume.notice = `Loaded ${filtered.length} session contexts (${filterLabel}: codex=${sourceCounts.codex}, claude=${sourceCounts.claude}, openclaw=${sourceCounts.openclaw}, other=${sourceCounts.other})`;
    if (filtered.length === 0) {
      ui.resume.notice = `No contexts found for filter=${cfg.resumeSourceFilter}`;
    }
    log("info", "Resume contexts loaded", {
      contexts: filtered.length,
      source_filter: cfg.resumeSourceFilter,
      codex: sourceCounts.codex,
      claude: sourceCounts.claude,
      openclaw: sourceCounts.openclaw,
      other: sourceCounts.other,
      requested_limit: cfg.resumeContextLimit,
    });
  } catch (error) {
    const details = errorDetails(error);
    ui.resume.error = details.message ?? "Failed loading contexts";
    ui.resume.notice = "";
    log("warn", "Failed to load resume contexts", details);
  } finally {
    ui.resume.loading = false;
    if (prettyUi) renderDashboard();
  }
}

function moveResumeSelection(delta) {
  const total = ui.resume.contexts.length;
  if (!total) return;
  const next = ui.resume.selectedIndex + delta;
  if (next < 0) {
    ui.resume.selectedIndex = total - 1;
    return;
  }
  if (next >= total) {
    ui.resume.selectedIndex = 0;
    return;
  }
  ui.resume.selectedIndex = next;
}

function recommendedResumeTargetForContext(context) {
  const sourceAgent = resumeContextSource(context);
  if (!isCodingContextSource(sourceAgent)) return "";
  return resumeTargetAgent(sourceAgent);
}

function resumeTargetPickerIndexById(targetId) {
  const idx = RESUME_TARGET_OPTIONS.findIndex((option) => option.id === targetId);
  return idx === -1 ? 0 : idx;
}

function openResumeTargetPicker() {
  if (ui.resume.syncing) return false;
  const context = ui.resume.contexts[ui.resume.selectedIndex];
  if (!context) {
    ui.resume.notice = "No context selected";
    renderDashboard();
    return false;
  }

  const sourceAgent = resumeContextSource(context);
  if (!isCodingContextSource(sourceAgent)) {
    ui.resume.notice = `Selected context source=${sourceAgent}. Adapt/Resume is available only for codex/claude contexts.`;
    renderDashboard();
    return false;
  }

  const recommendedTarget = recommendedResumeTargetForContext(context);
  ui.resumeTargetPicker.active = true;
  ui.resumeTargetPicker.selectedIndex = 0;
  ui.resumeTargetPicker.source = sourceAgent;
  ui.resumeTargetPicker.contextId = String(context.id ?? "");
  ui.resumeTargetPicker.options = resumeTargetOptionsForSource(sourceAgent);
  ui.resumeTargetPicker.recommendedTarget = recommendedTarget;
  renderDashboard();
  return true;
}

function closeResumeTargetPicker() {
  ui.resumeTargetPicker.active = false;
  ui.resumeTargetPicker.source = "";
  ui.resumeTargetPicker.contextId = "";
  ui.resumeTargetPicker.selectedIndex = 0;
  ui.resumeTargetPicker.options = RESUME_TARGET_OPTIONS;
  ui.resumeTargetPicker.recommendedTarget = "";
  renderDashboard();
}

function moveResumeTargetPickerSelection(delta) {
  const options = ui.resumeTargetPicker.options ?? RESUME_TARGET_OPTIONS;
  const total = options.length;
  if (total <= 0) return;
  const base = Number.isInteger(ui.resumeTargetPicker.selectedIndex) ? ui.resumeTargetPicker.selectedIndex : 0;
  ui.resumeTargetPicker.selectedIndex = (base + delta + total) % total;
  renderDashboard();
}

function resumeTargetPickerSelectionByIndex(index) {
  const options = ui.resumeTargetPicker.options ?? RESUME_TARGET_OPTIONS;
  const safeIndex = Math.max(Math.min(index, options.length - 1), 0);
  return options[safeIndex]?.id ?? "codex";
}

async function buildCodexResumePlan({ sessionId, runCwd, messages }) {
  const originalSessionId = String(sessionId ?? "").trim();
  let canResumeBySessionId = originalSessionId ? await hasLocalCodexSession(originalSessionId) : false;
  let restoredPath = "";
  let restoredError = "";

  if (!canResumeBySessionId && originalSessionId) {
    const restored = await materializeCodexSession({
      sessionId: originalSessionId,
      cwd: runCwd,
      messages,
    });
    canResumeBySessionId = await hasLocalCodexSession(originalSessionId);
    restoredPath = restored.filePath || "";
    restoredError = restored.error || "";
  }

  const command = canResumeBySessionId
    ? `codex -C ${resumeShellQuote(runCwd)} resume ${resumeShellQuote(originalSessionId)}`
    : `codex -C ${resumeShellQuote(runCwd)}`;

  return {
    targetAgent: "codex",
    sessionId: originalSessionId,
    command,
    canResumeBySessionId,
    restoredPath,
    restoredError,
  };
}

async function buildClaudeResumePlan({ sessionId, runCwd, messages }) {
  const originalSessionId = String(sessionId ?? "").trim();
  let candidateSessionId = originalSessionId;
  let canResumeBySessionId = candidateSessionId
    ? await hasLocalClaudeSession(candidateSessionId, runCwd)
    : false;
  let restoredPath = "";
  let restoredError = "";

  if (!canResumeBySessionId || !candidateSessionId) {
    const restored = await materializeClaudeSession({
      sessionId: candidateSessionId,
      cwd: runCwd,
      messages,
    });
    candidateSessionId = restored.sessionId || candidateSessionId;
    canResumeBySessionId = candidateSessionId
      ? await hasLocalClaudeSession(candidateSessionId, runCwd)
      : false;
    restoredPath = restored.filePath || "";
    restoredError = restored.error || "";
  }

  const command = canResumeBySessionId
    ? `cd ${resumeShellQuote(runCwd)} && claude --resume ${resumeShellQuote(candidateSessionId)}`
    : `cd ${resumeShellQuote(runCwd)} && claude`;

  return {
    targetAgent: "claude",
    sessionId: candidateSessionId,
    command,
    canResumeBySessionId,
    restoredPath,
    restoredError,
  };
}

async function resumeSelectedContext({ targetAgentOverride = "" } = {}) {
  if (!runtime.uc || ui.resume.syncing) return;
  const context = ui.resume.contexts[ui.resume.selectedIndex];
  if (!context) {
    ui.resume.notice = "No context selected";
    if (prettyUi) renderDashboard();
    return;
  }
  const selectedSourceAgent = resumeContextSource(context);
  if (!isCodingContextSource(selectedSourceAgent)) {
    ui.resume.notice = `Selected context source=${selectedSourceAgent}. Adapt/Resume is available only for codex/claude contexts.`;
    if (prettyUi) renderDashboard();
    return;
  }

  ui.resume.syncing = true;
  ui.resumeTargetPicker.active = false;
  ui.resume.error = "";
  ui.resume.notice = `Pulling ${context.id}...`;
  if (prettyUi) renderDashboard();

  try {
    const detail = await runtime.uc.get(context.id);
    const messages = Array.isArray(detail.data) ? detail.data : [];
    const outDir = path.resolve(cfg.resumeOutputDir);
    await fs.mkdir(outDir, { recursive: true });
    const summaryPath = path.join(outDir, `${context.id}.md`);
    const snapshotPath = path.join(outDir, `${context.id}.json`);
    const summary = resumeSummaryMarkdown({ context, messages });
    const snapshot = {
      exported_at: new Date().toISOString(),
      context_id: context.id,
      metadata: context.metadata ?? {},
      messages,
    };
    await fs.writeFile(summaryPath, summary, "utf8");
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    const originalCwd = resumeExtractSessionCwd(messages);
    const runCwd = await resumeResolveWorkingDirectory(originalCwd);
    const sourceAgent = selectedSourceAgent;
    const manualTarget =
      targetAgentOverride === "claude" || targetAgentOverride === "codex" ? targetAgentOverride : "";
    let targetAgent = manualTarget || resumeTargetAgent(sourceAgent);
    if (targetAgent === sourceAgent) {
      targetAgent = resumeTargetAgent(sourceAgent);
      log("warn", "Adjusted resume target to opposite agent", {
        source_agent: sourceAgent,
        requested_target: manualTarget || sourceAgent,
        adjusted_target: targetAgent,
      });
    }
    const sessionId = String(context.metadata?.session_id ?? "");
    const resumePlan =
      targetAgent === "claude"
        ? await buildClaudeResumePlan({ sessionId, runCwd, messages })
        : await buildCodexResumePlan({ sessionId, runCwd, messages });
    const direction = `${resumeAgentLabel(sourceAgent)} -> ${resumeAgentLabel(targetAgent)}`;
    const command = resumePlan.command;
    ui.resume.summaryPath = summaryPath;
    ui.resume.command = command;

    if (cfg.resumeOpenTab) {
      const opened = resumeOpenTerminalTab(command);
      const openMethod = opened.method ? ` method=${opened.method}` : "";
      if (opened.ok) {
        ui.resume.notice = resumePlan.canResumeBySessionId
          ? `Adapter ready (${direction}). Opened ${resumeAgentLabel(targetAgent)} via session_id ${resumePlan.sessionId}.${openMethod}`
          : `Adapter ready (${direction}). Opened ${resumeAgentLabel(targetAgent)} without session resume.${openMethod}`;
        if (resumePlan.restoredError) {
          ui.resume.notice = `${ui.resume.notice} Adapter warning: ${resumePlan.restoredError}`;
        }
      } else {
        ui.resume.notice = `Adapter ready (${direction}). Open tab failed: ${opened.reason}${openMethod}`;
      }
    } else {
      ui.resume.notice = resumePlan.canResumeBySessionId
        ? `Adapter ready (${direction}). Use generated ${resumeAgentLabel(targetAgent)} resume command.`
        : `Adapter ready (${direction}). Use generated command to start a clean ${resumeAgentLabel(targetAgent)} session.`;
      if (resumePlan.restoredPath) {
        ui.resume.notice = `${ui.resume.notice} Local adapter: ${resumePlan.restoredPath}`;
      } else if (resumePlan.restoredError) {
        ui.resume.notice = `${ui.resume.notice} Adapter warning: ${resumePlan.restoredError}`;
      }
    }

    log("info", "Resume snapshot generated", {
      context_id: context.id,
      source_agent: sourceAgent,
      target_agent: targetAgent,
      target_session_id: resumePlan.sessionId,
      resumed_by_session_id: resumePlan.canResumeBySessionId ? "yes" : "no",
      summary_path: summaryPath,
      messages: messages.length,
    });
  } catch (error) {
    const details = errorDetails(error);
    ui.resume.error = details.message ?? "Resume failed";
    ui.resume.notice = "";
    log("warn", "Failed to resume context", { context_id: context.id, ...details });
  } finally {
    ui.resume.syncing = false;
    ui.resumeTargetPicker.active = false;
    ui.resumeTargetPicker.source = "";
    ui.resumeTargetPicker.contextId = "";
    ui.resumeTargetPicker.selectedIndex = 0;
    ui.resumeTargetPicker.options = RESUME_TARGET_OPTIONS;
    ui.resumeTargetPicker.recommendedTarget = "";
    if (prettyUi) renderDashboard();
  }
}

function selectedTabIndex() {
  const idx = MENU_TABS.findIndex((tab) => tab.id === ui.selectedTab);
  return idx === -1 ? 0 : idx;
}

function bootstrapModeConfigLabel(mode) {
  return CONFIG_BOOTSTRAP_MODES.find((entry) => entry.id === mode)?.label ?? mode;
}

function resumeTerminalConfigLabel(mode) {
  const normalized = normalizeResumeTerminal(mode);
  return CONFIG_RESUME_TERMINALS.find((entry) => entry.id === normalized)?.label ?? "Terminal";
}

function configPrefsRedisKey() {
  return `uc:daemon:config:v1:${cfg.host}:${cfg.engineerId}`;
}

function serializeConfigPrefs() {
  return {
    soundEnabled: Boolean(cfg.soundEnabled),
    startupSoundEnabled: Boolean(cfg.startupSoundEnabled),
    contextSoundEnabled: Boolean(cfg.contextSoundEnabled),
    bootstrapMode: normalizeBootstrapMode(cfg.bootstrapMode) || "prompt",
    resumeTerminal: normalizeResumeTerminal(cfg.resumeTerminal),
    claudeIncludeSubagents: Boolean(cfg.claudeIncludeSubagents),
  };
}

async function persistConfigPrefsToFile(targetFile = cfg.configFile) {
  const target = path.resolve(targetFile);
  const payload = JSON.stringify(serializeConfigPrefs(), null, 2);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${payload}\n`, "utf8");
  return { saved: true, file: target };
}

async function loadConfigPrefsFromPath(target) {
  let raw = "";
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { loaded: false, missing: true };
    log("warn", "Failed to read config prefs file", {
      file: target,
      ...errorDetails(error),
    });
    return { loaded: false, missing: false };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log("warn", "Failed to parse config prefs file", {
      file: target,
      ...errorDetails(error),
    });
    return { loaded: false, missing: false };
  }

  applyConfigPrefs(parsed);
  return { loaded: true, missing: false };
}

async function loadConfigPrefsFromFile() {
  const primary = path.resolve(cfg.configFile);
  const loaded = await loadConfigPrefsFromPath(primary);
  return {
    loaded: loaded.loaded,
    source: loaded.loaded ? "primary" : "none",
    file: loaded.loaded ? primary : "",
  };
}

function applyConfigPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  for (const field of PERSISTED_CONFIG_FIELDS) {
    if (!(field in prefs)) continue;
    if (field === "bootstrapMode") {
      cfg.bootstrapMode = normalizeBootstrapMode(prefs.bootstrapMode) || "prompt";
      continue;
    }
    if (field === "resumeTerminal") {
      cfg.resumeTerminal = normalizeResumeTerminal(prefs.resumeTerminal);
      continue;
    }
    cfg[field] = Boolean(prefs[field]);
  }
}

async function persistConfigPrefs() {
  let fileSaved = false;
  let redisSaved = false;

  try {
    fileSaved = await persistConfigPrefsToFile();
  } catch (error) {
    log("warn", "Failed to persist config prefs file", {
      file: cfg.configFile,
      ...errorDetails(error),
    });
  }

  if (runtime.redis) {
    try {
      const key = configPrefsRedisKey();
      await runtime.redis.set(key, JSON.stringify(serializeConfigPrefs()));
      redisSaved = true;
    } catch (error) {
      log("warn", "Failed to persist config prefs to redis", errorDetails(error));
    }
  }

  return { fileSaved, redisSaved };
}

async function loadConfigPrefs(redis) {
  const key = configPrefsRedisKey();
  const raw = await redis.get(key);
  if (!raw) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log("warn", "Failed to parse persisted config prefs", {
      key,
      ...errorDetails(error),
    });
    return false;
  }
  applyConfigPrefs(parsed);
  return true;
}

async function refreshDaemonConfigFromRedis(redis) {
  const before = serializeConfigPrefs();
  const loaded = await loadConfigPrefs(redis);
  if (!loaded) return false;
  const after = serializeConfigPrefs();
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (!changed) return false;

  await prepareSoundConfig();
  if (before.claudeIncludeSubagents !== after.claudeIncludeSubagents) {
    applyRuntimeSources(buildSources());
  }
  log("info", "Reloaded config prefs from redis", {
    claude_subagents: after.claudeIncludeSubagents ? "on" : "off",
    sound_enabled: after.soundEnabled ? "on" : "off",
    startup_sound: after.startupSoundEnabled ? "on" : "off",
    context_sound: after.contextSoundEnabled ? "on" : "off",
    bootstrap_mode: after.bootstrapMode,
  });
  return true;
}

function applyRuntimeSources(sources) {
  runtime.sources = sources;
  ui.sourceOrder = sources.map((source) => source.name);
  for (const sourceName of ui.sourceOrder) ensureSourceStats(sourceName);
}

async function applyBootstrapModeNow(mode, { shouldPrompt = false } = {}) {
  const sources = runtime.sources ?? [];
  if (!runtime.redis || sources.length === 0) {
    return { applied: false, mode: normalizeBootstrapMode(mode) || "new_only", ingestMode: runtime.ingestMode };
  }

  let selectedMode = normalizeBootstrapMode(mode);
  if (shouldPrompt || !selectedMode) {
    selectedMode = prettyUi ? await requestBootstrapChoice(sources) : "new_only";
  }

  const ingestMode = await applyBootstrapMode({
    redis: runtime.redis,
    sources,
    mode: selectedMode,
    needsBootstrap: true,
    shouldStop: () => false,
  });
  runtime.ingestMode = ingestMode;
  return { applied: true, mode: selectedMode, ingestMode };
}

async function persistBootstrapPreference(mode) {
  if (!runtime.redis || !runtime.sources || runtime.sources.length === 0) return false;
  const key = bootstrapRedisKey(runtime.sources);
  if (mode === "prompt") {
    await runtime.redis.del(key);
    return true;
  }
  await runtime.redis.set(key, mode);
  return true;
}

async function resetBootstrapPreference() {
  if (!runtime.redis || !runtime.sources || runtime.sources.length === 0) return false;
  const key = bootstrapRedisKey(runtime.sources);
  await runtime.redis.del(key);
  return true;
}

function configToggleItems() {
  const masterEnabled = Boolean(cfg.soundEnabled);
  const soundItems = CONFIG_TOGGLES.map((item) => {
    const rawValue = Boolean(cfg[item.key]);
    const blockedByMaster = item.key !== "soundEnabled" && !masterEnabled;
    const effectiveValue = blockedByMaster ? false : rawValue;
    return {
      ...item,
      kind: "boolean",
      rawValue,
      value: effectiveValue,
      valueLabel: effectiveValue ? "ON" : "OFF",
      blockedByMaster,
    };
  });

  const normalizedBootstrapMode = normalizeBootstrapMode(cfg.bootstrapMode) || "prompt";
  const syncItems = [
    {
      key: "bootstrapMode",
      kind: "enum",
      label: "Sync profile",
      description: "Defines sync behavior and applies immediately.",
      value: normalizedBootstrapMode,
      valueLabel: bootstrapModeConfigLabel(normalizedBootstrapMode),
      blockedByMaster: false,
    },
    {
      key: "resumeTerminal",
      kind: "enum",
      label: "Resume terminal",
      description: "Choose where resume opens (Terminal or Warp).",
      value: normalizeResumeTerminal(cfg.resumeTerminal),
      valueLabel: resumeTerminalConfigLabel(cfg.resumeTerminal),
      blockedByMaster: false,
    },
    {
      key: "claudeIncludeSubagents",
      kind: "boolean",
      label: "Claude subagents",
      description: "Includes Claude subagents in scan (applies immediately).",
      value: Boolean(cfg.claudeIncludeSubagents),
      valueLabel: cfg.claudeIncludeSubagents ? "ON" : "OFF",
      blockedByMaster: false,
    },
    {
      key: "bootstrapResetState",
      kind: "action",
      label: "Reset bootstrap state",
      description: "Clears Redis bootstrap state and asks bootstrap mode now.",
      value: "run",
      valueLabel: "RUN",
      blockedByMaster: false,
    },
  ];

  return [...soundItems, ...syncItems];
}

function moveConfigSelection(delta) {
  const items = configToggleItems();
  const total = items.length;
  if (!total) return;
  const next = ui.configEditor.selectedIndex + delta;
  if (next < 0) {
    ui.configEditor.selectedIndex = total - 1;
    return;
  }
  if (next >= total) {
    ui.configEditor.selectedIndex = 0;
    return;
  }
  ui.configEditor.selectedIndex = next;
}

async function toggleSelectedConfig() {
  const items = configToggleItems();
  if (items.length === 0) return;
  const selected = Math.max(Math.min(ui.configEditor.selectedIndex, items.length - 1), 0);
  const item = items[selected];
  const daemonBound = IS_DAEMON_MODE;

  try {
    if (item.kind === "action" && item.key === "bootstrapResetState") {
      const persisted = await resetBootstrapPreference();
      cfg.bootstrapReset = true;
      let bootstrap = { applied: false, mode: "prompt", ingestMode: runtime.ingestMode };
      if (daemonBound) {
        bootstrap = await applyBootstrapModeNow("prompt", { shouldPrompt: true });
      } else {
        const saved = await persistConfigPrefs();
        if (!saved.fileSaved && !saved.redisSaved) {
          ui.resume.notice = "Bootstrap reset requested but config persistence failed.";
        }
      }
      const note = bootstrap.applied
        ? `Bootstrap reset applied now (${bootstrapModeLabel(bootstrap.mode)}).`
        : persisted
        ? "Bootstrap state reset in Redis. It will apply on next daemon cycle/start."
        : "Bootstrap reset requested.";
      ui.resume.notice = note;
      log("info", "Config action executed", {
        key: item.key,
        persisted: persisted ? "yes" : "no",
        applied_now: bootstrap.applied ? "yes" : "no",
        mode: bootstrap.mode,
      });
      return;
    }

    if (item.kind === "enum" && item.key === "bootstrapMode") {
      const currentIndex = Math.max(
        CONFIG_BOOTSTRAP_MODES.findIndex((entry) => entry.id === item.value),
        0
      );
      const next = CONFIG_BOOTSTRAP_MODES[(currentIndex + 1) % CONFIG_BOOTSTRAP_MODES.length];
      cfg.bootstrapMode = next.id;
      cfg.bootstrapReset = next.id === "prompt";
      const persisted = await persistBootstrapPreference(next.id);
      const prefsSaved = await persistConfigPrefs();
      const bootstrap = daemonBound
        ? await applyBootstrapModeNow(next.id, { shouldPrompt: next.id === "prompt" })
        : { applied: false, ingestMode: runtime.ingestMode };

      ui.resume.notice = bootstrap.applied
        ? `Sync profile applied: ${next.label} (${bootstrap.ingestMode}).`
        : persisted
        ? `Sync profile set: ${next.label} (persisted).`
        : `Sync profile set: ${next.label}.`;

      log("info", "Config updated", {
        key: item.key,
        value: next.id,
        persisted: persisted ? "yes" : "no",
        file_saved: prefsSaved.fileSaved ? "yes" : "no",
        redis_saved: prefsSaved.redisSaved ? "yes" : "no",
        applied_now: bootstrap.applied ? "yes" : "no",
        ingest_mode: bootstrap.ingestMode,
      });
      return;
    }

    if (item.kind === "enum" && item.key === "resumeTerminal") {
      const current = normalizeResumeTerminal(item.value);
      const currentIndex = Math.max(
        CONFIG_RESUME_TERMINALS.findIndex((entry) => entry.id === current),
        0
      );
      const next = CONFIG_RESUME_TERMINALS[(currentIndex + 1) % CONFIG_RESUME_TERMINALS.length];
      cfg.resumeTerminal = next.id;
      const saved = await persistConfigPrefs();
      ui.resume.notice = `Resume terminal: ${next.label}${saved.fileSaved ? " (saved)" : ""}.`;
      log("info", "Config updated", {
        key: item.key,
        value: next.id,
        file_saved: saved.fileSaved ? "yes" : "no",
        redis_saved: saved.redisSaved ? "yes" : "no",
      });
      return;
    }

    if (item.kind === "boolean") {
      cfg[item.key] = !cfg[item.key];
      const effectiveAfter = configToggleItems().find((entry) => entry.key === item.key);
      log("info", "Config updated", {
        key: item.key,
        raw_value: cfg[item.key] ? "on" : "off",
        effective_value: effectiveAfter?.value ? "on" : "off",
      });

      if (item.key === "claudeIncludeSubagents") {
        const saved = await persistConfigPrefs();
        if (daemonBound) {
          const nextSources = buildSources();
          applyRuntimeSources(nextSources);
        }
        ui.resume.notice = cfg.claudeIncludeSubagents
          ? `Claude subagents: ON (${daemonBound ? "applied now" : "pending daemon reload"}${saved.fileSaved ? ", saved to file" : ""}).`
          : `Claude subagents: OFF (${daemonBound ? "applied now" : "pending daemon reload"}${saved.fileSaved ? ", saved to file" : ""}).`;
        return;
      }

      if (
        item.key === "soundEnabled" ||
        item.key === "startupSoundEnabled" ||
        item.key === "contextSoundEnabled"
      ) {
        await prepareSoundConfig();
        const saved = await persistConfigPrefs();
        ui.resume.notice = `${item.label}: ${cfg[item.key] ? "ON" : "OFF"} (${daemonBound ? "applied now" : "saved for daemon"}${saved.fileSaved ? ", file saved" : ""}).`;
      }
    }
  } catch (error) {
    ui.resume.notice = "Failed to apply config";
    log("warn", "Failed to apply config toggle", {
      key: item.key,
      ...errorDetails(error),
    });
  }
}

function setSelectedTabByIndex(nextIndex) {
  const normalized = (nextIndex + MENU_TABS.length) % MENU_TABS.length;
  ui.selectedTab = MENU_TABS[normalized].id;
}

function ensureResumeTabDataLoaded() {
  if (ui.selectedTab !== "contexts") return;
  if (ui.resume.contexts.length === 0 && !ui.resume.loading) {
    void loadResumeContexts();
  }
}

function selectTabAndRefreshByIndex(index) {
  setSelectedTabByIndex(index);
  ensureResumeTabDataLoaded();
  renderDashboard();
}

function moveTabAndRefresh(delta) {
  setSelectedTabByIndex(selectedTabIndex() + delta);
  ensureResumeTabDataLoaded();
  renderDashboard();
}

function buildUiSnapshot() {
  const configItems = configToggleItems();
  const selectedConfigIndex = Math.max(
    Math.min(ui.configEditor.selectedIndex, Math.max(configItems.length - 1, 0)),
    0
  );
  return {
    now: Date.now(),
    cfg: {
      engineerId: cfg.engineerId,
      host: cfg.host,
      redisUrl: cfg.redisUrl,
      pollMs: cfg.pollMs,
      uiRefreshMs: cfg.uiRefreshMs,
      logLevel: cfg.logLevel,
      soundEnabled: cfg.soundEnabled,
      startupSoundEnabled: cfg.startupSoundEnabled,
      contextSoundEnabled: cfg.contextSoundEnabled,
      startupGreetingFile: cfg.startupGreetingFile,
      contextCreatedSoundFile: cfg.contextCreatedSoundFile,
    },
    stats,
    selectedTab: ui.selectedTab,
    configEditor: {
      selectedIndex: selectedConfigIndex,
      items: configItems,
    },
    recentLogs: ui.recentLogs.slice(-Math.max(cfg.uiRecentLimit, 1)),
    sourceStats: ui.sourceOrder.map((name) => ({
      name,
      ...ensureSourceStats(name),
    })),
    resume: {
      ...ui.resume,
      contexts: ui.resume.contexts,
    },
    resumeTargetPicker: {
      active: ui.resumeTargetPicker.active,
      selectedIndex: ui.resumeTargetPicker.selectedIndex,
      source: ui.resumeTargetPicker.source,
      contextId: ui.resumeTargetPicker.contextId,
      options: ui.resumeTargetPicker.options,
      recommendedTarget: ui.resumeTargetPicker.recommendedTarget,
    },
    onlineClients: ui.onlineClients,
    bootstrap: {
      active: ui.bootstrap.active,
      selectedIndex: ui.bootstrap.selectedIndex,
      options: ui.bootstrap.options,
      sourceNames: ui.bootstrap.sourceNames,
      note: ui.bootstrap.note,
    },
  };
}

function buildDaemonRuntimeSnapshot() {
  return {
    ts: Date.now(),
    mode: "daemon",
    running: Boolean(runtime.daemonRunning),
    pid: process.pid,
    host: cfg.host,
    engineerId: cfg.engineerId,
    stats,
    sourceStats: ui.sourceOrder.map((name) => ({
      name,
      ...ensureSourceStats(name),
    })),
  };
}

async function publishDaemonRuntimeSnapshot() {
  if (!runtime.redis) return;
  const key = runtimeStateRedisKey();
  const payload = JSON.stringify(buildDaemonRuntimeSnapshot());
  await runtime.redis
    .multi()
    .set(key, payload, "EX", Math.max(cfg.instanceLockTtlSec * 8, 120))
    .expire(runtimeLogsRedisKey(), Math.max(cfg.instanceLockTtlSec * 8, 120))
    .exec();
}

function applyRemoteRuntimeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const remoteStats = snapshot.stats;
  if (remoteStats && typeof remoteStats === "object") {
    Object.assign(stats, remoteStats);
  }
  const sourceStats = Array.isArray(snapshot.sourceStats) ? snapshot.sourceStats : [];
  ui.sourceOrder = [];
  ui.sourceStats.clear();
  for (const item of sourceStats) {
    const name = String(item?.name ?? "").trim();
    if (!name) continue;
    ui.sourceOrder.push(name);
    ui.sourceStats.set(name, {
      filesScanned: Number(item.filesScanned ?? 0),
      linesRead: Number(item.linesRead ?? 0),
      parsedEvents: Number(item.parsedEvents ?? 0),
      appended: Number(item.appended ?? 0),
      deduped: Number(item.deduped ?? 0),
      contextsCreated: Number(item.contextsCreated ?? 0),
      errors: Number(item.errors ?? 0),
      lastEventType: item.lastEventType ?? "-",
      lastSessionId: item.lastSessionId ?? "-",
      lastAt: Number(item.lastAt ?? 0),
      lastFile: item.lastFile ?? "-",
    });
  }
}

function applyRemoteLogs(rawList) {
  const parsed = [];
  for (const raw of rawList ?? []) {
    const item = parseRedisJson(raw, null);
    if (!item || typeof item !== "object") continue;
    if (!item.ts || !item.level) continue;
    parsed.push({
      ts: String(item.ts),
      level: String(item.level),
      source: String(item.source ?? ""),
      text: String(item.text ?? ""),
    });
  }
  ui.recentLogs = parsed.reverse();
}

async function syncRemoteDaemonState() {
  if (!runtime.redis) return;
  try {
    const stateKey = runtimeStateRedisKey();
    const logsKey = runtimeLogsRedisKey();
    const rows = await runtime.redis
      .multi()
      .get(stateKey)
      .lrange(logsKey, 0, runtimeLogsKeep() - 1)
      .exec();
    const values = Array.isArray(rows) ? rows.map(([, value]) => value) : [null, []];
    const [stateRaw, logsRaw] = values;
    const snapshot = parseRedisJson(stateRaw, null);
    applyRemoteRuntimeSnapshot(snapshot);
    applyRemoteLogs(Array.isArray(logsRaw) ? logsRaw : []);
    await refreshOnlineClients(runtime.redis);
  } catch (error) {
    log("warn", "Failed to sync daemon state", errorDetails(error));
  }
}

function renderDashboard() {
  if (!prettyUi) return;
  uiController?.refresh();
}
function emitStatusLine() {
  if (prettyUi) {
    renderDashboard();
    return;
  }

  const uptime = humanUptime(Date.now() - stats.startedAt);
  const line = [
    color("STATUS", ANSI.cyan),
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
  console.log(color(line, ANSI.dim));
}

async function resolveSoundFile(filePath, label) {
  if (!filePath) return "";
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      log("warn", "Configured sound is not a file", { label, file: filePath });
      return "";
    }
    return filePath;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log("warn", "Failed to read configured sound file", {
        label,
        file: filePath,
        ...errorDetails(error),
      });
      return "";
    }
    log("warn", "Configured sound file not found", { label, file: filePath });
    return "";
  }
}

async function prepareSoundConfig() {
  sound.startupFile = "";
  sound.contextFile = "";
  sound.warnedNonDarwin = false;
  if (!cfg.soundEnabled) return;
  sound.startupFile = await resolveSoundFile(cfg.startupGreetingFile, "startup");
  sound.contextFile = await resolveSoundFile(cfg.contextCreatedSoundFile, "context_created");
}

function playSoundFile(filePath, reason, details = {}) {
  if (!cfg.soundEnabled || !filePath) return;
  if (process.platform !== "darwin") {
    if (!sound.warnedNonDarwin) {
      sound.warnedNonDarwin = true;
      log("warn", "Sound notifications currently support only macOS (afplay)", { reason });
    }
    return;
  }

  try {
    const child = spawn("afplay", [filePath], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      log("warn", "Failed to play sound", { reason, file: filePath, ...details, ...errorDetails(error) });
    });
    child.unref();
  } catch (error) {
    log("warn", "Failed to play sound", { reason, file: filePath, ...details, ...errorDetails(error) });
  }
}

function playStartupGreetingSound() {
  if (!cfg.startupSoundEnabled) return;
  playSoundFile(sound.startupFile, "startup_greeting");
}

function playContextCreatedSound(metadata) {
  if (!cfg.contextSoundEnabled) return;
  playSoundFile(sound.contextFile, "context_created", {
    kind: metadata?.context_kind ?? "session",
    session_id: metadata?.session_id ?? "",
  });
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

function normalizeBootstrapMode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "new" || value === "new_only" || value === "latest") return "new_only";
  if (value === "24h" || value === "last_24h" || value === "last24h") return "last_24h";
  if (value === "all" || value === "full") return "all";
  return "";
}

function bootstrapRedisKey(sources) {
  const names = sources.map((source) => source.name).sort().join(",");
  return `uc:daemon:bootstrap:v1:${cfg.host}:${cfg.engineerId}:${names}`;
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

function requestBootstrapChoice(sources) {
  ui.bootstrap.active = true;
  ui.bootstrap.selectedIndex = 0;
  ui.bootstrap.sourceNames = sources.map((source) => source.name);
  ui.bootstrap.note = "Choose the initial sync strategy.";
  renderDashboard();

  return new Promise((resolve) => {
    runtime.bootstrapResolve = resolve;
  });
}

function chooseBootstrapModeByIndex(index) {
  const safeIndex = Math.max(Math.min(index, BOOTSTRAP_OPTIONS.length - 1), 0);
  const option = BOOTSTRAP_OPTIONS[safeIndex];
  ui.bootstrap.active = false;
  ui.bootstrap.selectedIndex = safeIndex;
  ui.bootstrap.note = `Bootstrap: ${option.label}`;
  const resolve = runtime.bootstrapResolve;
  runtime.bootstrapResolve = null;
  renderDashboard();
  resolve?.(option.id);
}

function moveBootstrapSelection(delta) {
  const total = BOOTSTRAP_OPTIONS.length;
  if (total <= 0) return;
  const base = Number.isInteger(ui.bootstrap.selectedIndex) ? ui.bootstrap.selectedIndex : 0;
  ui.bootstrap.selectedIndex = (base + delta + total) % total;
  renderDashboard();
}

async function primeOffsetsToEof(redis, source, shouldStop = () => false) {
  if (shouldStop()) return;
  const files = await listSourceFiles(source);
  for (const filePath of files) {
    if (shouldStop()) break;
    try {
      const stat = await fs.stat(filePath);
      const fileId = `${stat.dev}:${stat.ino}`;
      const offsetKey = makeRedisKeys(source.name, fileId, "unused", "unused").offset;
      await redis.set(offsetKey, String(stat.size));
    } catch {
      // Ignore missing/ephemeral files during bootstrap.
    }
  }
}

async function resolveBootstrapPlan({ redis, sources }) {
  const key = bootstrapRedisKey(sources);
  if (cfg.bootstrapReset) {
    await redis.del(key);
    ui.bootstrap.note = "Bootstrap reset by configuration.";
  }

  const forcedMode = normalizeBootstrapMode(cfg.bootstrapMode);
  if (forcedMode) return { mode: forcedMode, needsBootstrap: true, forced: true };

  const stored = normalizeBootstrapMode(await redis.get(key));
  if (stored) return { mode: stored, needsBootstrap: false, forced: false };

  if (!prettyUi) return { mode: "new_only", needsBootstrap: true, forced: false };
  return { mode: await requestBootstrapChoice(sources), needsBootstrap: true, forced: false };
}

async function applyBootstrapMode({ redis, sources, mode, needsBootstrap, shouldStop = () => false }) {
  const selected = normalizeBootstrapMode(mode) || "new_only";
  if (!needsBootstrap) {
    ui.bootstrap.note = `Bootstrap saved: ${bootstrapModeLabel(selected)}`;
    return "all";
  }

  if (selected === "new_only") {
    for (const source of sources) {
      if (shouldStop()) break;
      await primeOffsetsToEof(redis, source, shouldStop);
    }
  }
  if (shouldStop()) return "all";
  const key = bootstrapRedisKey(sources);
  await redis.set(key, selected);
  ui.bootstrap.note = `Bootstrap active: ${bootstrapModeLabel(selected)}`;
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

function buildInstanceLockKey() {
  return `uc:daemon:lock:${cfg.host}:${cfg.engineerId}`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function readActiveDaemonLock(redis) {
  const lockKey = buildInstanceLockKey();
  const raw = String((await redis.get(lockKey)) ?? "");
  if (!raw) return null;
  const pidRaw = raw.split(":")[0] ?? "";
  const pid = Number.parseInt(pidRaw, 10);
  const alive = isPidAlive(pid);
  return { lockKey, raw, pid, alive };
}

function spawnDetachedDaemonProcess() {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      TUI_MODE: "plain",
    },
  });
  child.unref();
}

async function ensureDaemonRunning(redis) {
  const current = await readActiveDaemonLock(redis);
  if (current?.alive) {
    ui.resume.notice = `Daemon online (pid=${current.pid})`;
    return { started: false, pid: current.pid };
  }
  if (current && !current.alive) {
    const deleteIfSameScript =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await redis.eval(deleteIfSameScript, 1, current.lockKey, current.raw);
  }

  spawnDetachedDaemonProcess();
  const waitUntil = Date.now() + 7000;
  while (Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const check = await readActiveDaemonLock(redis);
    if (check?.alive) {
      ui.resume.notice = `Daemon started (pid=${check.pid})`;
      return { started: true, pid: check.pid };
    }
  }
  throw new Error("Daemon did not start in time. Check state-store/API credentials and run `node src/index.mjs --daemon`.");
}

async function acquireInstanceLock(redis) {
  const ttlMs = Math.max(cfg.instanceLockTtlSec * 1000, 5000);
  const refreshMs = Math.max(Math.floor(ttlMs / 3), 1000);
  const key = buildInstanceLockKey();
  const token = `${process.pid}:${randomUUID()}`;
  let setResult = await redis.set(key, token, "PX", ttlMs, "NX");

  if (setResult !== "OK") {
    const holder = String((await redis.get(key)) ?? "");
    const holderPidRaw = holder.split(":")[0] ?? "";
    const holderPid = Number.parseInt(holderPidRaw, 10);
    if (holder && Number.isInteger(holderPid) && !isPidAlive(holderPid)) {
      const deleteIfSameScript =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
      await redis.eval(deleteIfSameScript, 1, key, holder);
      setResult = await redis.set(key, token, "PX", ttlMs, "NX");
    }
  }

  if (setResult !== "OK") {
    const holder = await redis.get(key);
    const holderPid = String(holder ?? "").split(":")[0];
    const holderHint = holderPid ? ` (active_pid=${holderPid})` : "";
    throw new Error(
      `UltraContext is already running for host=${cfg.host} engineer=${cfg.engineerId}${holderHint}. Stop the other instance before starting a new one.`
    );
  }

  runtime.lock = { key, token, ttlMs };
  runtime.lockRefreshFailures = 0;
  runtime.lockTimer = setInterval(() => {
    void refreshInstanceLock(redis).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Instance lock was lost") {
        bumpStat("errors");
        log("error", "Instance lock lost; stopping daemon", {
          ...errorDetails(error),
          lock_key: key,
        });
        runtime.stop?.();
        return;
      }

      runtime.lockRefreshFailures += 1;
      log("warn", "Failed to refresh instance lock (will retry)", {
        ...errorDetails(error),
        lock_key: key,
        attempt: runtime.lockRefreshFailures,
      });
    });
  }, refreshMs);
  runtime.lockTimer.unref?.();
}

async function refreshInstanceLock(redis) {
  if (!runtime.lock) return;
  const script =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
  const result = await redis.eval(
    script,
    1,
    runtime.lock.key,
    runtime.lock.token,
    String(runtime.lock.ttlMs)
  );
  if (Number(result) !== 1) {
    throw new Error("Instance lock was lost");
  }
  runtime.lockRefreshFailures = 0;
}

async function releaseInstanceLock(redis) {
  if (runtime.lockTimer) {
    clearInterval(runtime.lockTimer);
    runtime.lockTimer = null;
  }
  runtime.lockRefreshFailures = 0;
  if (!runtime.lock) return;
  try {
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await redis.eval(script, 1, runtime.lock.key, runtime.lock.token);
  } finally {
    runtime.lock = null;
  }
}

function makeRedisKeys(sourceName, fileId, sessionId, dayKey) {
  return {
    offset: `uc:daemon:offset:${sourceName}:${fileId}`,
    dedupePrefix: `uc:daemon:seen:${sourceName}:`,
    sessionContext: `uc:daemon:ctx:session:${sourceName}:${cfg.host}:${cfg.engineerId}:${sessionId}`,
    dailyContext: `uc:daemon:ctx:daily:${sourceName}:${cfg.host}:${cfg.engineerId}:${dayKey}`,
  };
}

async function markEventSeen(redis, sourceName, eventId) {
  const key = `uc:daemon:seen:${sourceName}:${eventId}`;
  const result = await redis.set(key, "1", "EX", cfg.dedupeTtlSec, "NX");
  return result === "OK";
}

async function getOrCreateContext(redis, uc, redisKey, metadata, sourceName) {
  const cached = await redis.get(redisKey);
  if (cached) return cached;

  try {
    const created = await uc.create({ metadata });
    await redis.set(redisKey, created.id);
    bumpStat("contextsCreated");
    bumpSourceStat(sourceName, "contextsCreated");
    if (prettyUi || cfg.logAppends) {
      log("info", "Context created", {
        source: sourceName,
        context_id: created.id,
        kind: metadata?.context_kind ?? "session",
        session_id: metadata?.session_id ?? "",
        day: metadata?.day ?? "",
      });
    }
    playContextCreatedSound(metadata);
    return created.id;
  } catch (error) {
    const details = errorDetails(error);
    bumpStat("errors");
    bumpSourceStat(sourceName, "errors");
    log("warn", "Failed to create context with metadata", details);

    // Fallback: if API rejects metadata (400), create empty context to avoid full pipeline stop.
    if (details.status === 400) {
      const created = await uc.create();
      await redis.set(redisKey, created.id);
      bumpStat("contextsCreated");
      bumpSourceStat(sourceName, "contextsCreated");
      if (prettyUi || cfg.logAppends) {
        log("warn", "Context created without metadata fallback", {
          source: sourceName,
          context_id: created.id,
          kind: metadata?.context_kind ?? "session",
        });
      }
      playContextCreatedSound(metadata);
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

async function appendToUltraContext({ redis, uc, sourceName, normalized, eventId, filePath, lineOffset }) {
  const dayKey = toDayKey(normalized.timestamp);
  const keys = makeRedisKeys(sourceName, "unused", normalized.sessionId, dayKey);

  const sessionContextId = await getOrCreateContext(
    redis,
    uc,
    keys.sessionContext,
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
    redis,
    uc,
    keys.dailyContext,
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

async function processFile({ redis, uc, source, filePath, shouldStop = () => false, ingestMode = "all" }) {
  if (shouldStop()) return;
  try {
    const stat = await fs.stat(filePath);
    bumpStat("filesScanned");
    bumpSourceStat(source.name, "filesScanned");
    const fileId = `${stat.dev}:${stat.ino}`;
    const offsetKey = makeRedisKeys(source.name, fileId, "unused", "unused").offset;
    const currentOffset = toInt(await redis.get(offsetKey), 0);
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

      const isNew = await markEventSeen(redis, source.name, eventId);
      if (!isNew) {
        bumpStat("deduped");
        bumpSourceStat(source.name, "deduped");
        continue;
      }

      await appendToUltraContext({
        redis,
        uc,
        sourceName: source.name,
        normalized,
        eventId,
        filePath,
        lineOffset,
      });
    }

    await redis.set(offsetKey, String(nextOffset));
  } catch (error) {
    bumpStat("errors");
    bumpSourceStat(source.name, "errors");
    log("warn", `Failed to process file for source=${source.name}`, {
      filePath,
      ...errorDetails(error),
    });
  }
}

async function processSource({ redis, uc, source, shouldStop = () => false, ingestMode = "all" }) {
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
    await processFile({ redis, uc, source, filePath, shouldStop, ingestMode });
  }
}

async function daemonMain() {
  validateConfig();
  const redis = createRedisClient(cfg.redisUrl);
  runtime.redis = redis;
  const uc = new UltraContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  runtime.uc = uc;

  await redis.ping();
  try {
    const fileLoad = await loadConfigPrefsFromFile();
    const loadedFromFile = fileLoad.loaded;
    const loadedFromRedis = await loadConfigPrefs(redis);
    if (loadedFromFile || loadedFromRedis) {
      log("info", "Loaded persisted config preferences", {
        file: loadedFromFile ? "yes" : "no",
        file_source: loadedFromFile ? fileLoad.source : "none",
        file_path: loadedFromFile ? fileLoad.file : "",
        redis: loadedFromRedis ? "yes" : "no",
      });
    }
    if (loadedFromRedis && !loadedFromFile) {
      const saved = await persistConfigPrefs();
      log("info", "Materialized Redis config prefs into file", {
        file_saved: saved.fileSaved ? "yes" : "no",
      });
    }
    if (!loadedFromFile && !loadedFromRedis) {
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

  await prepareSoundConfig();
  await acquireInstanceLock(redis);
  try {
    await uc.get({ limit: 1 });
  } catch (error) {
    const details = errorDetails(error);
    throw new Error(
      `UltraContext auth/connectivity check failed (status=${details.status ?? "?"}, url=${details.url ?? cfg.baseUrl}, body=${details.bodyText ?? details.message})`
    );
  }

  log("info", "UltraContext daemon started", {
    engineer_id: cfg.engineerId,
    host: cfg.host,
    poll_ms: cfg.pollMs,
    ui_mode: prettyUi ? "pretty" : "plain",
    ui_refresh_ms: cfg.uiRefreshMs,
    sources: sources.map((s) => ({ name: s.name, globs: s.globs })),
  });
  playStartupGreetingSound();
  runtime.daemonRunning = true;
  try {
    await publishDaemonRuntimeSnapshot();
  } catch {
    // Non-fatal; TUI will retry on next heartbeat.
  }
  daemonStateTimer = setInterval(() => {
    void publishDaemonRuntimeSnapshot().catch(() => {});
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
    if (runtime.bootstrapResolve) {
      const resolve = runtime.bootstrapResolve;
      runtime.bootstrapResolve = null;
      resolve("new_only");
    }
  };
  runtime.stop = stop;

  if (prettyUi) {
    uiController = createInkUiController({
      getSnapshot: buildUiSnapshot,
      actions: {
        stop: () => runtime.stop?.("user"),
        moveBootstrap: (delta) => {
          moveBootstrapSelection(delta);
        },
        chooseBootstrap: (index) => {
          chooseBootstrapModeByIndex(index);
        },
        moveTab: moveTabAndRefresh,
        selectTab: selectTabAndRefreshByIndex,
        moveConfig: (delta) => {
          moveConfigSelection(delta);
          renderDashboard();
        },
        toggleConfig: () => {
          void toggleSelectedConfig().finally(() => {
            renderDashboard();
          });
        },
        moveResume: (delta) => {
          moveResumeSelection(delta);
          renderDashboard();
        },
        refreshResume: () => {
          void loadResumeContexts();
        },
        promptResumeTarget: () => {
          openResumeTargetPicker();
        },
        moveResumeTarget: (delta) => {
          moveResumeTargetPickerSelection(delta);
        },
        chooseResumeTarget: (index) => {
          const target = resumeTargetPickerSelectionByIndex(index);
          void resumeSelectedContext({ targetAgentOverride: target });
        },
        cancelResumeTarget: () => {
          closeResumeTargetPicker();
        },
      },
    });
    uiController.start();
    statusTimer = setInterval(renderDashboard, Math.max(cfg.uiRefreshMs, 250));
    statusTimer.unref?.();
    renderDashboard();
    void loadResumeContexts();
  }

  process.on("SIGINT", () => stop("sigint"));
  process.on("SIGTERM", () => stop("sigterm"));

  runtime.ingestMode = "all";
  if (running) {
    const bootstrapPlan = await resolveBootstrapPlan({ redis, sources });
    if (running) {
      runtime.ingestMode = await applyBootstrapMode({
        redis,
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
      await refreshDaemonConfigFromRedis(redis);
    } catch (error) {
      log("warn", "Failed to refresh daemon config from Redis", errorDetails(error));
    }
    bumpStat("cycles");
    const cycleStart = Date.now();
    const cycleSources = runtime.sources ?? [];
    for (const source of cycleSources) {
      if (!running) break;
      await processSource({
        redis,
        uc,
        source,
        shouldStop: () => !running,
        ingestMode: runtime.ingestMode ?? "all",
      });
    }
    if (!running) break;
    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(cfg.pollMs - elapsed, 10);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  if (daemonStateTimer) clearInterval(daemonStateTimer);
  daemonStateTimer = null;
  runtime.daemonRunning = false;
  try {
    await publishDaemonRuntimeSnapshot();
  } catch {
    // Ignore shutdown snapshot failures.
  }
  runtime.uc = null;
  runtime.stop = null;
  runtime.sources = null;
  runtime.ingestMode = "all";
  emitStatusLine();
  await releaseInstanceLock(redis);
  await redis.quit();
  runtime.redis = null;
  log("info", "UltraContext daemon stopped");
  if (prettyUi) {
    renderDashboard();
    uiController?.stop();
    uiController = null;
  }
}

async function tuiMain() {
  validateConfig();
  if (!prettyUi) {
    throw new Error("TUI mode requires a TTY. Run with `--daemon` for headless mode.");
  }

  const redis = createRedisClient(cfg.redisUrl);
  runtime.redis = redis;
  const uc = new UltraContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  runtime.uc = uc;

  await redis.ping();
  await uc.get({ limit: 1 });

  try {
    const fileLoad = await loadConfigPrefsFromFile();
    const loadedFromFile = fileLoad.loaded;
    const loadedFromRedis = await loadConfigPrefs(redis);
    if (loadedFromRedis && !loadedFromFile) {
      await persistConfigPrefsToFile();
    }
    if (!loadedFromFile && !loadedFromRedis) {
      await persistConfigPrefsToFile();
    }
  } catch (error) {
    log("warn", "Failed to load persisted config preferences", errorDetails(error));
  }

  await prepareSoundConfig();
  applyRuntimeSources(buildSources());
  await ensureDaemonRunning(redis);
  await syncRemoteDaemonState();

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

  uiController = createInkUiController({
    getSnapshot: buildUiSnapshot,
    actions: {
      stop: () => runtime.stop?.("user"),
      moveBootstrap: () => {},
      chooseBootstrap: () => {},
      moveTab: moveTabAndRefresh,
      selectTab: selectTabAndRefreshByIndex,
      moveConfig: (delta) => {
        moveConfigSelection(delta);
        renderDashboard();
      },
      toggleConfig: () => {
        void toggleSelectedConfig().finally(() => {
          renderDashboard();
        });
      },
      moveResume: (delta) => {
        moveResumeSelection(delta);
        renderDashboard();
      },
      refreshResume: () => {
        void loadResumeContexts();
      },
      promptResumeTarget: () => {
        openResumeTargetPicker();
      },
      moveResumeTarget: (delta) => {
        moveResumeTargetPickerSelection(delta);
      },
      chooseResumeTarget: (index) => {
        const target = resumeTargetPickerSelectionByIndex(index);
        void resumeSelectedContext({ targetAgentOverride: target });
      },
      cancelResumeTarget: () => {
        closeResumeTargetPicker();
      },
    },
  });
  uiController.start();
  renderDashboard();

  remotePollTimer = setInterval(() => {
    void syncRemoteDaemonState().finally(() => {
      renderDashboard();
    });
  }, Math.max(cfg.uiRefreshMs, 300));
  remotePollTimer.unref?.();
  statusTimer = setInterval(renderDashboard, Math.max(cfg.uiRefreshMs, 250));
  statusTimer.unref?.();
  void loadResumeContexts();

  process.on("SIGINT", () => stop("sigint"));
  process.on("SIGTERM", () => stop("sigterm"));

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (remotePollTimer) clearInterval(remotePollTimer);
  remotePollTimer = null;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  uiController?.stop();
  uiController = null;
  runtime.stop = null;
  runtime.uc = null;
  await redis.quit();
  runtime.redis = null;
}

async function runApp() {
  if (IS_DAEMON_MODE) {
    await daemonMain();
    return;
  }
  await tuiMain();
}

installStdioErrorGuards();

runApp().catch(async (error) => {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  if (remotePollTimer) clearInterval(remotePollTimer);
  remotePollTimer = null;
  if (daemonStateTimer) clearInterval(daemonStateTimer);
  daemonStateTimer = null;
  runtime.daemonRunning = false;
  if (runtime.redis) {
    if (IS_DAEMON_MODE) {
      try {
        await publishDaemonRuntimeSnapshot();
      } catch {
        // Ignore snapshot failure during crash path.
      }
      try {
        await releaseInstanceLock(runtime.redis);
      } catch (lockError) {
        log("warn", "Failed to release instance lock during shutdown", errorDetails(lockError));
      }
    }
    try {
      await runtime.redis.quit();
    } catch (redisError) {
      log("warn", "Failed to close Redis during shutdown", errorDetails(redisError));
    }
    runtime.redis = null;
  }
  runtime.uc = null;
  runtime.stop = null;
  runtime.sources = null;
  runtime.ingestMode = "all";
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isAlreadyRunning = errorMessage.startsWith("UltraContext is already running");
  if (isAlreadyRunning) {
    if (prettyUi && !uiController) {
      console.error(`[warn] ${errorMessage}`);
    } else {
      log("warn", "UltraContext already running", { error: errorMessage });
    }
    if (IS_DAEMON_MODE) {
      stopWatchParentProcess();
    }
  } else {
    bumpStat("errors");
    if (prettyUi && !uiController) {
      console.error(`[error] UltraContext failed: ${errorMessage}`);
    } else {
      log("error", "UltraContext failed", { error: errorMessage });
    }
  }
  if (prettyUi) {
    renderDashboard();
    uiController?.stop();
    uiController = null;
  }
  process.exit(isAlreadyRunning ? 2 : 1);
});
