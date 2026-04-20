import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoCaptureModeFromBootstrapMode,
  buildOnboardingConfigPatch,
  isPrimaryAgentSourceEnabled,
  matchesConfiguredProjectPath,
  normalizeCaptureAgents,
  normalizeProjectPaths,
} from "../src/onboarding-preferences.mjs";
import { extractProjectPathFromFile } from "../src/utils.mjs";

describe("onboarding capture preferences", () => {
  it("normalizes invalid or empty capture agents back to the default set", () => {
    assert.deepEqual(normalizeCaptureAgents(), ["claude", "codex", "cursor"]);
    assert.deepEqual(normalizeCaptureAgents(["claude", "unknown", "claude"]), ["claude"]);
  });

  it("builds a config patch for a multi-selected agent list and future-only capture", () => {
    const patch = buildOnboardingConfigPatch({
      captureAgents: ["claude", "cursor"],
      projectPaths: ["/Users/test/Code/app", "/Users/test/Code/app/packages/ui"],
      autoCaptureMode: "future_only",
    });

    assert.deepEqual(patch, {
      captureAgents: ["claude", "cursor"],
      projectPaths: ["/Users/test/Code/app", "/Users/test/Code/app/packages/ui"],
      bootstrapMode: "new_only",
    });
  });

  it("empty projectPaths means 'all projects' — no path restriction", () => {
    const patch = buildOnboardingConfigPatch({
      captureAgents: ["claude"],
      projectPaths: [],
      autoCaptureMode: "all",
    });

    assert.deepEqual(patch.projectPaths, []);
  });

  it("matches nested project paths when a project root is configured", () => {
    const projectPaths = normalizeProjectPaths(["/Users/test/Code/app"]);

    assert.equal(matchesConfiguredProjectPath(projectPaths, "/Users/test/Code/app"), true);
    assert.equal(matchesConfiguredProjectPath(projectPaths, "/Users/test/Code/app/packages/sdk"), true);
    assert.equal(matchesConfiguredProjectPath(projectPaths, "/Users/test/Code/other"), false);
    assert.equal(matchesConfiguredProjectPath(projectPaths, ""), false);
  });

  it("only filters the primary onboarding agents", () => {
    assert.equal(isPrimaryAgentSourceEnabled("claude", ["codex"]), false);
    assert.equal(isPrimaryAgentSourceEnabled("codex", ["codex"]), true);
    assert.equal(isPrimaryAgentSourceEnabled("openclaw", ["codex"]), true);
  });

  it("maps daemon bootstrap modes back to onboarding copy", () => {
    assert.equal(autoCaptureModeFromBootstrapMode("new_only"), "future_only");
    assert.equal(autoCaptureModeFromBootstrapMode("all"), "all");
  });
});

describe("project path extraction", () => {
  it("extracts Claude and Cursor project paths from file names", () => {
    assert.equal(
      extractProjectPathFromFile("/Users/test/.claude/projects/-Users-test-Code-app/session.jsonl"),
      "/Users/test/Code/app"
    );
    assert.equal(
      extractProjectPathFromFile("/Users/test/.cursor/projects/-Users-test-Code-app/session.jsonl"),
      "/Users/test/Code/app"
    );
  });
});
