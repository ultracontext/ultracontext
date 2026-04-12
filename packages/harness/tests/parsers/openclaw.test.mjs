import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseOpenClawLine } from "../../src/parsers/openclaw.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/openclaw-v1.jsonl");
const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");

describe("parseOpenClawLine — openclaw@0.1.x format", () => {
    it("parses session start", () => {
        const result = parseOpenClawLine({ line: lines[0], filePath: fixturePath });
        assert.equal(result.eventType, "openclaw.session");
        assert.equal(result.kind, "system");
        assert.ok(result.message.includes("/Users/alice/Code/myapp"));
    });

    it("parses model-snapshot custom event", () => {
        const result = parseOpenClawLine({ line: lines[1], filePath: fixturePath });
        assert.equal(result.eventType, "openclaw.custom.model-snapshot");
        assert.equal(result.kind, "system");
        assert.ok(result.message.includes("anthropic"));
        assert.ok(result.message.includes("claude-3-sonnet"));
    });

    it("parses user message", () => {
        const result = parseOpenClawLine({ line: lines[2], filePath: fixturePath });
        assert.equal(result.kind, "user");
        assert.equal(result.eventType, "openclaw.user");
        assert.ok(result.message.includes("error handling"));
    });

    it("parses assistant text message", () => {
        const result = parseOpenClawLine({ line: lines[3], filePath: fixturePath });
        assert.equal(result.kind, "assistant");
        assert.equal(result.eventType, "openclaw.assistant");
        assert.ok(result.message.includes("try/catch"));
    });

    it("parses assistant tool_use (no text)", () => {
        const result = parseOpenClawLine({ line: lines[4], filePath: fixturePath });
        assert.equal(result.eventType, "openclaw.assistant.tool_use");
        assert.equal(result.kind, "system");
        assert.ok(result.message.includes("editFile"));
    });

    it("parses tool result", () => {
        const result = parseOpenClawLine({ line: lines[5], filePath: fixturePath });
        assert.equal(result.eventType, "openclaw.tool_result");
        assert.equal(result.kind, "system");
        assert.ok(result.message.includes("editFile"));
        assert.ok(result.message.includes("ok"));
    });

    it("parses compaction", () => {
        const result = parseOpenClawLine({ line: lines[6], filePath: fixturePath });
        assert.equal(result.eventType, "openclaw.compaction");
        assert.equal(result.kind, "system");
    });

    it("parses branch_summary", () => {
        const result = parseOpenClawLine({ line: lines[7], filePath: fixturePath });
        assert.equal(result.eventType, "openclaw.branch_summary");
        assert.equal(result.kind, "system");
        assert.ok(result.message.includes("error handling"));
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseOpenClawLine({ line: "nope", filePath: "x.jsonl" }), null);
    });

    it("filters out cache-ttl custom events", () => {
        const line = JSON.stringify({ type: "custom", customType: "openclaw.cache-ttl", timestamp: "2026-04-01T10:00:00.000Z" });
        assert.equal(parseOpenClawLine({ line, filePath: "x.jsonl" }), null);
    });
});
