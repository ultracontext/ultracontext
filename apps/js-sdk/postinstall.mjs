#!/usr/bin/env node

// Auto-launch onboarding after global install (skip in CI / non-TTY / local installs)
import { execSync } from "node:child_process";
import process from "node:process";

// skip when triggered by `ultracontext update` to prevent duplicate launch
if (process.env.ULTRACONTEXT_SKIP_POSTINSTALL) process.exit(0);

const isGlobal = process.env.npm_config_global === "true";
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

if (isGlobal && isTTY) {
  try {
    execSync("ultracontext", { stdio: "inherit" });
  } catch { /* user exited or daemon failed — that's fine */ }
}
