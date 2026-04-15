#!/usr/bin/env node

// Post-install: register skills with AI agents via symlinks + launch onboarding
import { execSync } from "node:child_process";
import { mkdirSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import os from "node:os";

// skip when triggered by `ultracontext update`
if (process.env.ULTRACONTEXT_SKIP_POSTINSTALL) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

// ── register skills with AI agents ─────────────────────────────
// symlink SKILL.md so /switch works immediately after install
// pattern: ~/.claude/skills/switch/SKILL.md → <npm-global>/ultracontext/skills/switch/SKILL.md

const skills = [
  { name: "switch", source: join(__dirname, "skills", "switch", "SKILL.md") },
];

// agent skill directories
const agents = [
  join(home, ".claude", "skills"),
  join(home, ".codex", "skills"),
];

for (const skill of skills) {
  for (const agentSkillsDir of agents) {
    const targetDir = join(agentSkillsDir, skill.name);
    const targetFile = join(targetDir, "SKILL.md");

    try {
      mkdirSync(targetDir, { recursive: true });

      // remove existing symlink or file before creating new one
      try { lstatSync(targetFile); unlinkSync(targetFile); } catch { /* doesn't exist */ }

      symlinkSync(skill.source, targetFile);
    } catch { /* read-only fs, CI, etc — silent */ }
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
