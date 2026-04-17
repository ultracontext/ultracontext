#!/usr/bin/env node

// Post-install: register plugin skills with AI agents + launch onboarding
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import os from "node:os";

// skip when triggered by `ultracontext update`
if (process.env.ULTRACONTEXT_SKIP_POSTINSTALL) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

const isGlobal = process.env.npm_config_global === "true";
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

// skill dir name must be a single path segment — defend against escape via crafted tarball
const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

// ── register plugin skills with AI agents (global installs only) ───
// copy each SKILL.md from plugin/skills/<name>/ to ~/.claude/skills/<name>/ and ~/.codex/skills/<name>/.
// skipped for local/transitive installs so adding ultracontext as a dep can't silently mutate ~/.claude.
if (isGlobal) {
  const pluginSkillsDir = join(__dirname, "plugin", "skills");
  const agents = [
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
  ];

  try {
    const skillDirs = readdirSync(pluginSkillsDir).filter((name) => {
      if (!SAFE_SKILL_NAME.test(name)) return false;
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
          // never clobber an existing SKILL.md — user may have customized it
          try {
            statSync(targetFile);
            console.log(`ultracontext: skipping ${targetFile} (already exists — remove it to re-register)`);
            continue;
          } catch { /* missing, proceed */ }
          copyFileSync(sourceFile, targetFile);
          console.log(`ultracontext: registered skill at ${targetFile}`);
        } catch { /* read-only fs, CI, etc — silent */ }
      }
    }
  } catch { /* plugin dir missing (shouldn't happen in a real install) */ }
}

// ── launch onboarding (global TTY installs only) ───────────────

if (isGlobal && isTTY) {
  try {
    execSync("ultracontext", { stdio: "inherit" });
  } catch { /* user exited or daemon failed — that's fine */ }
}
