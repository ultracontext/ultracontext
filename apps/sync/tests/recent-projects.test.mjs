import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverRecentProjects } from "../src/recent-projects.mjs";

let TMP;
let REAL_PROJECT_A;
let REAL_PROJECT_B;

// build a synthetic HOME with claude + cursor session dirs pointing at real dirs we create.
// we seed each session dir with a single JSONL record carrying the authoritative `cwd`
// so the decoder uses that rather than the lossy dir-name substitution.
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uc-recent-"));
  REAL_PROJECT_A = path.join(TMP, "real-project-a");
  REAL_PROJECT_B = path.join(TMP, "real-project-b");
  fs.mkdirSync(REAL_PROJECT_A, { recursive: true });
  fs.mkdirSync(REAL_PROJECT_B, { recursive: true });

  // claude-style session dir with a jsonl recording the real cwd
  const claudeSession = path.join(TMP, ".claude", "projects", "session-a");
  fs.mkdirSync(claudeSession, { recursive: true });
  fs.writeFileSync(
    path.join(claudeSession, "01.jsonl"),
    JSON.stringify({ cwd: REAL_PROJECT_A, type: "user" }) + "\n",
  );

  // stale dir: points at a path that no longer exists — should be filtered out
  const staleSession = path.join(TMP, ".claude", "projects", "session-stale");
  fs.mkdirSync(staleSession, { recursive: true });
  fs.writeFileSync(
    path.join(staleSession, "01.jsonl"),
    JSON.stringify({ cwd: path.join(TMP, "deleted") }) + "\n",
  );

  // cursor-style session dir
  const cursorSession = path.join(TMP, ".cursor", "projects", "session-b");
  fs.mkdirSync(cursorSession, { recursive: true });
  fs.writeFileSync(
    path.join(cursorSession, "01.jsonl"),
    JSON.stringify({ cwd: REAL_PROJECT_B }) + "\n",
  );
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("discoverRecentProjects", () => {
  it("finds the claude + cursor project dirs that still exist on disk", () => {
    const found = discoverRecentProjects({ home: TMP });
    assert.ok(found.includes(REAL_PROJECT_A), `expected ${REAL_PROJECT_A} in ${JSON.stringify(found)}`);
    assert.ok(found.includes(REAL_PROJECT_B), `expected ${REAL_PROJECT_B} in ${JSON.stringify(found)}`);
  });

  it("filters out session dirs whose recorded cwd no longer exists on disk", () => {
    const found = discoverRecentProjects({ home: TMP });
    assert.ok(!found.some((p) => p.endsWith("/deleted")), `stale path leaked: ${JSON.stringify(found)}`);
  });

  it("returns an empty list when HOME has no session dirs", () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "uc-empty-home-"));
    try {
      assert.deepEqual(discoverRecentProjects({ home: emptyHome }), []);
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
