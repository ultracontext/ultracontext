// e2e test — spawns the real CLI (`ultracontext config`) in a pseudo-tty,
// drives it with real keystrokes, waits for each wizard step to render,
// then asserts the final config.json matches expectations.

import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pty from "node-pty";

// ── keystroke sequences the wizard expects ───────────────────────

const KEY = {
  enter: "\r",
  up: "\x1B[A",
  down: "\x1B[B",
  right: "\x1B[C",
  left: "\x1B[D",
  esc: "\x1B",
  backspace: "\x7f",
};

// ── paths ────────────────────────────────────────────────────────

// run src entry directly so edits are exercised without rebuilding dist
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(HERE, "..", "src", "cli", "entry.mjs");

// ── tmp HOME per test run — isolates config.json ─────────────────

let HOME_DIR;

before(() => {
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uc-onboarding-e2e-"));
});

after(() => {
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  // reset config AND any seeded agent session dirs between scenarios so
  // project inference starts fresh each run
  for (const sub of [".ultracontext", ".claude", ".cursor"]) {
    try { fs.rmSync(path.join(HOME_DIR, sub), { recursive: true, force: true }); } catch {}
  }
});

// ── pty driver ───────────────────────────────────────────────────

// spawn the wizard and return helpers to drive it
function spawnWizard() {
  const proc = pty.spawn(process.execPath, [CLI_ENTRY, "config"], {
    name: "xterm-color",
    cols: 120,
    rows: 40,
    cwd: path.dirname(CLI_ENTRY),
    env: {
      ...process.env,
      HOME: HOME_DIR,
    },
  });

  let buffer = "";
  let exitCode = null;
  let exitSignal = null;

  proc.onData((data) => { buffer += data; });
  proc.onExit(({ exitCode: code, signal }) => { exitCode = code; exitSignal = signal; });

  // wait until `re` appears in the output since the last mark
  async function waitFor(re, { timeoutMs = 4000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (re.test(buffer)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${re} — last buffer tail:\n${buffer.slice(-500)}`);
  }

  // send keys with a small inter-key gap so Ink state updates flush
  async function send(...keys) {
    for (const k of keys) {
      proc.write(k);
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  // clear buffer — useful between steps so waitFor targets new output
  function clearBuffer() { buffer = ""; }

  function waitForExit(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      (function poll() {
        if (exitCode !== null || exitSignal) return resolve({ code: exitCode, signal: exitSignal });
        if (Date.now() > deadline) return reject(new Error(`wizard did not exit within ${timeoutMs}ms`));
        setTimeout(poll, 25);
      })();
    });
  }

  function kill() { try { proc.kill(); } catch {} }

  return { proc, buffer: () => buffer, waitFor, send, clearBuffer, waitForExit, kill };
}

// ── helpers ──────────────────────────────────────────────────────

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(HOME_DIR, ".ultracontext", "config.json"), "utf8"));
}

// type a string char-by-char
function chars(str) { return [...str]; }

// ── tests ────────────────────────────────────────────────────────

describe("onboarding wizard e2e (real CLI, real pty)", () => {
  it("self-host + all defaults writes full-capture config", async () => {
    const w = spawnWizard();

    try {
      // welcome
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);

      // mode — pick self-host (index 1)
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.down, KEY.enter);

      // url — field is pre-filled with "https://" so append the rest
      await w.waitFor(/Enter your API base URL:/);
      await w.send(...chars("api.example.com"), KEY.enter);

      // key
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("uc_test_abcdef123456"), KEY.enter);

      // agents — default "all"
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.enter);

      // projects — default "all"
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);

      // capture mode — default "all"
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);

      // launch prompt — pick "No" to avoid spawning the TUI
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "uc_test_abcdef123456");
    assert.equal(cfg.baseUrl, "https://api.example.com");
    assert.deepEqual(cfg.captureAgents, ["claude", "codex", "cursor"]);
    assert.deepEqual(cfg.projectPaths, []);
    assert.equal(cfg.bootstrapMode, "all");
  });

  it("cloud + codex-only + one specific project + future-only", async () => {
    // seed an inferred project so the picker has something real to select
    const realProject = path.join(HOME_DIR, "Code", "demo-cloud");
    fs.mkdirSync(realProject, { recursive: true });
    const session = path.join(HOME_DIR, ".claude", "projects", "demo-session");
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(
      path.join(session, "01.jsonl"),
      JSON.stringify({ cwd: realProject, type: "user" }) + "\n",
    );

    const w = spawnWizard();
    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);

      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);

      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_live_cloudkey99"), KEY.enter);

      // agents — untoggle Claude and Cursor, leave only Codex
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.down, " ");
      await w.send(KEY.down, KEY.down, " ", KEY.enter);

      // projects — focus starts on "All projects". Move down to the specific one,
      // space toggles it (and auto-unchecks "All"), enter confirms.
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.down, " ", KEY.enter);

      // capture mode — future_only (row 2)
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.down, KEY.enter);

      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);
      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "uc_live_cloudkey99");
    assert.equal(cfg.baseUrl, "https://api.ultracontext.ai");
    assert.deepEqual(cfg.captureAgents, ["codex"]);
    assert.deepEqual(cfg.projectPaths, [realProject]);
    assert.equal(cfg.bootstrapMode, "new_only");
  });

  it("rejects malformed api key then accepts a valid one", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);

      // mode — cloud
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);

      // key — bad input
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("nope-bad-key"), KEY.enter);

      // wizard shows error text and stays on key step
      await w.waitFor(/Key must start with uc_live_ or uc_test_/);

      // clear the bad input and type a valid one
      await w.send(...Array(12).fill(KEY.backspace));
      await w.send(...chars("uc_test_ok"), KEY.enter);

      // advance through remaining steps using defaults
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "uc_test_ok");
  });

  it("Esc walks back and lets user change the URL before finishing", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);

      // pick self-host, type a wrong URL, advance to key step
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitFor(/Enter your API base URL:/);
      await w.send(...chars("wrong.example"), KEY.enter);

      await w.waitFor(/Enter your API key:/);
      // change our mind — esc back to URL step and rewrite it
      await w.send(KEY.esc);
      await w.waitFor(/Enter your API base URL:/);
      // wipe previous "https://wrong.example" (22 chars) and type the correct URL
      await w.send(...Array(22).fill(KEY.backspace));
      await w.send(...chars("https://api.corrected.com"), KEY.enter);

      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("uc_test_backnav"), KEY.enter);

      // default everything else
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.baseUrl, "https://api.corrected.com");
    assert.equal(cfg.apiKey, "uc_test_backnav");
  });

  it("agents multi-select — untoggle one, keep the other two", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);

      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);

      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_test_multi"), KEY.enter);

      // default is all three checked — move focus to Cursor (row 4) and untoggle
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.down, KEY.down, KEY.down, " ", KEY.enter);

      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["claude", "codex"]);
  });

  it("agents multi-select — refuses to advance with zero selected", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_test_zero"), KEY.enter);

      // focus starts on "All" — space toggles everything off, then try to advance → error
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(" ", KEY.enter);
      await w.waitFor(/Select at least one agent/);

      // move focus to Codex (row 3), toggle on, confirm
      await w.send(KEY.down, KEY.down, " ", KEY.enter);
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["codex"]);
  });

  it("left-arrow steps back just like Esc", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);

      // mode → key, then left-arrow back to mode
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(KEY.left);
      await w.waitFor(/How do you want to connect\?/);

      // pick self-host now, finish normally
      await w.send(KEY.down, KEY.enter);
      await w.waitFor(/Enter your API base URL:/);
      await w.send(...chars("api.left.test"), KEY.enter);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("uc_test_left"), KEY.enter);
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.baseUrl, "https://api.left.test");
    assert.equal(cfg.apiKey, "uc_test_left");
  });

  it("'All' shortcut (row 1) toggles every agent at once", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_test_all"), KEY.enter);

      // focus on "All" row. space clears all, space again re-checks all. enter confirms.
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(" ", " ", KEY.enter);

      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["claude", "codex", "cursor"]);
  });

  it("preserves typed API key when stepping back to mode and forward again", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);

      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter); // cloud

      // type partial key, then go back to mode, then forward — key must still be there
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_test_pers"));
      await w.send(KEY.left);                      // back → mode
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);                     // forward → key (same cloud mode)
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      // append the rest of the key to prove what we typed earlier still exists
      await w.send(...chars("isted"), KEY.enter);

      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "uc_test_persisted");
  });

  it("arrow keys in the agents step don't silently untoggle rows", async () => {
    const w = spawnWizard();

    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_test_arrows"), KEY.enter);

      // move cursor around with arrow keys — should NOT change any selection
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.down, KEY.down, KEY.down, KEY.up, KEY.up, KEY.up, KEY.enter);

      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    // defaults preserved — all three agents still checked
    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["claude", "codex", "cursor"]);
  });

  it("picker shows inferred projects alongside the 'All projects' row", async () => {
    // seed the tmp HOME with two fake claude sessions recording real cwds
    const p1 = path.join(HOME_DIR, "Code", "alpha");
    const p2 = path.join(HOME_DIR, "Code", "beta");
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });
    fs.mkdirSync(path.join(HOME_DIR, ".claude", "projects", "s1"), { recursive: true });
    fs.mkdirSync(path.join(HOME_DIR, ".claude", "projects", "s2"), { recursive: true });
    fs.writeFileSync(
      path.join(HOME_DIR, ".claude", "projects", "s1", "01.jsonl"),
      JSON.stringify({ cwd: p1 }) + "\n",
    );
    fs.writeFileSync(
      path.join(HOME_DIR, ".claude", "projects", "s2", "01.jsonl"),
      JSON.stringify({ cwd: p2 }) + "\n",
    );

    const w = spawnWizard();
    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_test_pick"), KEY.enter);
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.enter);

      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      // both inferred rows rendered — match just a trailing chunk since long paths
      // may get truncated by ink when the 60-col TitledBox runs out of room
      await w.waitFor(/Code\/alpha|Code\/beta/);
      // focus starts on "All projects" (default-checked). Move to row 2, toggle
      // the specific project (auto-unchecks "All"), then confirm.
      await w.send(KEY.down, " ", KEY.enter);

      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);
      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    // exactly one path selected — either alpha or beta depending on recency order
    assert.equal(cfg.projectPaths.length, 1);
    assert.ok([p1, p2].includes(cfg.projectPaths[0]));
  });

  it("accepts 'All projects' even when nothing could be inferred", async () => {
    const w = spawnWizard();
    try {
      await w.waitFor(/Welcome to UltraContext/);
      await w.send(KEY.enter);
      await w.waitFor(/How do you want to connect\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Paste your API key from ultracontext\.ai:/);
      await w.send(...chars("uc_test_all"), KEY.enter);
      await w.waitFor(/Which agents should UltraContext watch\?/);
      await w.send(KEY.enter);

      // no .claude/projects seeded → picker only shows "All projects" row
      await w.waitFor(/Which projects should UltraContext auto-capture\?/);
      await w.waitFor(/no recent Claude\/Cursor projects found/);
      await w.send(KEY.enter);

      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);
      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.projectPaths, []);
  });
});
