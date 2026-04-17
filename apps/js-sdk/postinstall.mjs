#!/usr/bin/env node

// Post-install: register plugin skills with AI agents + launch onboarding
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync, readdirSync, lstatSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import os from "node:os";

// skip when triggered by `ultracontext update`
if (process.env.ULTRACONTEXT_SKIP_POSTINSTALL) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

// ── register plugin skills with AI agents ──────────────────────
// copy each SKILL.md from plugin/skills/<name>/ to ~/.claude/skills/<name>/ and ~/.codex/skills/<name>/

const pluginSkillsDir = join(__dirname, "plugin", "skills");
const agents = [
  join(home, ".claude", "skills"),
  join(home, ".codex", "skills"),
];

try {
  const skillDirs = readdirSync(pluginSkillsDir).filter((name) => {
    try { return statSync(join(pluginSkillsDir, name)).isDirectory(); } catch { return false; }
  });

  for (const skillName of skillDirs) {
    const sourceFile = join(pluginSkillsDir, skillName, "SKILL.md");
    try { statSync(sourceFile); } catch { continue; }

    for (const agentSkillsDir of agents) {
      const targetDir = join(agentSkillsDir, skillName);
      const targetFile = join(targetDir, "SKILL.md");
      try {
        mkdirSync(targetDir, { recursive: true });
        try { lstatSync(targetFile); unlinkSync(targetFile); } catch { /* doesn't exist */ }
        copyFileSync(sourceFile, targetFile);
      } catch { /* read-only fs, CI, etc — silent */ }
    }
  }
} catch { /* plugin dir missing (shouldn't happen in a real install) */ }

// ── launch onboarding (global TTY installs only) ───────────────

const isGlobal = process.env.npm_config_global === "true";
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

if (isGlobal && isTTY) {
  try {
    execSync("ultracontext", { stdio: "inherit" });
  } catch { /* user exited or daemon failed — that's fine */ }
}
