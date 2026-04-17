// CLI handler for `ultracontext switch <target>`
import { spawnSync } from "node:child_process";
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

// known terminal program identifiers from TERM_PROGRAM
const TERM_GHOSTTY = "ghostty";
const TERM_ITERM2 = "iTerm.app";
const TERM_TERMINAL_APP = "Apple_Terminal";

// ms to wait after activate / Cmd+T for Ghostty to be ready to receive paste
const GHOSTTY_FOCUS_DELAY_MS = 150;
const GHOSTTY_TAB_OPEN_DELAY_MS = 300;

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

// single-quote wrap + escape any embedded single quotes — safe for POSIX shells
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// escape \ and " for AppleScript double-quoted string literals
function appleScriptEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// run AppleScript via spawnSync — argv form avoids shell-layer interpolation
function runAppleScript(script) {
  const r = spawnSync("osascript", ["-e", script]);
  return r.status === 0;
}

// write a string to the macOS pasteboard via pbcopy (stdin avoids all quoting)
function writePasteboard(value) {
  const r = spawnSync("pbcopy", [], { input: value });
  return r.status === 0;
}

// Ghostty: pasteboard the command, activate Ghostty, open tab, paste, return.
// Pasteboard + Cmd+V avoids the focus-race window where typed keystrokes could
// land in the frontmost app if it's not Ghostty. Activate re-anchors focus
// explicitly before any keystroke is sent, and we tell process "ghostty" for
// every keystroke so System Events routes them to the right process.
function launchGhostty(cmd) {
  if (!writePasteboard(cmd)) return false;
  const focusSec = GHOSTTY_FOCUS_DELAY_MS / 1000;
  const tabSec = GHOSTTY_TAB_OPEN_DELAY_MS / 1000;
  const script = [
    'tell application "Ghostty" to activate',
    `delay ${focusSec}`,
    'tell application "System Events"',
    '  tell process "ghostty"',
    '    keystroke "t" using command down',
    `    delay ${tabSec}`,
    '    keystroke "v" using command down',
    '    key code 36',
    '  end tell',
    'end tell',
  ].join("\n");
  return runAppleScript(script);
}

// iTerm2: create new tab with command
function launchITerm2(cmd) {
  const script = `tell application "iTerm2" to tell current window to create tab with default profile command "${appleScriptEscape(cmd)}"`;
  return runAppleScript(script);
}

// Terminal.app: do script in new tab
function launchTerminalApp(cmd) {
  const script = `tell application "Terminal" to do script "${appleScriptEscape(cmd)}"`;
  return runAppleScript(script);
}

// dispatch table for supported terminals
const TERMINALS = [
  { match: (term) => term.toLowerCase().includes(TERM_GHOSTTY), launch: launchGhostty },
  { match: (term) => term === TERM_ITERM2, launch: launchITerm2 },
  { match: (term) => term === TERM_TERMINAL_APP, launch: launchTerminalApp },
];

// open a command in a new terminal tab (macOS)
function openInNewTab(cmd) {
  if (os.platform() !== "darwin") return false;
  const term = process.env.TERM_PROGRAM ?? "";
  const entry = TERMINALS.find((t) => t.match(term));
  if (!entry) return false;
  try { return entry.launch(cmd); } catch { return false; }
}

async function doSwitch(opts) {
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

  // launch target agent in a new terminal tab — shell-quote cwd so spaces/metachars can't break it
  if (opts.target === "codex") {
    const cmd = `codex fork ${result.sessionId} -C ${shellQuote(result.cwd)}`;
    const launched = openInNewTab(cmd);
    if (!launched) {
      // print on its own line with no ANSI wrapping so copy-paste yields a clean command
      console.log(`\n  ${d}Run in your terminal:${r}`);
      console.log(`  ${cmd}`);
    }
  }

  if (opts.target === "claude") {
    console.log(`\n  Open a new Claude Code session to load this context.`);
  }
}

export async function runSwitch() {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(`${red}x${r} ${err.message}`);
    process.exit(1);
  }

  try {
    await doSwitch(opts);
  } catch (err) {
    console.error(`${red}x${r} ${err.message}`);
    process.exit(1);
  }
}

// exported for tests
export { parseArgs, shellQuote, appleScriptEscape, openInNewTab, writePasteboard };
