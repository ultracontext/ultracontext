#!/usr/bin/env node

// Post-install: register skills with AI agents + launch onboarding
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import os from "node:os";

// skip when triggered by `ultracontext update`
if (process.env.ULTRACONTEXT_SKIP_POSTINSTALL) process.exit(0);

const home = os.homedir();

// ── skill definitions (embedded, single source at build time) ──

const SKILLS = {
  switch: `---
name: switch
description: "Switch AI agent sessions with full context. Powered by UltraContext."
allowed-tools:
  - Bash
---

# /switch — Cross-agent session portability by UltraContext

Switch your current conversation to another AI agent with full context.

## Usage

\`/switch <target>\` where target is: \`codex\` or \`claude\`

Optional flags: \`--last N\` (carry only last N messages), \`--no-launch\` (write session file only)

## Steps

1. Run:
\`\`\`bash
ultracontext switch $ARGUMENTS
\`\`\`

2. If \`ultracontext\` is not installed, tell the user: \`npm i -g ultracontext\` or \`bun add -g ultracontext\`

3. Report: session ID, file path, message count. Codex will open in a new terminal tab automatically.
`,
};

// ── register skills with AI agents ─────────────────────────────

const agents = [
  join(home, ".claude", "skills"),
  join(home, ".codex", "skills"),
];

for (const [name, content] of Object.entries(SKILLS)) {
  for (const agentSkillsDir of agents) {
    const targetDir = join(agentSkillsDir, name);
    const targetFile = join(targetDir, "SKILL.md");
    try {
      mkdirSync(targetDir, { recursive: true });
      try { lstatSync(targetFile); unlinkSync(targetFile); } catch { /* doesn't exist */ }
      writeFileSync(targetFile, content, "utf8");
    } catch { /* read-only fs, CI, etc */ }
  }
}

// ── launch onboarding (global TTY installs only) ───────────────

const isGlobal = process.env.npm_config_global === "true";
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

if (isGlobal && isTTY) {
  try {
    execSync("ultracontext", { stdio: "inherit" });
  } catch { /* user exited or daemon failed — that's fine */ }
}
