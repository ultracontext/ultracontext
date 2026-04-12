import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCodexLine } from "../src/agents/codex.mjs";
import { parseClaudeCodeLine } from "../src/agents/claude.mjs";
import { parseOpenClawLine } from "../src/agents/openclaw.mjs";
import { AGENT_COMPAT, isResumePairTested } from "../src/compat.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// helper: parse all lines from a fixture
function parseFixture(fixtureName, parser) {
    const filePath = path.join(__dirname, "fixtures", fixtureName);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    return lines.map((line) => parser({ line, filePath })).filter(Boolean);
}

describe("roundtrip: codex → parse → structured events", () => {
    it("parses all codex-v1 fixture lines into valid events", () => {
        const events = parseFixture("codex-v1.jsonl", parseCodexLine);
        assert.ok(events.length >= 4, `expected >=4 events, got ${events.length}`);

        // every event has required fields
        for (const e of events) {
            assert.ok(e.sessionId, "missing sessionId");
            assert.ok(e.eventType, "missing eventType");
            assert.ok(e.kind, "missing kind");
            assert.ok(e.timestamp, "missing timestamp");
            assert.ok(e.message, "missing message");
        }

        // verify role distribution
        const kinds = events.map((e) => e.kind);
        assert.ok(kinds.includes("user"), "should have user event");
        assert.ok(kinds.includes("assistant"), "should have assistant event");
        assert.ok(kinds.includes("system"), "should have system event");
    });
});

describe("roundtrip: claude → parse → structured events", () => {
    it("parses all claude-v1 fixture lines into valid events", () => {
        const events = parseFixture("claude-v1.jsonl", parseClaudeCodeLine);
        assert.ok(events.length >= 2, `expected >=2 events, got ${events.length}`);

        for (const e of events) {
            assert.ok(e.sessionId, "missing sessionId");
            assert.ok(e.eventType, "missing eventType");
            assert.ok(e.kind, "missing kind");
            assert.ok(e.timestamp, "missing timestamp");
            assert.ok(e.message, "missing message");
        }

        const kinds = events.map((e) => e.kind);
        assert.ok(kinds.includes("user"), "should have user event");
        assert.ok(kinds.includes("assistant"), "should have assistant event");
    });
});

describe("roundtrip: openclaw → parse → structured events", () => {
    it("parses all openclaw-v1 fixture lines into valid events", () => {
        const events = parseFixture("openclaw-v1.jsonl", parseOpenClawLine);
        assert.ok(events.length >= 5, `expected >=5 events, got ${events.length}`);

        for (const e of events) {
            assert.ok(e.sessionId, "missing sessionId");
            assert.ok(e.eventType, "missing eventType");
            assert.ok(e.kind, "missing kind");
            assert.ok(e.timestamp, "missing timestamp");
            assert.ok(e.message, "missing message");
        }

        const kinds = events.map((e) => e.kind);
        assert.ok(kinds.includes("user"), "should have user event");
        assert.ok(kinds.includes("assistant"), "should have assistant event");
        assert.ok(kinds.includes("system"), "should have system event");
    });
});

describe("compat matrix integrity", () => {
    it("every agent has formatVersion and testedAgainst", () => {
        for (const agent of ["claude", "codex", "openclaw"]) {
            const entry = AGENT_COMPAT[agent];
            assert.ok(entry, `missing compat entry for ${agent}`);
            assert.ok(entry.formatVersion, `missing formatVersion for ${agent}`);
            assert.ok(Array.isArray(entry.testedAgainst), `testedAgainst should be array for ${agent}`);
            assert.ok(entry.testedAgainst.length > 0, `testedAgainst should not be empty for ${agent}`);
        }
    });

    it("every resume pair has at least one tested combination", () => {
        for (const [key, entry] of Object.entries(AGENT_COMPAT.resume)) {
            assert.ok(entry.writerVersion, `missing writerVersion for ${key}`);
            assert.ok(entry.testedPairs.length > 0, `no tested pairs for ${key}`);
            for (const pair of entry.testedPairs) {
                assert.ok(pair.source, `missing source in pair for ${key}`);
                assert.ok(pair.target, `missing target in pair for ${key}`);
            }
        }
    });

    it("isResumePairTested returns correct values", () => {
        assert.equal(isResumePairTested("codex", "claude"), true);
        assert.equal(isResumePairTested("claude", "codex"), true);
        assert.equal(isResumePairTested("openclaw", "codex"), false);
    });

    it("every agent has a fixture file", () => {
        for (const agent of ["claude", "codex", "openclaw"]) {
            const fixturePath = path.join(__dirname, "fixtures", `${agent}-v1.jsonl`);
            assert.ok(fs.existsSync(fixturePath), `missing fixture for ${agent}`);
        }
    });
});
