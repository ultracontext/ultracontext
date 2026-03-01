// tui core — exported as tuiBoot(), no env.mjs import (caller handles that)
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { UltraContext } from "ultracontext";
import {
  DAEMON_WS_MESSAGE_TYPES,
  normalizeBootstrapMode,
  resolveDaemonWsHost,
  resolveDaemonWsInfoFile,
} from "@ultracontext/protocol";

import {
  hasLocalClaudeSession,
  hasLocalCodexSession,
  materializeClaudeSession,
  materializeCodexSession,
} from "./codex-local-resume.mjs";
import { MENU_TABS, createInkUiController } from "./ui.mjs";
import { boolFromEnv, expandHome, toInt } from "./utils.mjs";
import { createDaemonWsClient } from "./ws-client.mjs";

const DEFAULT_RUNTIME_CONFIG_FILE = "~/.ultracontext/config.json";

// ── exported boot function ──────────────────────────────────────

export async function tuiBoot({
  assetsRoot,
  offlineNotice,
  onFatalError,
} = {}) {

const APP_ROOT = assetsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STARTUP_SOUND_FILE = path.join(APP_ROOT, "assets", "sounds", "hello_mf.mp3");
const DEFAULT_CONTEXT_SOUND_FILE = path.join(APP_ROOT, "assets", "sounds", "quack.mp3");
const OFFLINE_NOTICE = offlineNotice ?? "Daemon offline. Run: pnpm --filter @ultracontext/daemon run start";

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
  "resumeOpenTab",
  "startupGreetingFile",
  "contextCreatedSoundFile",
];

