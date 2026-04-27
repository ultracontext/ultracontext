#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const nativeDir = process.env.ULTRACONTEXT_NATIVE_DIR || join(packageRoot, "npm", "native");
const binary = join(nativeDir, process.platform === "win32" ? "ultracontext.exe" : "ultracontext");

if (!existsSync(binary)) {
  console.error("UltraContext native binary is missing. Reinstall with: npm install -g ultracontext");
  process.exit(1);
}

const pathKey = process.platform === "win32" ? "Path" : "PATH";
const env = {
  ...process.env,
  ULTRACONTEXT_INSTALLER: "npm",
  ULTRACONTEXT_INSTALL_BIN: binary,
  [pathKey]: `${nativeDir}${process.platform === "win32" ? ";" : ":"}${process.env[pathKey] || ""}`
};

const result = spawnSync(binary, process.argv.slice(2), {
  stdio: "inherit",
  env
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
