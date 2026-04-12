import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { writeCodexSession } from "../../src/writers/codex.mjs";
import { parseCodexLine } from "../../src/agents/codex.mjs";

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-codex-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeCodexSession — codex@0.1.x format", () => {
    it("rejects missing sessionId", async () => {
        const result = await writeCodexSession({ sessionId: "", cwd: "/tmp", messages: [], baseDir: tmpDir });
        assert.equal(result.written, false);
        assert.equal(result.reason, "missing_session_id");
    });

    it("produces valid JSONL that our parser can read back", async () => {
        const messages = [
            { role: "user", content: { message: "hello world", timestamp: "2026-04-01T10:00:00.000Z" } },
            { role: "assistant", content: { message: "hi there", timestamp: "2026-04-01T10:00:01.000Z" } },
        ];

        const result = await writeCodexSession({ sessionId: "test-roundtrip-codex", cwd: "/tmp/project", messages, baseDir: tmpDir });
        assert.equal(result.written, true);

        // read back and parse each line
        const content = fs.readFileSync(result.filePath, "utf8").trim().split("\n");
        assert.ok(content.length >= 2, "should have session_meta + at least 1 message");

        // first line = session_meta
        const meta = parseCodexLine({ line: content[0], filePath: result.filePath });
        assert.equal(meta.eventType, "session_meta");

        // second line = user message
        const userMsg = parseCodexLine({ line: content[1], filePath: result.filePath });
        assert.equal(userMsg.kind, "user");
        assert.ok(userMsg.message.includes("hello world"));

        // third line = assistant message
        const assistantMsg = parseCodexLine({ line: content[2], filePath: result.filePath });
        assert.equal(assistantMsg.kind, "assistant");
        assert.ok(assistantMsg.message.includes("hi there"));
    });

    it("writes fallback message when no user/assistant messages", async () => {
        const result = await writeCodexSession({ sessionId: "test-empty-codex", cwd: "/tmp/project", messages: [], baseDir: tmpDir });
        assert.equal(result.written, true);

        const content = fs.readFileSync(result.filePath, "utf8").trim().split("\n");
        // session_meta + fallback
        assert.ok(content.length >= 2);
        const fallback = parseCodexLine({ line: content[1], filePath: result.filePath });
        assert.ok(fallback.message.includes("no user/assistant messages"));
    });
});
