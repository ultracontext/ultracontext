#!/usr/bin/env node

// Post-install: register plugin skills with AI agents + launch onboarding
import { execSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import os from "node:os";

import { registerSkills } from "./lib/register-skills.mjs";

// skip when triggered by `ultracontext update`
if (process.env.ULTRACONTEXT_SKIP_POSTINSTALL) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

const isGlobal = process.env.npm_config_global === "true";
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

// read package version for managed-marker tracking
function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(join(__dirname, "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

// ── register plugin skills with AI agents (global installs only) ───
// skipped for local/transitive installs so adding ultracontext as a dep can't
// silently mutate ~/.claude. Upgrades replace skills managed by ultracontext
// (tracked via sidecar .ultracontext-version file); user-customized SKILL.md
// (no sidecar) is preserved untouched.
if (isGlobal) {
  registerSkills({
    pluginDir: join(__dirname, "plugin", "skills"),
    agentDirs: [join(home, ".claude", "skills"), join(home, ".codex", "skills")],
    packageVersion: readPackageVersion(),
    logger: (msg) => console.log(`ultracontext: ${msg}`),
  });
}

// ── launch onboarding (global TTY installs only) ───────────────

if (isGlobal && isTTY) {
  try {
    execSync("ultracontext", { stdio: "inherit" });
  } catch { /* user exited or daemon failed — that's fine */ }
}
