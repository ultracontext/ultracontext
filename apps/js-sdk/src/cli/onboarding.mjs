// Interactive onboarding wizard — guides new users through setup
import React from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import { TitledBox } from "@mishieck/ink-titled-box";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { heroArtForWidth } from "@ultracontext/sync/ui/hero-art";
import {
  buildOnboardingConfigPatch,
  ONBOARDING_AGENT_OPTIONS,
  ONBOARDING_AGENT_ALL_OPTION,
  ONBOARDING_CAPTURE_OPTIONS,
} from "@ultracontext/sync/onboarding-preferences";
import { discoverRecentProjects } from "@ultracontext/sync/recent-projects";

// agents list rendered in the wizard — "All" shortcut first, then each agent
const AGENT_ROWS = [ONBOARDING_AGENT_ALL_OPTION, ...ONBOARDING_AGENT_OPTIONS];

// uniform row renderer used by every list step — focus shown by ❯ + bold,
// selection shown by ✓ for multi-select (nothing for single-select since the
// focused row *is* the selection). Keeps the line compact.
function ListRow({ focused, checked, label, multi = false, keyProp }) {
  const arrow = focused ? "\u276F " : "  ";
  const marker = multi ? (checked ? "\u2713 " : "  ") : "";
  const line = `${arrow}${marker}${label}`;
  return React.createElement(
    Text,
    { key: keyProp, color: focused ? "white" : "gray", bold: focused },
    line,
  );
}

// ── config helpers ──────────────────────────────────────────────

// resolve at call time. ULTRACONTEXT_CONFIG_HOME lets you redirect config.json
// without touching HOME, so project inference still reads real session dirs.
function configPaths() {
  const home = process.env.ULTRACONTEXT_CONFIG_HOME
    || process.env.HOME
    || process.env.USERPROFILE
    || "~";
  const dir = path.join(home, ".ultracontext");
  return { dir, path: path.join(dir, "config.json") };
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPaths().path, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const existing = readConfig();
  const { dir, path: file } = configPaths();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...existing, ...patch }, null, 2) + "\n", "utf8");
}

// ── validation ──────────────────────────────────────────────────

function isValidKey(key) {
  return /^uc_(live|test)_/.test(key);
}

// ── step constants ──────────────────────────────────────────────

const STEPS = ["welcome", "mode", "url", "key", "agents", "projects", "capture", "launch", "done"];

const MODE_OPTIONS = [
  { label: "Login (ultracontext.ai)", value: "cloud" },
  { label: "Self-host", value: "selfhost" },
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
  if (step === "agents") return 4;
  if (step === "projects") return 5;
  if (step === "capture") return 6;
  if (step === "launch") return 7;
  return 7;
}

const TOTAL_STEPS = 7;

// ── Onboarding component ────────────────────────────────────────

