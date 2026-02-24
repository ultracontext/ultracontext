#!/usr/bin/env node

// bin wrapper — resolves bundled CLI entry from dist/
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// try bundled dist first, fall back to src for dev
const candidates = [
  path.join(__dirname, "dist", "cli", "entry.js"),
  path.join(__dirname, "dist", "cli", "entry.mjs"),
  path.join(__dirname, "src", "cli", "entry.mjs"),
];

let loaded = false;
for (const candidate of candidates) {
  try {
    await import(`file://${candidate}`);
    loaded = true;
    break;
  } catch {
    // try next
  }
}

if (!loaded) {
  console.error("ultracontext: could not locate CLI entry. Run `pnpm run build` first.");
  process.exit(1);
}
