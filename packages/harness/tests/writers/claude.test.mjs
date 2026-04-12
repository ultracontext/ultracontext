import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { writeClaudeSession } from "../../src/writers/claude.mjs";
import { parseClaudeCodeLine } from "../../src/parsers/claude.mjs";

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-claude-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeClaudeSession — claude@1.0.x format", () => {
    it("rejects missing sessionId gracefully (generates UUID)", async () => {
        const result = await writeClaudeSession({ sessionId: "", cwd: "/tmp", messages: [], baseDir: tmpDir });
        // writeClaudeSession generates a UUID if missing, so it should still attempt to write
        assert.ok(result.sessionId, "should have a generated sessionId");
        assert.equal(result.written, true);
    });

    it("produces valid JSONL that our parser can read back", async () => {
        const messages = [
            { role: "user", content: { message: "implement feature X", timestamp: "2026-04-01T10:00:00.000Z" } },
            { role: "assistant", content: { message: "I'll implement feature X now.", timestamp: "2026-04-01T10:00:01.000Z" } },
            { role: "user", content: { message: "looks good, ship it", timestamp: "2026-04-01T10:00:05.000Z" } },
        ];

        const result = await writeClaudeSession({
            sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-aaaaaaaaaaaa",
            cwd: "/tmp/project",
            messages,
            baseDir: tmpDir,
        });
        assert.equal(result.written, true);

        // read back and parse
        const content = fs.readFileSync(result.filePath, "utf8").trim().split("\n");
        assert.equal(content.length, 3, "should have 3 message entries");

        // verify linked-list structure (parentUuid chain)
        const entries = content.map((l) => JSON.parse(l));
        assert.equal(entries[0].parentUuid, null, "first entry has no parent");
        assert.equal(entries[1].parentUuid, entries[0].uuid, "second links to first");
        assert.equal(entries[2].parentUuid, entries[1].uuid, "third links to second");

        // verify parser can read them
        const parsed0 = parseClaudeCodeLine({ line: content[0], filePath: result.filePath });
        assert.equal(parsed0.kind, "user");
        assert.ok(parsed0.message.includes("implement feature X"));

        const parsed1 = parseClaudeCodeLine({ line: content[1], filePath: result.filePath });
        assert.equal(parsed1.kind, "assistant");

        const parsed2 = parseClaudeCodeLine({ line: content[2], filePath: result.filePath });
        assert.equal(parsed2.kind, "user");
    });

    it("writes fallback when no messages", async () => {
        const result = await writeClaudeSession({
            sessionId: "b2c3d4e5-f6a7-4b8c-9d0e-bbbbbbbbbbbb",
            cwd: "/tmp/project",
            messages: [],
            baseDir: tmpDir,
        });
        assert.equal(result.written, true);

        const content = fs.readFileSync(result.filePath, "utf8").trim().split("\n");
        assert.equal(content.length, 1);
        const parsed = parseClaudeCodeLine({ line: content[0], filePath: result.filePath });
        assert.equal(parsed.kind, "assistant");
        assert.ok(parsed.message.includes("no user/assistant messages"));
    });

    it("handles system role messages as assistant with [system] prefix", async () => {
        const messages = [
            { role: "system", content: { message: "Context loaded", timestamp: "2026-04-01T10:00:00.000Z" } },
        ];

        const result = await writeClaudeSession({
            sessionId: "c3d4e5f6-a7b8-4c9d-0e1f-cccccccccccc",
            cwd: "/tmp/project",
            messages,
            baseDir: tmpDir,
        });
        assert.equal(result.written, true);

        const content = fs.readFileSync(result.filePath, "utf8").trim().split("\n");
        const entry = JSON.parse(content[0]);
        assert.equal(entry.type, "assistant");
        assert.ok(entry.message.content.includes("[system]"));
    });
});
