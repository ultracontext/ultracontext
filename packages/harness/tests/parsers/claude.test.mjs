import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseClaudeCodeLine } from "../../src/parsers/claude.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/claude-v1.jsonl");
const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");

describe("parseClaudeCodeLine — claude@1.0.x format", () => {
    it("parses user message", () => {
        const result = parseClaudeCodeLine({ line: lines[0], filePath: fixturePath });
        assert.equal(result.kind, "user");
        assert.equal(result.eventType, "claude.user");
        assert.equal(result.sessionId, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
        assert.ok(result.message.includes("Fix the login bug"));
        assert.equal(result.timestamp, "2026-04-01T10:00:00.000Z");
    });

    it("parses assistant message with tool_use and tool_result", () => {
        const result = parseClaudeCodeLine({ line: lines[1], filePath: fixturePath });
        assert.equal(result.kind, "assistant");
        assert.equal(result.eventType, "claude.assistant");
        assert.ok(result.message.includes("fix the login bug"));
        assert.ok(result.message.includes("[Read]"));
        assert.ok(result.message.includes("[result]"));
    });

    it("parses summary entry", () => {
        const result = parseClaudeCodeLine({ line: lines[2], filePath: fixturePath });
        assert.equal(result.kind, "system");
        assert.equal(result.eventType, "claude.summary");
        assert.ok(result.message.includes("Fixed login bug"));
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseClaudeCodeLine({ line: "not json", filePath: "x.jsonl" }), null);
    });

    it("returns null for unknown type", () => {
        const line = JSON.stringify({ type: "debug", data: {} });
        assert.equal(parseClaudeCodeLine({ line, filePath: "x.jsonl" }), null);
    });

    it("extracts sessionId from filePath when missing in data", () => {
        const line = JSON.stringify({ type: "user", message: { role: "user", content: "hello" } });
        const result = parseClaudeCodeLine({
            line,
            filePath: "/home/.claude/projects/foo/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jsonl",
        });
        assert.equal(result.sessionId, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
    });
});
