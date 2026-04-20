import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseClaudeCodeLine } from "../src/agents/claude.mjs";
import { parseCodexLine } from "../src/agents/codex.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// helper: parse all lines and return { parsed, skipped, errors }
function parseAllLines(fixtureName, parser) {
    const filePath = path.join(__dirname, "fixtures", fixtureName);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    const parsed = [];
    const skipped = [];

    for (const line of lines) {
        const result = parser({ line, filePath });
        if (result) parsed.push(result);
        else skipped.push(line);
    }

    return { parsed, skipped, total: lines.length };
}

describe("real sessions: claude-v1-real.jsonl", () => {
    const { parsed, skipped, total } = parseAllLines("claude-v1-real.jsonl", parseClaudeCodeLine);

    it("parses 100% of lines", () => {
        assert.equal(parsed.length, total, `expected 100% parse rate, got ${parsed.length}/${total}`);
    });

    it("every parsed event has required fields", () => {
        for (const e of parsed) {
            assert.ok(e.sessionId, `missing sessionId in ${e.eventType}`);
            assert.ok(e.eventType, "missing eventType");
            assert.ok(e.kind, "missing kind");
            assert.ok(e.timestamp, "missing timestamp");
            assert.ok(e.message, "missing message");
        }
    });

    it("finds user messages", () => {
        const users = parsed.filter((e) => e.kind === "user");
        assert.ok(users.length > 0, "no user messages found");
    });

    it("finds assistant messages", () => {
        const assistants = parsed.filter((e) => e.kind === "assistant");
        assert.ok(assistants.length > 0, "no assistant messages found");
    });

    it("every event has a sessionId", () => {
        for (const e of parsed) {
            assert.ok(e.sessionId, `missing sessionId in ${e.eventType}`);
        }
    });

    it("logs parse stats", (t) => {
        const kinds = {};
        for (const e of parsed) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        t.diagnostic(`claude real: ${parsed.length}/${total} parsed, ${skipped.length} skipped — ${JSON.stringify(kinds)}`);
    });
});

describe("real sessions: codex-v1-real.jsonl", () => {
    const { parsed, skipped, total } = parseAllLines("codex-v1-real.jsonl", parseCodexLine);

    it("parses 100% of lines", () => {
        assert.equal(parsed.length, total, `expected 100% parse rate, got ${parsed.length}/${total}`);
    });

    it("every parsed event has required fields", () => {
        for (const e of parsed) {
            assert.ok(e.sessionId, `missing sessionId in ${e.eventType}`);
            assert.ok(e.eventType, "missing eventType");
            assert.ok(e.kind, "missing kind");
            assert.ok(e.timestamp, "missing timestamp");
            assert.ok(e.message, "missing message");
        }
    });

    it("finds user messages", () => {
        const users = parsed.filter((e) => e.kind === "user");
        assert.ok(users.length > 0, "no user messages found");
    });

    it("finds assistant messages", () => {
        const assistants = parsed.filter((e) => e.kind === "assistant");
        assert.ok(assistants.length > 0, "no assistant messages found");
        const systems = parsed.filter((e) => e.kind === "system");
        assert.ok(systems.length > 0, "no system messages found");
    });

    it("finds session_meta", () => {
        const metas = parsed.filter((e) => e.eventType === "session_meta");
        assert.ok(metas.length > 0, "no session_meta found");
    });

    it("logs parse stats", (t) => {
        const kinds = {};
        for (const e of parsed) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        t.diagnostic(`codex real: ${parsed.length}/${total} parsed, ${skipped.length} skipped — ${JSON.stringify(kinds)}`);
    });
});
