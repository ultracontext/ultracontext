// CLI handler for `ultracontext switch <target>`
import { spawn, execSync } from "node:child_process";
import process from "node:process";
import os from "node:os";

// ANSI helpers (match entry.mjs style)
const isTTY = process.stdout.isTTY;
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const r = esc(0);
const b = esc(1);
const d = esc(2);
const green = esc("38;2;80;200;120");
const red = esc("38;2;220;80;80");
const gray = esc("38;5;245");

const VALID_TARGETS = ["codex", "claude"];

// parse switch-specific args from process.argv
function parseArgs() {
  const args = process.argv.slice(3);
  const opts = { target: null, last: null, session: null, noLaunch: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--last") {
      const val = Number(args[++i]);
      if (!val || val <= 0) throw new Error("--last requires a positive number");
      opts.last = val;
      continue;
    }

    if (arg === "--session") {
      opts.session = args[++i];
      if (!opts.session) throw new Error("--session requires a path");
      continue;
    }

    if (arg === "--no-launch") {
      opts.noLaunch = true;
      continue;
    }

    // positional: target
    if (!arg.startsWith("-") && !opts.target) {
      opts.target = arg.toLowerCase();
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.target) throw new Error("Missing target. Usage: ultracontext switch <codex|claude>");
  if (!VALID_TARGETS.includes(opts.target)) {
    throw new Error(`Invalid target: ${opts.target}. Must be: ${VALID_TARGETS.join(", ")}`);
  }

  return opts;
}

// open a command in a new terminal tab (macOS)
function openInNewTab(cmd) {
  if (os.platform() !== "darwin") return false;

  const term = process.env.TERM_PROGRAM ?? "";

  // Ghostty: open new tab via AppleScript keystroke, then type command
  if (term.toLowerCase().includes("ghostty")) {
    try {
      execSync(`osascript -e 'tell application "System Events" to tell process "ghostty" to keystroke "t" using command down'`);
      // small delay for tab to open, then type command
      execSync(`sleep 0.3 && osascript -e 'tell application "System Events" to keystroke "${cmd}\n"'`);
      return true;
    } catch { return false; }
  }

  // iTerm2
  if (term === "iTerm.app") {
    try {
      execSync(`osascript -e 'tell application "iTerm2" to tell current window to create tab with default profile command "${cmd}"'`);
      return true;
    } catch { return false; }
  }

  // Terminal.app
  if (term === "Apple_Terminal") {
    try {
      execSync(`osascript -e 'tell application "Terminal" to do script "${cmd}"'`);
      return true;
    } catch { return false; }
  }

  return false;
}

export async function runSwitch() {
  const opts = parseArgs();

  // auto-detect source (opposite of target)
  const source = opts.target === "codex" ? "claude" : "codex";

  // dynamic import — parsers is a workspace dep
  const { switchSession } = await import("@ultracontext/parsers");

  const result = await switchSession({
    source,
    target: opts.target,
    sessionPath: opts.session,
    cwd: process.cwd(),
    last: opts.last,
  });

  if (!result.written) {
    console.error(`${red}x${r} Switch failed: ${result.reason}`);
    process.exit(1);
  }

  // --no-launch: print JSON for scripting
  if (opts.noLaunch) {
    console.log(JSON.stringify({
      sessionId: result.sessionId,
      filePath: result.filePath,
      messageCount: result.messageCount,
    }));
    return;
  }

  // success output
  console.log(`${green}✓${r} Switched to ${b}${opts.target}${r}`);
  console.log(`  ${d}Session:${r}  ${gray}${result.sessionId}${r}`);
  console.log(`  ${d}File:${r}     ${gray}${result.filePath}${r}`);
  console.log(`  ${d}Messages:${r} ${gray}${result.messageCount}${r}`);

  // launch target agent in a new terminal tab
  if (opts.target === "codex") {
    const cmd = `codex fork ${result.sessionId} -C ${result.cwd}`;
    const launched = openInNewTab(cmd);
    if (!launched) {
      console.log(`\n  Run in your terminal: ${d}${cmd}${r}`);
    }
  }

  if (opts.target === "claude") {
    console.log(`\n  Open a new Claude Code session to load this context.`);
  }
}
