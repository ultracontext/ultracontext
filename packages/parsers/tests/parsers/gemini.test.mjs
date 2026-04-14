import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseGeminiFile, extractGeminiTextContent } from "../../src/agents/gemini.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/gemini-v1.json");
const fileContents = fs.readFileSync(fixturePath, "utf8");

describe("parseGeminiFile — gemini@0.1.x format", () => {
    it("parses all messages from JSON file", () => {
        const events = parseGeminiFile({ fileContents, filePath: fixturePath });
        assert.equal(events.length, 4);
    });

    it("parses user message with array content", () => {
        const events = parseGeminiFile({ fileContents, filePath: fixturePath });
        const user = events[0];
        assert.equal(user.kind, "user");
        assert.equal(user.eventType, "gemini.user");
        assert.ok(user.message.includes("Fix the database connection pool"));
    });

    it("parses gemini message with string content and tool calls", () => {
        const events = parseGeminiFile({ fileContents, filePath: fixturePath });
        const gemini = events[1];
        assert.equal(gemini.kind, "assistant");
        assert.equal(gemini.eventType, "gemini.assistant");
        assert.ok(gemini.message.includes("connection pool configuration"));
        assert.ok(gemini.message.includes("[edit_file]"));
        assert.ok(gemini.message.includes("/src/db.ts"));
    });

    it("extracts session ID from filename", () => {
        const events = parseGeminiFile({
            fileContents,
            filePath: "/home/.gemini/tmp/abc123/chats/session-20260403-xyz789.json",
        });
        assert.equal(events[0].sessionId, "xyz789");
    });

    it("preserves timestamps from messages", () => {
        const events = parseGeminiFile({ fileContents, filePath: fixturePath });
        assert.equal(events[0].timestamp, "2026-04-03T09:00:00.000Z");
        assert.equal(events[1].timestamp, "2026-04-03T09:00:10.000Z");
    });

    it("stores compact raw metadata", () => {
        const events = parseGeminiFile({ fileContents, filePath: fixturePath });
        assert.equal(events[1].raw.hasToolCalls, true);
        assert.equal(events[1].raw.toolCallCount, 1);
        assert.equal(events[1].raw.index, 1);
    });

    it("returns empty array for invalid JSON", () => {
        const events = parseGeminiFile({ fileContents: "not json", filePath: "x.json" });
        assert.deepEqual(events, []);
    });

    it("returns empty array for empty messages", () => {
        const events = parseGeminiFile({ fileContents: '{"messages":[]}', filePath: "x.json" });
        assert.deepEqual(events, []);
    });
});

describe("extractGeminiTextContent", () => {
    it("handles string content", () => {
        assert.equal(extractGeminiTextContent("hello world"), "hello world");
    });

    it("handles array content", () => {
        const content = [{ text: "part 1" }, { text: "part 2" }];
        assert.equal(extractGeminiTextContent(content), "part 1\npart 2");
    });

    it("handles null/undefined", () => {
        assert.equal(extractGeminiTextContent(null), "");
        assert.equal(extractGeminiTextContent(undefined), "");
    });

    it("handles object with text field", () => {
        assert.equal(extractGeminiTextContent({ text: "hello" }), "hello");
    });
});
