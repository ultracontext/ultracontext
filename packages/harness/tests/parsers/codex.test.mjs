import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCodexLine } from "../../src/parsers/codex.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/codex-v1.jsonl");
const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");

describe("parseCodexLine — codex@0.1.x format", () => {
    it("parses session_meta", () => {
        const result = parseCodexLine({ line: lines[0], filePath: fixturePath });
        assert.equal(result.eventType, "session_meta");
        assert.equal(result.kind, "system");
        assert.equal(result.sessionId, "sess-codex-001");
        assert.ok(result.message.includes("/Users/alice/Code/myapp"));
    });

    it("parses user_message event", () => {
        const result = parseCodexLine({ line: lines[1], filePath: fixturePath });
        assert.equal(result.kind, "user");
        assert.equal(result.eventType, "event_msg.user_message");
        assert.ok(result.message.includes("Refactor the database"));
    });

    it("parses agent_message event", () => {
        const result = parseCodexLine({ line: lines[2], filePath: fixturePath });
        assert.equal(result.kind, "assistant");
        assert.equal(result.eventType, "event_msg.agent_message");
        assert.ok(result.message.includes("connection pooling"));
    });

    it("parses task_started as system", () => {
        const result = parseCodexLine({ line: lines[3], filePath: fixturePath });
        assert.equal(result.kind, "system");
        assert.equal(result.eventType, "event_msg.task_started");
    });

    it("parses task_complete with last_agent_message", () => {
        const result = parseCodexLine({ line: lines[4], filePath: fixturePath });
        assert.equal(result.kind, "system");
        assert.equal(result.eventType, "event_msg.task_complete");
        assert.ok(result.message.includes("Refactoring complete"));
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseCodexLine({ line: "{bad", filePath: "x.jsonl" }), null);
    });

    it("returns null for unknown event_msg type", () => {
        const line = JSON.stringify({ type: "event_msg", payload: { type: "debug_info" } });
        assert.equal(parseCodexLine({ line, filePath: "x.jsonl" }), null);
    });

    it("falls back to extracting sessionId from filePath", () => {
        const line = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } });
        const result = parseCodexLine({
            line,
            filePath: "/home/.codex/sessions/2026/04/01/rollout-sess-codex-001.jsonl",
        });
        assert.ok(result.sessionId);
    });
});
