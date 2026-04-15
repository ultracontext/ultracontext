#!/usr/bin/env node

// Post-install: register skills with AI agents + launch onboarding
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import os from "node:os";

// skip when triggered by `ultracontext update`
if (process.env.ULTRACONTEXT_SKIP_POSTINSTALL) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

// ── register skills with AI agents ─────────────────────────────
// copy SKILL.md files so /switch works immediately after install

const skills = [
  { name: "switch", source: join(__dirname, "skills", "switch", "SKILL.md") },
];

for (const skill of skills) {
  // Claude Code
  const claudeDir = join(home, ".claude", "skills", skill.name);
  try {
    mkdirSync(claudeDir, { recursive: true });
    copyFileSync(skill.source, join(claudeDir, "SKILL.md"));
  } catch { /* read-only fs, CI, etc */ }

  // Codex
  const codexDir = join(home, ".codex", "skills", skill.name);
  try {
    mkdirSync(codexDir, { recursive: true });
    copyFileSync(skill.source, join(codexDir, "SKILL.md"));
  } catch { /* optional */ }
}

// ── launch onboarding (global TTY installs only) ───────────────

const isGlobal = process.env.npm_config_global === "true";
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

if (isGlobal && isTTY) {
  try {
    execSync("ultracontext", { stdio: "inherit" });
  } catch { /* user exited or daemon failed — that's fine */ }
}
