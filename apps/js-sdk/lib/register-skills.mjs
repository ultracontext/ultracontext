// Register plugin skills into agent skill dirs (~/.claude/skills, ~/.codex/skills).
// Exported as a pure function so it's testable without running npm install.
//
// Contract:
// - Walk pluginDir/<name>/SKILL.md, validate <name> against SAFE_SKILL_NAME.
// - For each agent dir, for each skill:
//   - If target SKILL.md is a symlink → skip (don't follow, could escape into user files).
//   - If target exists as regular file:
//     - If sidecar .ultracontext-version present with matching version → no-op (already up-to-date).
//     - If sidecar present but version differs → upgrade (replace + bump sidecar).
//     - If sidecar missing → preserve (assume user customization).
//   - If target missing → create with COPYFILE_EXCL + write sidecar.
// - All fs errors are swallowed per-agent-dir so CI / read-only installs don't fail npm.

import fs from "node:fs";
import { join } from "node:path";

// skill dir name must be a single path segment — defend against escape via crafted tarball
const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

const VERSION_MARKER = ".ultracontext-version";

// read version marker or return null if absent / unreadable
function readMarker(markerFile) {
  try {
    return fs.readFileSync(markerFile, "utf8").trim();
  } catch { return null; }
}

// attempt to register one skill into one agent dir; swallow errors
function registerOne({ sourceFile, targetDir, targetFile, markerFile, packageVersion, logger }) {
  try {
    fs.mkdirSync(targetDir, { recursive: true });

    // lstat (not stat) so symlinks are detected and never followed
    let existing = null;
    try { existing = fs.lstatSync(targetFile); } catch { /* missing */ }

    if (existing) {
      if (existing.isSymbolicLink()) {
        logger?.(`skipping ${targetFile} (symlink — preserving)`);
        return;
      }
      const marker = readMarker(markerFile);
      if (marker === null) {
        logger?.(`skipping ${targetFile} (no marker — preserving user edit)`);
        return;
      }
      if (marker === packageVersion) {
        // already at current version — no-op
        return;
      }
      // managed-but-stale: remove + re-copy
      fs.unlinkSync(targetFile);
      logger?.(`upgrading ${targetFile} from v${marker} to v${packageVersion}`);
    }

    // atomic create — fails loudly on EEXIST so we never clobber by accident
    fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(markerFile, packageVersion);
    if (!existing) logger?.(`registered ${targetFile} (v${packageVersion})`);
  } catch (err) {
    // read-only fs, EACCES in CI, tarball race — never fail the install
    logger?.(`skip ${targetFile} (${err?.code || "error"})`);
  }
}

export function registerSkills({ pluginDir, agentDirs, packageVersion, logger }) {
  let skillNames;
  try {
    skillNames = fs.readdirSync(pluginDir).filter((name) => {
      if (!SAFE_SKILL_NAME.test(name)) return false;
      try { return fs.statSync(join(pluginDir, name)).isDirectory(); } catch { return false; }
    });
  } catch {
    // plugin dir missing (shouldn't happen in a real install)
    return;
  }

  for (const skillName of skillNames) {
    const sourceFile = join(pluginDir, skillName, "SKILL.md");
    try { fs.statSync(sourceFile); } catch { continue; }

    for (const agentSkillsDir of agentDirs) {
      const targetDir = join(agentSkillsDir, skillName);
      registerOne({
        sourceFile,
        targetDir,
        targetFile: join(targetDir, "SKILL.md"),
        markerFile: join(targetDir, VERSION_MARKER),
        packageVersion,
        logger,
      });
    }
  }
}
