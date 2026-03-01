// Interactive onboarding wizard — guides new users through setup
import React from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import { TitledBox } from "@mishieck/ink-titled-box";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { heroArtForWidth } from "@ultracontext/tui/ui/hero-art";
import { UC_BRAND_BLUE, UC_BLUE_LIGHT } from "@ultracontext/tui/ui/constants";
import Spinner from "@ultracontext/tui/Spinner";

// ── config helpers ──────────────────────────────────────────────

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".ultracontext");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const existing = readConfig();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...patch }, null, 2) + "\n", "utf8");
}

// ── open URL (cross-platform) ───────────────────────────────────

function openUrl(url) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* best effort */ }
}

// ── validation ──────────────────────────────────────────────────

function isValidKey(key) {
  return /^uc_(live|test)_/.test(key);
}

// ── step constants ──────────────────────────────────────────────

const STEPS = ["welcome", "mode", "url", "key", "bootstrap", "launch", "done"];

const MODE_OPTIONS = [
  { label: "Login (ultracontext.ai)", value: "cloud" },
  { label: "Self-host", value: "selfhost" },
];

const BOOTSTRAP_OPTIONS = [
  { label: "New only (recommended)", value: "new_only" },
  { label: "Last 24h", value: "last_24h" },
  { label: "All", value: "all" },
];

const LAUNCH_OPTIONS = [
  { label: "Yes, open the TUI (recommended)", value: true },
  { label: "No, just finish setup", value: false },
];

// ── step number display ─────────────────────────────────────────

function stepNumber(step) {
  if (step === "welcome") return 1;
  if (step === "mode") return 2;
  if (step === "url" || step === "key") return 3;
  if (step === "bootstrap") return 4;
  if (step === "launch") return 5;
  return 5;
}

const TOTAL_STEPS = 5;

// ── Onboarding component ────────────────────────────────────────