function Onboarding({ onDone }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? process.stdout.columns ?? 80;

  const [step, setStep] = React.useState("welcome");
  // stack of prior steps — every forward transition pushes, goBack pops
  const [history, setHistory] = React.useState([]);
  const [hosting, setHosting] = React.useState("cloud");
  const [baseUrl, setBaseUrl] = React.useState("https://api.ultracontext.ai");
  const [apiKey, setApiKey] = React.useState("");
  // multi-select agent list — default: watch them all
  const [captureAgents, setCaptureAgents] = React.useState(
    ONBOARDING_AGENT_OPTIONS.map((o) => o.id),
  );
  const [projectPaths, setProjectPaths] = React.useState([]);
  const [autoCaptureMode, setAutoCaptureMode] = React.useState("all");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [keyInput, setKeyInput] = React.useState("");
  const [urlInput, setUrlInput] = React.useState("https://");
  const [error, setError] = React.useState("");

  // discovered projects from Claude/Cursor session dirs — computed once.
  // The picker shows an "All projects" meta row at the top plus one row per
  // inferred project. ALL_PROJECTS is a sentinel that means "no restriction".
  const inferredProjects = React.useMemo(() => discoverRecentProjects(), []);
  const ALL_PROJECTS = "__all__";
  const projectRows = React.useMemo(
    () => [ALL_PROJECTS, ...inferredProjects],
    [inferredProjects],
  );
  // default: "All projects" selected — works even when inference finds nothing
  const [pickedProjects, setPickedProjects] = React.useState([ALL_PROJECTS]);

  // forward transition — remembers where we came from so Esc can walk back
  const pushStep = React.useCallback((nextStep) => {
    setHistory((h) => [...h, step]);
    setStep(nextStep);
    setSelectedIndex(0);
    setError("");
  }, [step]);

  // walk one step back using the history stack
  const goBack = React.useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setStep(h[h.length - 1]);
      setSelectedIndex(0);
      setError("");
      return h.slice(0, -1);
    });
  }, []);

  // save config + env, advance to launch step
  const finish = React.useCallback((finalKey, finalUrl, preferences) => {
    writeConfig({
      apiKey: finalKey,
      baseUrl: finalUrl,
      ...buildOnboardingConfigPatch(preferences),
    });
    process.env.ULTRACONTEXT_API_KEY = finalKey;
    process.env.ULTRACONTEXT_BASE_URL = finalUrl;
    pushStep("launch");
  }, [pushStep]);

  useInput((input, key) => {
    // ctrl+c always exits; esc / left-arrow walk back (esc on welcome exits)
    if (input === "c" && key.ctrl) process.exit(0);
    if (key.escape) {
      if (step === "welcome") process.exit(0);
      goBack();
      return;
    }
    if (key.leftArrow && step !== "welcome") {
      goBack();
      return;
    }

    // ── welcome ──
    if (step === "welcome") {
      if (key.return) pushStep("mode");
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
          pushStep("url");
        } else {
          setBaseUrl("https://api.ultracontext.ai");
          pushStep("key");
        }
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
        pushStep("key");
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
        pushStep("agents");
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

    // ── capture agents (multi-select, first row = "All" shortcut) ──
    if (step === "agents") {
      if (key.upArrow) setSelectedIndex((i) => Math.max(i - 1, 0));
      if (key.downArrow) setSelectedIndex((i) => Math.min(i + 1, AGENT_ROWS.length - 1));

      if (input === " ") {
        setError("");
        const row = AGENT_ROWS[selectedIndex];
        // "All" row toggles every concrete agent at once
        if (row.id === "all") {
          const allIds = ONBOARDING_AGENT_OPTIONS.map((o) => o.id);
          setCaptureAgents((current) => (
            current.length === allIds.length ? [] : allIds
          ));
        } else {
          setCaptureAgents((current) => (
            current.includes(row.id) ? current.filter((x) => x !== row.id) : [...current, row.id]
          ));
        }
        return;
      }

      if (key.return) {
        if (captureAgents.length === 0) {
          setError("Select at least one agent");
          return;
        }
        pushStep("projects");
      }
      return;
    }

    // ── unified project picker: "All projects" + inferred paths ──
    if (step === "projects") {
      if (key.upArrow) setSelectedIndex((i) => Math.max(i - 1, 0));
      if (key.downArrow) setSelectedIndex((i) => Math.min(i + 1, projectRows.length - 1));

      if (input === " ") {
        const row = projectRows[selectedIndex];
        setPickedProjects((current) => {
          // toggling "All projects" — if already on, clear; if off, make it the only pick
          if (row === ALL_PROJECTS) {
            return current.includes(ALL_PROJECTS) ? [] : [ALL_PROJECTS];
          }
          // toggling a specific project — uncheck the "All" meta to avoid ambiguity
          const without = current.filter((p) => p !== ALL_PROJECTS && p !== row);
          return current.includes(row) ? without : [...without, row];
        });
        setError("");
        return;
      }

      if (key.return) {
        if (pickedProjects.length === 0) {
          setError("Select at least one project (or 'All projects')");
          return;
        }
        // "All projects" means no path restriction — otherwise save exactly what was picked
        const paths = pickedProjects.includes(ALL_PROJECTS)
          ? []
          : pickedProjects.slice();
        setProjectPaths(paths);
        pushStep("capture");
      }
      return;
    }

    // ── auto-capture mode ──
    if (step === "capture") {
      if (key.upArrow) setSelectedIndex((i) => Math.max(i - 1, 0));
      if (key.downArrow) setSelectedIndex((i) => Math.min(i + 1, ONBOARDING_CAPTURE_OPTIONS.length - 1));
      if (input === "1") setSelectedIndex(0);
      if (input === "2") setSelectedIndex(1);

      if (key.return || input === " ") {
        const chosen = ONBOARDING_CAPTURE_OPTIONS[selectedIndex].id;
        setAutoCaptureMode(chosen);
        finish(apiKey, baseUrl, {
          captureAgents,
          // empty projectPaths = "all projects" (see buildOnboardingConfigPatch)
          projectPaths,
          autoCaptureMode: chosen,
        });
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
        pushStep("done");
        setTimeout(() => onDone(chosen), 80);
      }
      return;
    }
  });

  // ── render ──

  // figlet sized to the full terminal — picks a smaller font automatically
  // when the terminal is too narrow for ANSI Shadow
  const heroLines = heroArtForWidth(cols - 4);
  const stepNum = stepNumber(step);

  // centered figlet hero — no spinner, no side-by-side layout, no line-wrapping
  const hero = React.createElement(
    Box,
    { flexDirection: "column", alignItems: "center", width: "100%" },
    ...heroLines.map((line, i) =>
      React.createElement(Text, { key: `h${i}`, color: "white", bold: true }, line)
    )
  );

  // step content
  let content = null;

  if (step === "welcome") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Welcome to UltraContext"),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "white" }, "Press Enter to begin setup...")
    );
  }

  if (step === "mode") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "How do you want to connect?"),
      React.createElement(Box, { height: 1 }),
      ...MODE_OPTIONS.map((opt, i) => ListRow({
        keyProp: `m${i}`,
        focused: i === selectedIndex,
        label: opt.label,
      })),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "\u2191\u2193 navigate \u00B7 enter select")
    );
  }

  if (step === "url") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Enter your API base URL:"),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "white", bold: true }, `> ${urlInput}_`),
      error ? React.createElement(Text, { color: "red" }, error) : null,
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "Enter to confirm | Esc to go back")
    );
  }

  if (step === "key") {
    const keyPrompt = hosting === "cloud"
      ? "Paste your API key from ultracontext.ai:"
      : "Enter your API key:";

    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, keyPrompt),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "white", bold: true }, `> ${keyInput}_`),
      error ? React.createElement(Text, { color: "red" }, error) : null,
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "Format: uc_live_... or uc_test_... | Enter to confirm")
    );
  }

  if (step === "agents") {
    // "All" shortcut is checked only when every concrete agent is selected
    const allChecked = ONBOARDING_AGENT_OPTIONS.every((o) => captureAgents.includes(o.id));
    const selectedCount = captureAgents.length;
    const totalCount = ONBOARDING_AGENT_OPTIONS.length;

    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Which agents should UltraContext watch?"),
      React.createElement(Text, { color: "gray" }, `${selectedCount} of ${totalCount} selected`),
      React.createElement(Box, { height: 1 }),
      ...AGENT_ROWS.map((opt, i) => ListRow({
        keyProp: `a${i}`,
        focused: i === selectedIndex,
        checked: opt.id === "all" ? allChecked : captureAgents.includes(opt.id),
        label: opt.label,
        multi: true,
      })),
      error ? React.createElement(Text, { color: "red" }, error) : null,
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "\u2191\u2193 navigate \u00B7 space toggle \u00B7 enter confirm")
    );
  }

  if (step === "projects") {
    const specificsPicked = pickedProjects.filter((p) => p !== ALL_PROJECTS).length;
    const allPicked = pickedProjects.includes(ALL_PROJECTS);
    const summary = allPicked
      ? "all projects"
      : `${specificsPicked} of ${inferredProjects.length} selected`;

    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Which projects should UltraContext auto-capture?"),
      React.createElement(Text, { color: "gray" }, `${summary} \u00B7 their agent sessions will be ingested`),
      React.createElement(Box, { height: 1 }),
      // "All projects" meta row rendered with a friendly label; the sentinel ALL_PROJECTS
      // is hidden from the user but used internally to mean "no restriction"
      ...projectRows.map((row, i) => ListRow({
        keyProp: `pr${i}`,
        focused: i === selectedIndex,
        checked: pickedProjects.includes(row),
        label: row === ALL_PROJECTS ? "All projects (recommended)" : row,
        multi: true,
      })),
      inferredProjects.length === 0
        ? React.createElement(Text, { color: "gray" }, "(no recent Claude/Cursor projects found — all will be captured)")
        : null,
      error ? React.createElement(Text, { color: "red" }, error) : null,
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "\u2191\u2193 navigate \u00B7 space toggle \u00B7 enter confirm")
    );
  }

  if (step === "capture") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Auto-capture mode:"),
      React.createElement(Box, { height: 1 }),
      ...ONBOARDING_CAPTURE_OPTIONS.map((opt, i) => ListRow({
        keyProp: `c${i}`,
        focused: i === selectedIndex,
        label: opt.label,
      })),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "\u2191\u2193 navigate \u00B7 enter select")
    );
  }

  if (step === "launch") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "white", bold: true }, "Launch the TUI dashboard?"),
      React.createElement(Box, { height: 1 }),
      ...LAUNCH_OPTIONS.map((opt, i) => ListRow({
        keyProp: `l${i}`,
        focused: i === selectedIndex,
        label: opt.label,
      })),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "gray" }, "\u2191\u2193 navigate \u00B7 enter select")
    );
  }

  if (step === "done") {
    content = React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, { color: "green", bold: true }, "Setup complete!"),
      React.createElement(Text, { color: "gray" }, `Config saved to ${configPaths().path}`)
    );
  }

  const boxWidth = Math.min(cols - 2, 60);

  return React.createElement(
    Box,
    { flexDirection: "column", alignItems: "center", paddingX: 1, paddingY: 1, width: cols },
    hero,
    React.createElement(Text, { color: "white", bold: true }, "[ Same context, everywhere ]"),
    React.createElement(Box, { height: 1 }),
    React.createElement(
      TitledBox,
      {
        borderStyle: "single",
        titles: ["Setup"],
        titleJustify: "flex-start",
        borderColor: "white",
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
      // universal nav hint — Esc steps back (or quits on welcome), Ctrl+C always quits
      step !== "done" && step !== "welcome"
        ? React.createElement(Text, { color: "gray", dimColor: true }, "← / Esc: back · Ctrl+C: quit")
        : null,
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