function normalizeApiKey(raw) {
  if (!raw) return "";
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

function normalizeBootstrapModeWithPrompt(raw) {
  return normalizeBootstrapMode(raw, { allowPrompt: true }) || "";
}

function readEnv(...keys) {
  for (const key of keys) {
    if (process.env[key] !== undefined) return process.env[key];
  }
  return undefined;
}

const cfg = {
  apiKey: normalizeApiKey(process.env.ULTRACONTEXT_API_KEY),
  baseUrl: (process.env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai").trim(),
  daemonWsHost: resolveDaemonWsHost(process.env),
  daemonWsInfoFile: resolveDaemonWsInfoFile(process.env),
  engineerId: process.env.DAEMON_ENGINEER_ID ?? process.env.USER ?? "unknown-engineer",
  host: (process.env.DAEMON_HOST || os.hostname() || "unknown-host").trim(),
  uiRefreshMs: toInt(process.env.TUI_REFRESH_MS, 1200),
  resumeAutoRefreshMs: Math.max(toInt(process.env.RESUME_AUTO_REFRESH_MS, 3500), 0),
  uiRecentLimit: toInt(process.env.TUI_RECENT_LIMIT, 240),
  configFile: resolveRuntimeConfigPath(),
  soundEnabled: boolFromEnv(readEnv("TUI_SOUND_ENABLED", "DAEMON_SOUND_ENABLED"), true),
  startupSoundEnabled: boolFromEnv(
    readEnv("TUI_STARTUP_SOUND_ENABLED", "DAEMON_STARTUP_SOUND_ENABLED"),
    true
  ),
  contextSoundEnabled: boolFromEnv(
    readEnv("TUI_CONTEXT_SOUND_ENABLED", "DAEMON_CONTEXT_SOUND_ENABLED"),
    true
  ),
  startupGreetingFile: expandHome(
    readEnv("TUI_STARTUP_SOUND_FILE", "DAEMON_STARTUP_GREETING_FILE") ?? DEFAULT_STARTUP_SOUND_FILE
  ),
  contextCreatedSoundFile: expandHome(
    readEnv("TUI_CONTEXT_SOUND_FILE", "DAEMON_CONTEXT_SOUND_FILE") ?? DEFAULT_CONTEXT_SOUND_FILE
  ),
  bootstrapMode: normalizeBootstrapModeWithPrompt(process.env.DAEMON_BOOTSTRAP_MODE ?? "prompt") || "prompt",
  bootstrapReset: boolFromEnv(process.env.DAEMON_BOOTSTRAP_RESET, false),
  claudeIncludeSubagents: boolFromEnv(process.env.CLAUDE_INCLUDE_SUBAGENTS, false),
  resumeTerminal: normalizeResumeTerminal(process.env.RESUME_TERMINAL),
  resumeContextLimit: toInt(process.env.RESUME_CONTEXT_LIMIT, 1000),
  resumeSourceFilter: normalizeResumeSourceFilter(process.env.RESUME_SOURCE_FILTER),
  resumeSummaryTail: toInt(process.env.RESUME_SUMMARY_TAIL, 14),
  resumeOutputDir: expandHome(process.env.RESUME_OUTPUT_DIR ?? "~/.codex/resume"),
  resumeOpenTab: boolFromEnv(process.env.RESUME_OPEN_TAB, true),
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

const CONFIG_TOGGLES = [
  {
    key: "soundEnabled",
    label: "Master sounds",
    description: "Enable or disable all app sounds",
  },
  {
    key: "startupSoundEnabled",
    label: "Startup sounds",
    description: "Play sound when the TUI starts",
  },
  {
    key: "contextSoundEnabled",
    label: "Context sounds",
    description: "Play duck sound when the TUI detects a new context",
  },
];

const ui = {
  daemonOnline: false,
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
    commandPath: "",
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
    options: [],
    sourceNames: [],
    note: "",
  },
};

const runtime = {
  daemonClient: null,
  uc: null,
  uiController: null,
  renderTimer: null,
  contextRefreshTimer: null,
  stop: null,
  seenLogSignatures: new Set(),
  seenLogQueue: [],
  initialLogsSeeded: false,
  syncCount: 0,
  resumeKnownContextIds: new Set(),
  resumeBaselineReady: false,
};

const sound = { startupFile: "", contextFile: "", warnedNonDarwin: false };

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

function runtimeLogsKeep() {
  return Math.max(cfg.uiRecentLimit, 180);
}

function formatTime(value = Date.now()) {
  return new Date(value).toISOString().slice(11, 19);
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

function renderDashboard() {
  runtime.uiController?.refresh();
}

function applyRemoteRuntimeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;

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

  const online = Boolean(snapshot.running);
  if (!online) {
    ui.onlineClients = [];
    return false;
  }

  const host = String(snapshot.host ?? cfg.host);
  const engineerId = String(snapshot.engineerId ?? cfg.engineerId);
  const ts = Number(snapshot.ts ?? Date.now());
  const clientCountRaw = Number(snapshot.clients ?? 1);
  const clientCount = Number.isFinite(clientCountRaw) && clientCountRaw > 0 ? Math.floor(clientCountRaw) : 1;

  ui.onlineClients = Array.from({ length: clientCount }, () => ({
    host,
    engineerId,
    ts,
  }));

  return true;
}

function logSignature(entry) {
  return `${entry.ts}|${entry.level}|${entry.source}|${entry.text}`;
}

function trackSeenLogSignature(signature) {
  if (runtime.seenLogSignatures.has(signature)) return;
  runtime.seenLogSignatures.add(signature);
  runtime.seenLogQueue.push(signature);

  const maxSize = 4000;
  while (runtime.seenLogQueue.length > maxSize) {
    const removed = runtime.seenLogQueue.shift();
    if (removed) runtime.seenLogSignatures.delete(removed);
  }
}

function normalizeLogEntry(item) {
  if (!item || typeof item !== "object") return null;
  if (!item.ts || !item.level) return null;
  return {
    ts: String(item.ts),
    level: String(item.level),
    source: String(item.source ?? ""),
    text: String(item.text ?? ""),
  };
}

function applyRemoteLogsSnapshot(list) {
  const parsed = [];
  for (const raw of list ?? []) {
    const entry = normalizeLogEntry(raw);
    if (!entry) continue;
    parsed.push(entry);
  }

  const newEntries = [];
  for (const entry of parsed) {
    const signature = logSignature(entry);
    if (runtime.initialLogsSeeded && !runtime.seenLogSignatures.has(signature)) {
      newEntries.push(entry);
    }
    trackSeenLogSignature(signature);
  }

  if (!runtime.initialLogsSeeded) {
    runtime.initialLogsSeeded = true;
  }

  ui.recentLogs = parsed.slice(-runtimeLogsKeep());
  return newEntries;
}

function appendRemoteLogEntry(raw) {
  const entry = normalizeLogEntry(raw);
  if (!entry) return null;

  const signature = logSignature(entry);
  if (runtime.seenLogSignatures.has(signature)) return null;

  trackSeenLogSignature(signature);
  ui.recentLogs.push(entry);
  while (ui.recentLogs.length > runtimeLogsKeep()) {
    ui.recentLogs.shift();
  }
  return entry;
}

function setDaemonOfflineNotice(notice = OFFLINE_NOTICE) {
  ui.daemonOnline = false;
  ui.sourceOrder = [];
  ui.sourceStats.clear();
  ui.onlineClients = [];

  if (!ui.resume.notice || ui.resume.notice === OFFLINE_NOTICE || ui.resume.notice.startsWith("Daemon offline")) {
    ui.resume.notice = notice;
  }

  const alreadyHasOffline = ui.recentLogs.some((entry) => entry.text === OFFLINE_NOTICE);
  if (!alreadyHasOffline) {
    ui.recentLogs.push({
      ts: formatTime(),
      level: "warn",
      source: "",
      text: OFFLINE_NOTICE,
    });
  }

  while (ui.recentLogs.length > runtimeLogsKeep()) {
    ui.recentLogs.shift();
  }
}

function clearDaemonOfflineNotice() {
  if (ui.resume.notice === OFFLINE_NOTICE || ui.resume.notice.startsWith("Daemon offline")) {
    ui.resume.notice = "";
  }
}

function applyDaemonConfig(config) {
  if (!config || typeof config !== "object") return;

  if ("bootstrapMode" in config) {
    const normalized = normalizeBootstrapModeWithPrompt(config.bootstrapMode);
    if (normalized) cfg.bootstrapMode = normalized;
  }

  if ("claudeIncludeSubagents" in config) {
    cfg.claudeIncludeSubagents = Boolean(config.claudeIncludeSubagents);
  }
}

async function sendDaemonCommand(type, data = {}, timeoutMs = 8000) {
  if (!runtime.daemonClient || !runtime.daemonClient.isConnected()) {
    return { sent: false, reason: "daemon_offline" };
  }

  const response = await runtime.daemonClient.request(type, data, timeoutMs);
  if (response?.config) {
    applyDaemonConfig(response.config);
  }

  return { sent: true, response };
}

async function requestDaemonConfig() {
  try {
    const result = await sendDaemonCommand(DAEMON_WS_MESSAGE_TYPES.CONFIG_GET, {});
    if (result.sent && result.response?.config) {
      applyDaemonConfig(result.response.config);
      renderDashboard();
    }
  } catch {
    // ignore one-off config request errors
  }
}

function handleDaemonWsMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === DAEMON_WS_MESSAGE_TYPES.SNAPSHOT) {
    const payload = message.data ?? {};
    const wasOnline = ui.daemonOnline;
    ui.daemonOnline = applyRemoteRuntimeSnapshot(payload.state);
    const recentLogs = Array.isArray(payload.recentLogs) ? payload.recentLogs : payload.logs;
    const newLogEntries = applyRemoteLogsSnapshot(recentLogs);
    applyDaemonConfig(payload.config);

    if (!ui.daemonOnline) {
      setDaemonOfflineNotice();
    } else {
      clearDaemonOfflineNotice();
      if (runtime.syncCount > 0 && !wasOnline) {
        ui.resume.notice = "Daemon reconnected.";
      }
    }

    runtime.syncCount += 1;
    renderDashboard();
    return;
  }

  if (message.type === DAEMON_WS_MESSAGE_TYPES.STATE) {
    const wasOnline = ui.daemonOnline;
    ui.daemonOnline = applyRemoteRuntimeSnapshot(message.data);
    if (!ui.daemonOnline) {
      setDaemonOfflineNotice();
    } else {
      clearDaemonOfflineNotice();
      if (runtime.syncCount > 0 && !wasOnline) {
        ui.resume.notice = "Daemon reconnected.";
      }
    }
    runtime.syncCount += 1;
    renderDashboard();
    return;
  }

  if (message.type === DAEMON_WS_MESSAGE_TYPES.LOG) {
    const appended = appendRemoteLogEntry(message.data);
    void appended;
    renderDashboard();
    return;
  }

  if (message.type === DAEMON_WS_MESSAGE_TYPES.CONFIG_STATE) {
    applyDaemonConfig(message.data);
    renderDashboard();
    return;
  }

  if (message.type === DAEMON_WS_MESSAGE_TYPES.CONTEXT_EVENT) {
    // TUI-driven context sound is based on API context list diffs, not daemon events.
    return;
  }
}