function Onboarding({ onDone }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? process.stdout.columns ?? 80;

  const [step, setStep] = React.useState("welcome");
  const [hosting, setHosting] = React.useState("cloud");
  const [baseUrl, setBaseUrl] = React.useState("https://api.ultracontext.ai");
  const [apiKey, setApiKey] = React.useState("");
  const [bootstrapMode, setBootstrapMode] = React.useState("new_only");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [keyInput, setKeyInput] = React.useState("");
  const [urlInput, setUrlInput] = React.useState("https://");
  const [error, setError] = React.useState("");
  const [launchTui, setLaunchTui] = React.useState(false);

  // save config + env, advance to launch step
  const finish = React.useCallback((finalKey, finalUrl, finalBootstrap) => {
    writeConfig({ apiKey: finalKey, baseUrl: finalUrl, bootstrapMode: finalBootstrap });
    process.env.ULTRACONTEXT_API_KEY = finalKey;
    process.env.ULTRACONTEXT_BASE_URL = finalUrl;
    setStep("launch");
    setSelectedIndex(0);
  }, []);

  useInput((input, key) => {
    // escape or ctrl+c exits at any step
    if (key.escape || (input === "c" && key.ctrl)) {
      process.exit(0);
    }

    // ── welcome ──
    if (step === "welcome") {
      if (key.return) {
        setStep("mode");
        setSelectedIndex(0);
      }
      return;
    }

    // ── mode selection ──
    if (step === "mode") {
      if (key.upArrow) setSelectedIndex((i) => Math.max(i - 1, 0));
      if (key.downArrow) setSelectedIndex((i) => Math.min(i + 1, MODE_OPTIONS.length - 1));
      if (input === "1") setSelectedIndex(0);
      if (input === "2") setSelectedIndex(1);

      if (key.return || input === " ") {
        const chosen = MODE_OPTIONS[selectedIndex].value;
        setHosting(chosen);
        if (chosen === "selfhost") {
          setStep("url");
          setUrlInput("https://");
          setError("");
        } else {
          setBaseUrl("https://api.ultracontext.ai");
          openUrl("https://ultracontext.ai");
          setStep("key");
          setKeyInput("");
          setError("");
        }
        setSelectedIndex(0);
      }
      return;
    }

    // ── url input (self-host) ──
    if (step === "url") {
      if (key.return) {
        const trimmed = urlInput.trim();
        if (!trimmed || trimmed === "https://") {
          setError("Enter a valid base URL");
          return;
        }
        setBaseUrl(trimmed);
        setStep("key");
        setKeyInput("");
        setError("");
        return;
      }
      if (key.backspace || key.delete) {
        setUrlInput((v) => v.slice(0, -1));
        setError("");
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setUrlInput((v) => v + input);
        setError("");
      }
      return;
    }

    // ── key input ──
    if (step === "key") {
      if (key.return) {
        const trimmed = keyInput.trim();
        if (!trimmed) {
          setError("Enter your API key");
          return;
        }
        if (!isValidKey(trimmed)) {
          setError("Key must start with uc_live_ or uc_test_");
          return;
        }
        setApiKey(trimmed);
        setStep("bootstrap");
        setSelectedIndex(0);
        setError("");
        return;
      }
      if (key.backspace || key.delete) {
        setKeyInput((v) => v.slice(0, -1));
        setError("");
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setKeyInput((v) => v + input);
        setError("");
      }
      return;
    }

    // ── bootstrap mode ──
    if (step === "bootstrap") {
      if (key.upArrow) setSelectedIndex((i) => Math.max(i - 1, 0));
      if (key.downArrow) setSelectedIndex((i) => Math.min(i + 1, BOOTSTRAP_OPTIONS.length - 1));
      if (input === "1") setSelectedIndex(0);
      if (input === "2") setSelectedIndex(1);
      if (input === "3") setSelectedIndex(2);

      if (key.return || input === " ") {
        const chosen = BOOTSTRAP_OPTIONS[selectedIndex].value;
        setBootstrapMode(chosen);
        finish(apiKey, baseUrl, chosen);
      }
      return;
    }

    // ── launch TUI? ──
    if (step === "launch") {
      if (key.upArrow) setSelectedIndex((i) => Math.max(i - 1, 0));
      if (key.downArrow) setSelectedIndex((i) => Math.min(i + 1, LAUNCH_OPTIONS.length - 1));
      if (input === "1") setSelectedIndex(0);
      if (input === "2") setSelectedIndex(1);

      if (key.return || input === " ") {
        const chosen = LAUNCH_OPTIONS[selectedIndex].value;
        setLaunchTui(chosen);
        setStep("done");
        setTimeout(() => onDone(chosen), 80);
      }
      return;
    }
  });

  // ── render ──

  const heroLines = heroArtForWidth(cols - 4);
  const stepNum = stepNumber(step);

  // hero art — 3d spinner + figlet on all steps
  const hero = React.createElement(
    Box,
    { flexDirection: "row", justifyContent: "center", width: "100%" },
    React.createElement(Spinner, { color: UC_BLUE_LIGHT }),
    React.createElement(Box, { width: 3 }),
    React.createElement(
      Box,
      { flexDirection: "column", justifyContent: "center" },
      ...heroLines.map((line, i) =>
        React.createElement(Text, { key: `h${i}`, color: "white", bold: true }, line)
      )
    )
  );

  // step content
  let content = null;

  if (step === "welcome") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Welcome to UltraContext"),
      React.createElement(Text, { color: "gray" }, "Context engineering for AI coding agents."),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: UC_BLUE_LIGHT }, "Press Enter to begin setup...")
    );
  }

  if (step === "mode") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "How do you want to connect?"),
      React.createElement(Box, { height: 1 }),
      ...MODE_OPTIONS.map((opt, i) => {
        const sel = i === selectedIndex;
        return React.createElement(
          Text,
          { key: `m${i}`, color: sel ? UC_BLUE_LIGHT : "white" },
          sel ? "[\u2022]" : "[ ]",
          ` ${i + 1}. ${opt.label}`
        );
      }),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "Navigate: up/down, 1/2 | Confirm: Enter")
    );
  }

  if (step === "url") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Enter your API base URL:"),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: UC_BLUE_LIGHT }, `> ${urlInput}_`),
      error ? React.createElement(Text, { color: "red" }, error) : null,
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "Enter to confirm | Esc to quit")
    );
  }

  if (step === "key") {
    const keyPrompt = hosting === "cloud"
      ? "Paste your API key (browser opened for you):"
      : "Enter your API key:";

    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, keyPrompt),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: UC_BLUE_LIGHT }, `> ${keyInput}_`),
      error ? React.createElement(Text, { color: "red" }, error) : null,
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "Format: uc_live_... or uc_test_... | Enter to confirm")
    );
  }

  if (step === "bootstrap") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Initial sync mode:"),
      React.createElement(Box, { height: 1 }),
      ...BOOTSTRAP_OPTIONS.map((opt, i) => {
        const sel = i === selectedIndex;
        return React.createElement(
          Text,
          { key: `b${i}`, color: sel ? UC_BLUE_LIGHT : "white" },
          sel ? "[\u2022]" : "[ ]",
          ` ${i + 1}. ${opt.label}`
        );
      }),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "Navigate: up/down, 1/2/3 | Confirm: Enter")
    );
  }

  if (step === "launch") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Launch the TUI dashboard?"),
      React.createElement(Box, { height: 1 }),
      ...LAUNCH_OPTIONS.map((opt, i) => {
        const sel = i === selectedIndex;
        return React.createElement(
          Text,
          { key: `l${i}`, color: sel ? UC_BLUE_LIGHT : "white" },
          sel ? "[\u2022]" : "[ ]",
          ` ${i + 1}. ${opt.label}`
        );
      }),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "Navigate: up/down, 1/2 | Confirm: Enter")
    );
  }

  if (step === "done") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "green", bold: true }, "Setup complete!"),
      React.createElement(Text, { color: "gray" }, `Config saved to ${CONFIG_PATH}`)
    );
  }

  const boxWidth = Math.min(cols - 2, 60);

  return React.createElement(
    Box,
    { flexDirection: "column", alignItems: "center", paddingX: 1, paddingY: 1, width: cols },
    hero,
    React.createElement(Text, { color: UC_BLUE_LIGHT, bold: true }, "[ The Context Hub for AI Agents ]"),
    React.createElement(Box, { height: 1 }),
    React.createElement(
      TitledBox,
      {
        borderStyle: "single",
        titles: ["Setup"],
        titleJustify: "flex-start",
        borderColor: UC_BRAND_BLUE,
        flexDirection: "column",
        paddingX: 2,
        paddingY: 1,
        width: boxWidth,
      },
      React.createElement(
        Text,
        { color: "gray", dimColor: true },
        step !== "done" ? `Step ${stepNum} of ${TOTAL_STEPS}` : "Done"
      ),
      React.createElement(Box, { height: 1 }),
      content
    )
  );
}

// ── public entry point ──────────────────────────────────────────

export function onboard() {
  return new Promise((resolve) => {
    const app = render(
      React.createElement(Onboarding, {
        onDone: (wantsTui) => {
          app.unmount();
          resolve({ launchTui: Boolean(wantsTui) });
        },
      }),
      { exitOnCtrlC: false }
    );
  });
}
