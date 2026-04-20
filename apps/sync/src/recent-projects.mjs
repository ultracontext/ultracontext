// Discover recent project paths by peeking into Claude Code + Cursor session dirs.
// The directory-name encoding used by those agents is lossy (dashes in real paths
// collide with the `/` → `-` substitution), so we prefer the authoritative `cwd`
// recorded inside the session JSONL files and only fall back to the decoded dir name.

import fs from "node:fs";
import path from "node:path";

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// find the first .jsonl file in a directory, most-recently modified first
function firstJsonlFile(dir) {
  const files = safeReaddir(dir)
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const full = path.join(dir, e.name);
      const stat = safeStat(full);
      return { full, mtime: stat ? stat.mtimeMs : 0 };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full ?? null;
}

// read up to `maxLines` from a jsonl file and return the first `cwd` value we can find
function readCwdFromJsonl(file, maxLines = 10) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n", maxLines + 1).slice(0, maxLines);
    for (const line of lines) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
        // codex session_meta shape: { payload: { cwd } }
        if (obj.payload && typeof obj.payload.cwd === "string" && obj.payload.cwd) return obj.payload.cwd;
      } catch { /* skip malformed line */ }
    }
  } catch { /* file unreadable */ }
  return null;
}

// lossy fallback — "/Users/fabio-Code-foo" → ambiguous, but fine for simple paths
function decodeDirNameWithLeadingSlash(name) {
  return "/" + name.replace(/^-/, "").replace(/-/g, "/");
}

function decodeCursorDirName(name) {
  return "/" + name.replace(/-/g, "/");
}

// collect one candidate row per session dir — prefer cwd from inside the file,
// fall back to a best-effort decode of the directory name
function collect(rootDir, decode) {
  return safeReaddir(rootDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(rootDir, entry.name);
      const stat = safeStat(dir);
      const mtime = stat ? stat.mtimeMs : 0;

      const jsonl = firstJsonlFile(dir);
      const cwdFromFile = jsonl ? readCwdFromJsonl(jsonl) : null;
      const projectPath = cwdFromFile || decode(entry.name);

      return { path: projectPath, mtime };
    });
}

// returns absolute project paths, most-recently-used first, deduped,
// filtered to only those that still exist on disk
export function discoverRecentProjects({ home = process.env.HOME } = {}) {
  if (!home) return [];

  const candidates = [
    ...collect(path.join(home, ".claude", "projects"), decodeDirNameWithLeadingSlash),
    ...collect(path.join(home, ".cursor", "projects"), decodeCursorDirName),
  ];

  const best = new Map();
  for (const c of candidates) {
    if (!c.path || !c.path.startsWith("/")) continue;
    const stat = safeStat(c.path);
    if (!stat || !stat.isDirectory()) continue;
    const prev = best.get(c.path);
    if (!prev || prev.mtime < c.mtime) best.set(c.path, c);
  }

  return [...best.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .map((c) => c.path);
}
