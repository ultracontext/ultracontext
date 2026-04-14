import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCursorLine } from "../../src/agents/cursor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/cursor-v1.jsonl");
const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");

describe("parseCursorLine — cursor@0.1.x format", () => {
    it("parses user message and strips <user_query> tags", () => {
        const result = parseCursorLine({ line: lines[0], filePath: fixturePath });
        assert.equal(result.kind, "user");
        assert.equal(result.eventType, "cursor.user");
        assert.ok(result.message.includes("Refactor the auth module"));
        assert.ok(!result.message.includes("<user_query>"), "should strip user_query tags");
    });

    it("parses assistant message with tool_use", () => {
        const result = parseCursorLine({ line: lines[1], filePath: fixturePath });
        assert.equal(result.kind, "assistant");
        assert.equal(result.eventType, "cursor.assistant");
        assert.ok(result.message.includes("refactor the auth module"));
    });

    it("parses summary entry", () => {
        const result = parseCursorLine({ line: lines[2], filePath: fixturePath });
        assert.equal(result.kind, "system");
        assert.equal(result.eventType, "cursor.summary");
        assert.ok(result.message.includes("Refactored auth module"));
    });

    it("re-namespaces event types from claude.* to cursor.*", () => {
        const result = parseCursorLine({ line: lines[0], filePath: fixturePath });
        assert.ok(result.eventType.startsWith("cursor."));
        assert.ok(!result.eventType.startsWith("claude."));
    });

    it("normalizes role -> type for unknown types", () => {
        const line = JSON.stringify({ role: "user", message: { role: "user", content: "hello" } });
        const result = parseCursorLine({ line, filePath: "test.jsonl" });
        assert.equal(result.kind, "user");
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseCursorLine({ line: "not json", filePath: "x.jsonl" }), null);
    });
});