function handleDaemonWsStatus(status) {
  if (status?.connected) {
    ui.daemonOnline = true;
    clearDaemonOfflineNotice();
    void requestDaemonConfig();
    renderDashboard();
    return;
  }

  setDaemonOfflineNotice();
  renderDashboard();
}

function handleDaemonWsError(error) {
  if (ui.daemonOnline) return;

  const formatter = runtime.daemonClient?.formatError?.bind(runtime.daemonClient);
  const message = formatter ? formatter(error) : String(error ?? "");

  if (
    message.includes("ENOENT") ||
    message.includes("invalid daemon info file") ||
    message.includes("invalid port file") ||
    message.includes("stale daemon info file")
  ) {
    setDaemonOfflineNotice();
  } else {
    setDaemonOfflineNotice(`${OFFLINE_NOTICE} (${message})`);
  }

  renderDashboard();
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
    // Fall back to current directory.
  }
  return process.cwd();
}

function resumeShellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
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
  runAppleScriptLines(["tell application \"Warp\" to activate", "delay 0.12"]);

  const uri = `warp://action/new_window?path=${encodeURIComponent(process.cwd())}`;
  const opened = runOpenUri(uri);
  if (!opened.ok) return opened;

  runAppleScriptLines(["tell application \"Warp\" to activate", "delay 0.3"]);
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

    let primaryFilePath = "";
    for (const dir of warpLaunchConfigDirs()) {
      try {
        fsSync.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${launchName}.yaml`);
        fsSync.writeFileSync(filePath, yaml, "utf8");
        if (!primaryFilePath) primaryFilePath = filePath;
      } catch {
        // Best effort.
      }
    }

    if (!primaryFilePath) {
      return { ok: false, reason: "could not write Warp launch configuration file" };
    }

    const uri = `warp://launch/${encodeURIComponent(primaryFilePath)}`;
    spawnSync("open", ["-a", "Warp"], { stdio: "ignore" });
    runAppleScriptLines(["tell application \"Warp\" to activate", "delay 0.12"]);

    const opened = runOpenUri(uri);
    if (!opened.ok) return opened;

    runAppleScriptLines(["tell application \"Warp\" to activate", "delay 0.12"]);
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
    const candidates = [ctx?.created_at, ctx?.updated_at, ctx?.metadata?.timestamp, ctx?.metadata?.created_at];
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

async function loadResumeContexts({ silent = false } = {}) {
  if (!runtime.uc || ui.resume.loading) return;
  ui.resume.loading = true;
  if (!silent) {
    ui.resume.error = "";
    ui.resume.notice = "Loading contexts from UltraContext...";
    renderDashboard();
  }

  try {
    const listed = await runtime.uc.get({ limit: Math.max(cfg.resumeContextLimit, 1) });
    const filtered = resumeSortContexts(resumeFilterContexts(resumeDedupeById(listed.data)));
    const nextIds = new Set(filtered.map((ctx) => String(ctx?.id ?? "")).filter(Boolean));
    let newContextCount = 0;
    if (runtime.resumeBaselineReady) {
      for (const id of nextIds) {
        if (!runtime.resumeKnownContextIds.has(id)) newContextCount += 1;
      }
    }
    runtime.resumeKnownContextIds = nextIds;
    if (!runtime.resumeBaselineReady) runtime.resumeBaselineReady = true;

    if (newContextCount > 0) {
      playContextCreatedSound();
    }

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

    if (!silent) {
      const filterLabel = cfg.resumeSourceFilter === "all" ? "all sources" : cfg.resumeSourceFilter;
      ui.resume.notice = `Loaded ${filtered.length} session contexts (${filterLabel}: codex=${sourceCounts.codex}, claude=${sourceCounts.claude}, openclaw=${sourceCounts.openclaw}, other=${sourceCounts.other})`;
      if (filtered.length === 0) {
        ui.resume.notice = `No contexts found for filter=${cfg.resumeSourceFilter}`;
      }
    }
  } catch (error) {
    if (!silent) {
      const details = errorDetails(error);
      ui.resume.error = details.message ?? "Failed loading contexts";
      ui.resume.notice = "";
    }
  } finally {
    ui.resume.loading = false;
    renderDashboard();
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
  let canResumeBySessionId = candidateSessionId ? await hasLocalClaudeSession(candidateSessionId, runCwd) : false;
  let restoredPath = "";
  let restoredError = "";

  if (!canResumeBySessionId || !candidateSessionId) {
    const restored = await materializeClaudeSession({
      sessionId: candidateSessionId,
      cwd: runCwd,
      messages,
    });
    candidateSessionId = restored.sessionId || candidateSessionId;
    canResumeBySessionId = candidateSessionId ? await hasLocalClaudeSession(candidateSessionId, runCwd) : false;
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
    renderDashboard();
    return;
  }

  const selectedSourceAgent = resumeContextSource(context);
  if (!isCodingContextSource(selectedSourceAgent)) {
    ui.resume.notice = `Selected context source=${selectedSourceAgent}. Adapt/Resume is available only for codex/claude contexts.`;
    renderDashboard();
    return;
  }

  ui.resume.syncing = true;
  ui.resumeTargetPicker.active = false;
  ui.resume.error = "";
  ui.resume.notice = `Pulling ${context.id}...`;
  renderDashboard();

  try {
    const detail = await runtime.uc.get(context.id);
    const messages = Array.isArray(detail.data) ? detail.data : [];

    const outDir = path.resolve(cfg.resumeOutputDir);
    await fs.mkdir(outDir, { recursive: true });

    const summaryPath = path.join(outDir, `${context.id}.md`);
    const snapshotPath = path.join(outDir, `${context.id}.json`);
    const commandPath = path.join(outDir, `${context.id}.command.txt`);

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
    const manualTarget = targetAgentOverride === "claude" || targetAgentOverride === "codex" ? targetAgentOverride : "";

    let targetAgent = manualTarget || resumeTargetAgent(sourceAgent);
    if (targetAgent === sourceAgent) {
      targetAgent = resumeTargetAgent(sourceAgent);
    }

    const sessionId = String(context.metadata?.session_id ?? "");
    const resumePlan =
      targetAgent === "claude"
        ? await buildClaudeResumePlan({ sessionId, runCwd, messages })
        : await buildCodexResumePlan({ sessionId, runCwd, messages });

    const command = resumePlan.command;
    await fs.writeFile(commandPath, `${command}\n`, "utf8");

    ui.resume.summaryPath = summaryPath;
    ui.resume.command = command;
    ui.resume.commandPath = commandPath;

    const direction = `${resumeAgentLabel(sourceAgent)} -> ${resumeAgentLabel(targetAgent)}`;

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
  } catch (error) {
    const details = errorDetails(error);
    ui.resume.error = details.message ?? "Resume failed";
    ui.resume.notice = "";
  } finally {
    ui.resume.syncing = false;
    ui.resumeTargetPicker.active = false;
    ui.resumeTargetPicker.source = "";
    ui.resumeTargetPicker.contextId = "";
    ui.resumeTargetPicker.selectedIndex = 0;
    ui.resumeTargetPicker.options = RESUME_TARGET_OPTIONS;
    ui.resumeTargetPicker.recommendedTarget = "";
    renderDashboard();
  }
}

function bootstrapModeConfigLabel(mode) {
  return CONFIG_BOOTSTRAP_MODES.find((entry) => entry.id === mode)?.label ?? mode;
}

function resumeTerminalConfigLabel(mode) {
  const normalized = normalizeResumeTerminal(mode);
  return CONFIG_RESUME_TERMINALS.find((entry) => entry.id === normalized)?.label ?? "Terminal";
}

function serializeConfigPrefs() {
  return {
    soundEnabled: Boolean(cfg.soundEnabled),
    startupSoundEnabled: Boolean(cfg.startupSoundEnabled),
    contextSoundEnabled: Boolean(cfg.contextSoundEnabled),
    bootstrapMode: normalizeBootstrapModeWithPrompt(cfg.bootstrapMode) || "prompt",
    resumeTerminal: normalizeResumeTerminal(cfg.resumeTerminal),
    claudeIncludeSubagents: Boolean(cfg.claudeIncludeSubagents),
    resumeOpenTab: Boolean(cfg.resumeOpenTab),
    startupGreetingFile: String(cfg.startupGreetingFile ?? ""),
    contextCreatedSoundFile: String(cfg.contextCreatedSoundFile ?? ""),
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
    return { loaded: false, missing: false, error };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { loaded: false, missing: false, error };
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
      cfg.bootstrapMode = normalizeBootstrapModeWithPrompt(prefs.bootstrapMode) || "prompt";
      continue;
    }
    if (field === "resumeTerminal") {
      cfg.resumeTerminal = normalizeResumeTerminal(prefs.resumeTerminal);
      continue;
    }
    if (field === "startupGreetingFile") {
      cfg.startupGreetingFile = expandHome(String(prefs.startupGreetingFile ?? cfg.startupGreetingFile));
      continue;
    }
    if (field === "contextCreatedSoundFile") {
      cfg.contextCreatedSoundFile = expandHome(String(prefs.contextCreatedSoundFile ?? cfg.contextCreatedSoundFile));
      continue;
    }
    cfg[field] = Boolean(prefs[field]);
  }
}

async function persistConfigPrefs() {
  let fileSaved = false;

  try {
    await persistConfigPrefsToFile();
    fileSaved = true;
  } catch {
    // ignore
  }

  return { fileSaved };
}

async function resolveSoundFile(filePath, label) {
  if (!filePath) return "";
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      ui.resume.notice = `Configured sound is not a file: ${label}`;
      return "";
    }
    return filePath;
  } catch {
    ui.resume.notice = `Configured sound file not found: ${label}`;
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

function playSoundFile(filePath) {
  if (!cfg.soundEnabled || !filePath) return;

  if (process.platform !== "darwin") {
    if (!sound.warnedNonDarwin) {
      sound.warnedNonDarwin = true;
      ui.resume.notice = "Sound notifications currently support only macOS (afplay).";
      renderDashboard();
    }
    return;
  }

  try {
    const child = spawn("afplay", [filePath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // ignore playback errors
  }
}

function playStartupGreetingSound() {
  if (!cfg.startupSoundEnabled) return;
  playSoundFile(sound.startupFile);
}

function playContextCreatedSound() {
  if (!cfg.contextSoundEnabled) return;
  playSoundFile(sound.contextFile);
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

  const normalizedBootstrapMode = normalizeBootstrapModeWithPrompt(cfg.bootstrapMode) || "prompt";
  const syncItems = [
    {
      key: "bootstrapMode",
      kind: "enum",
      label: "Sync profile",
      description: "Defines bootstrap strategy for next daemon startup/reset.",
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
      description: "Includes Claude subagents in scan (daemon applies on next cycle).",
      value: Boolean(cfg.claudeIncludeSubagents),
      valueLabel: cfg.claudeIncludeSubagents ? "ON" : "OFF",
      blockedByMaster: false,
    },
    {
      key: "bootstrapResetState",
      kind: "action",
      label: "Reset bootstrap state",
      description: "Clears daemon bootstrap state so re-bootstrap can run again.",
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

  try {
    if (item.kind === "action" && item.key === "bootstrapResetState") {
      const daemonResult = await sendDaemonCommand(DAEMON_WS_MESSAGE_TYPES.BOOTSTRAP_RESET, {
        profile: normalizeBootstrapModeWithPrompt(cfg.bootstrapMode) || "prompt",
      });
      cfg.bootstrapReset = true;
      const saved = await persistConfigPrefs();
      if (daemonResult.sent) {
        ui.resume.notice = "Bootstrap state reset on daemon.";
      } else {
        ui.resume.notice = "Daemon offline. Bootstrap reset will apply on next start.";
      }
      if (!saved.fileSaved) {
        ui.resume.notice = "Bootstrap reset requested, but prefs were not persisted.";
      }
      renderDashboard();
      return;
    }

    if (item.kind === "enum" && item.key === "bootstrapMode") {
      const currentIndex = Math.max(CONFIG_BOOTSTRAP_MODES.findIndex((entry) => entry.id === item.value), 0);
      const next = CONFIG_BOOTSTRAP_MODES[(currentIndex + 1) % CONFIG_BOOTSTRAP_MODES.length];
      cfg.bootstrapMode = next.id;
      cfg.bootstrapReset = next.id === "prompt";

      const daemonResult = await sendDaemonCommand(DAEMON_WS_MESSAGE_TYPES.CONFIG_SET, {
        key: "bootstrapMode",
        value: next.id,
      });

      const saved = await persistConfigPrefs();
      if (daemonResult.sent) {
        ui.resume.notice = `Sync profile set: ${next.label} (daemon + file).`;
      } else {
        ui.resume.notice = `Sync profile set: ${next.label} (file only; daemon offline).`;
      }
      if (!saved.fileSaved) {
        ui.resume.notice = `Sync profile set: ${next.label}, but prefs were not persisted.`;
      }
      renderDashboard();
      return;
    }

    if (item.kind === "enum" && item.key === "resumeTerminal") {
      const current = normalizeResumeTerminal(item.value);
      const currentIndex = Math.max(CONFIG_RESUME_TERMINALS.findIndex((entry) => entry.id === current), 0);
      const next = CONFIG_RESUME_TERMINALS[(currentIndex + 1) % CONFIG_RESUME_TERMINALS.length];
      cfg.resumeTerminal = next.id;
      const saved = await persistConfigPrefs();
      ui.resume.notice = `Resume terminal: ${next.label}${saved.fileSaved ? " (saved)" : ""}.`;
      renderDashboard();
      return;
    }

    if (item.kind === "boolean") {
      cfg[item.key] = !cfg[item.key];

      if (item.key === "claudeIncludeSubagents") {
        const daemonResult = await sendDaemonCommand(DAEMON_WS_MESSAGE_TYPES.CONFIG_SET, {
          key: "claudeIncludeSubagents",
          value: cfg.claudeIncludeSubagents,
        });

        const saved = await persistConfigPrefs();
        if (daemonResult.sent) {
          ui.resume.notice = cfg.claudeIncludeSubagents
            ? `Claude subagents: ON (daemon + file${saved.fileSaved ? " saved" : ""}).`
            : `Claude subagents: OFF (daemon + file${saved.fileSaved ? " saved" : ""}).`;
        } else {
          ui.resume.notice = cfg.claudeIncludeSubagents
            ? `Claude subagents: ON (file only; daemon offline).`
            : `Claude subagents: OFF (file only; daemon offline).`;
        }
        renderDashboard();
        return;
      }

      if (
        item.key === "soundEnabled" ||
        item.key === "startupSoundEnabled" ||
        item.key === "contextSoundEnabled"
      ) {
        await prepareSoundConfig();
        const saved = await persistConfigPrefs();
        ui.resume.notice = `${item.label}: ${cfg[item.key] ? "ON" : "OFF"}${saved.fileSaved ? " (file saved)" : ""}.`;
        renderDashboard();
        return;
      }
    }
  } catch (error) {
    const details = errorDetails(error);
    ui.resume.notice = `Failed to apply config: ${details.message}`;
    renderDashboard();
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
  const idx = MENU_TABS.findIndex((tab) => tab.id === ui.selectedTab);
  const current = idx === -1 ? 0 : idx;
  setSelectedTabByIndex(current + delta);
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
      daemonWsHost: cfg.daemonWsHost,
      daemonWsInfoFile: cfg.daemonWsInfoFile,
      pollMs: 0,
      uiRefreshMs: cfg.uiRefreshMs,
      logLevel: "info",
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
    recentLogs: ui.recentLogs.slice(-runtimeLogsKeep()),
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

function validateConfig() {
  if (!cfg.apiKey) {
    throw new Error("Missing ULTRACONTEXT_API_KEY");
  }
}

async function tuiMain() {
  validateConfig();

  if (!process.stdout.isTTY) {
    throw new Error("TUI mode requires a TTY.");
  }

  try {
    const fileLoad = await loadConfigPrefsFromFile();
    if (!fileLoad.loaded) {
      await persistConfigPrefsToFile();
    }
  } catch {
    // ignore config persistence startup issues
  }

  await prepareSoundConfig();
  playStartupGreetingSound();
  setDaemonOfflineNotice();

  const uc = new UltraContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  runtime.uc = uc;

  await uc.get({ limit: 1 });

  runtime.daemonClient = createDaemonWsClient({
    host: cfg.daemonWsHost,
    infoFilePath: cfg.daemonWsInfoFile,
    onMessage: handleDaemonWsMessage,
    onStatus: handleDaemonWsStatus,
    onError: handleDaemonWsError,
  });

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

  runtime.uiController = createInkUiController({
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
        void toggleSelectedConfig();
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

  runtime.uiController.start();
  renderDashboard();
  void loadResumeContexts();
  void runtime.daemonClient.start();

  runtime.renderTimer = setInterval(() => {
    renderDashboard();
  }, Math.max(cfg.uiRefreshMs, 250));
  runtime.renderTimer.unref?.();

  if (cfg.resumeAutoRefreshMs > 0) {
    runtime.contextRefreshTimer = setInterval(() => {
      if (ui.resume.loading || ui.resume.syncing) return;
      void loadResumeContexts({ silent: ui.selectedTab !== "contexts" });
    }, Math.max(cfg.resumeAutoRefreshMs, 1000));
    runtime.contextRefreshTimer.unref?.();
  }

  process.on("SIGINT", () => stop("sigint"));
  process.on("SIGTERM", () => stop("sigterm"));

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (runtime.renderTimer) clearInterval(runtime.renderTimer);
  runtime.renderTimer = null;
  if (runtime.contextRefreshTimer) clearInterval(runtime.contextRefreshTimer);
  runtime.contextRefreshTimer = null;

  runtime.uiController?.stop();
  runtime.uiController = null;

  if (runtime.daemonClient) {
    await runtime.daemonClient.stop();
    runtime.daemonClient = null;
  }

  runtime.stop = null;
  runtime.uc = null;
}

tuiMain().catch(async (error) => {
  if (runtime.renderTimer) clearInterval(runtime.renderTimer);
  runtime.renderTimer = null;
  if (runtime.contextRefreshTimer) clearInterval(runtime.contextRefreshTimer);
  runtime.contextRefreshTimer = null;

  runtime.uiController?.stop();
  runtime.uiController = null;

  if (runtime.daemonClient) {
    try {
      await runtime.daemonClient.stop();
    } catch {
      // ignore close errors
    }
    runtime.daemonClient = null;
  }

  runtime.stop = null;
  runtime.uc = null;

  if (onFatalError) {
    onFatalError(error);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] UltraContext TUI failed: ${message}`);
  process.exit(1);
});

} // end tuiBoot
