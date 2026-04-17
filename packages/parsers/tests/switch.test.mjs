import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { switchSession, readLocalSession } from "../src/switch.mjs";
import { parseCodexLine } from "../src/agents/codex.mjs";
import { parseClaudeCodeLine } from "../src/agents/claude.mjs";

let tmpDir;
let srcDir;
let baseDir;

// minimal claude session: 3 user/assistant messages with a cwd in metadata
function writeClaudeFixture(filePath, { cwd = "/tmp/project", count = 3 } = {}) {
    const lines = [];
    let parent = null;
    for (let i = 0; i < count; i++) {
        const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        const role = i % 2 === 0 ? "user" : "assistant";
        lines.push(JSON.stringify({
            parentUuid: parent,
            isSidechain: false,
            userType: "external",
            cwd,
            sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
            version: "1",
            gitBranch: "main",
            type: role,
            message: { role, content: `message ${i}` },
            timestamp: `2026-04-01T10:00:0${i}.000Z`,
            uuid,
        }));
        parent = uuid;
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// minimal codex session: session_meta + event_msg pairs
function writeCodexFixture(filePath, { cwd = "/tmp/project", count = 2 } = {}) {
    const lines = [];
    lines.push(JSON.stringify({
        timestamp: "2026-04-01T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "sess-1", timestamp: "2026-04-01T10:00:00.000Z", cwd, originator: "codex" },
    }));
    for (let i = 0; i < count; i++) {
        const type = i % 2 === 0 ? "user_message" : "agent_message";
        lines.push(JSON.stringify({
            timestamp: `2026-04-01T10:00:0${i + 1}.000Z`,
            type: "event_msg",
            payload: { type, message: `codex msg ${i}` },
        }));
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "switch-test-"));
    srcDir = path.join(tmpDir, "src");
    baseDir = path.join(tmpDir, "out");
    fs.mkdirSync(srcDir, { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readLocalSession — error paths", () => {
    it("throws when no session found and no --session given", async () => {
        await assert.rejects(
            () => readLocalSession({ source: "claude", cwd: path.join(tmpDir, "never-existed") }),
            /No claude session found/
        );
    });

    it("throws when explicit sessionPath does not exist", async () => {
        await assert.rejects(
            () => readLocalSession({ source: "claude", sessionPath: path.join(tmpDir, "missing.jsonl") }),
            /Session file not found/
        );
    });
});

describe("readLocalSession — cwd trust boundary", () => {
    it("uses cwd from session metadata when safe (absolute, no control chars)", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { cwd: "/tmp/safe-project" });
        const r = await readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir });
        assert.equal(r.cwd, "/tmp/safe-project");
    });

    it("rejects unsafe cwd with newline and falls back to caller cwd", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        // craft a session with a malicious cwd (newline injection for shell sinks)
        const unsafe = "/tmp/bad\nrm -rf /";
        writeClaudeFixture(fx, { cwd: unsafe });
        const r = await readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir });
        assert.notEqual(r.cwd, unsafe, "unsafe cwd must not propagate");
        assert.equal(r.cwd, tmpDir);
    });

    it("rejects relative cwd from session file", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { cwd: "./relative" });
        const r = await readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir });
        assert.equal(r.cwd, tmpDir);
    });
});

describe("switchSession — claude → codex roundtrip", () => {
    it("writes a codex session file with the same message count", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { count: 4 });
        const r = await switchSession({
            source: "claude",
            target: "codex",
            sessionPath: fx,
            cwd: tmpDir,
            baseDir,
        });
        assert.equal(r.written, true, r.reason);
        assert.equal(r.messageCount, 4);
        assert.ok(r.sessionId, "sessionId should be set on success");
        assert.ok(fs.existsSync(r.filePath));

        // verify codex parser can read it back
        const content = fs.readFileSync(r.filePath, "utf8").trim().split("\n");
        const parsed = content.map((l) => parseCodexLine({ line: l, filePath: r.filePath })).filter(Boolean);
        assert.ok(parsed.length >= 2, "should round-trip at least user + assistant");
    });

    it("slices to last N messages when --last given", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { count: 5 });
        const r = await switchSession({
            source: "claude", target: "codex",
            sessionPath: fx, cwd: tmpDir, baseDir, last: 2,
        });
        assert.equal(r.messageCount, 2);
    });

    it("ignores last=0 (keeps all messages)", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { count: 3 });
        const r = await switchSession({
            source: "claude", target: "codex",
            sessionPath: fx, cwd: tmpDir, baseDir, last: 0,
        });
        assert.equal(r.messageCount, 3);
    });
});

describe("switchSession — codex → claude roundtrip", () => {
    it("writes a claude session file parseable by claude parser", async () => {
        const fx = path.join(srcDir, "codex.jsonl");
        writeCodexFixture(fx, { count: 2 });
        const r = await switchSession({
            source: "codex",
            target: "claude",
            sessionPath: fx,
            cwd: tmpDir,
            baseDir,
        });
        assert.equal(r.written, true, r.reason);
        assert.ok(r.messageCount >= 2);
        assert.ok(fs.existsSync(r.filePath));

        const content = fs.readFileSync(r.filePath, "utf8").trim().split("\n");
        const parsed = content.map((l) => parseClaudeCodeLine({ line: l, filePath: r.filePath })).filter(Boolean);
        const kinds = parsed.map((p) => p.kind);
        assert.ok(kinds.includes("user") || kinds.includes("assistant"));
    });
});

describe("switchSession — file size cap", () => {
    it("rejects session files above the size cap via readLocalSession", async () => {
        // simulate oversize by monkey-patching fs.statSync for the specific path
        const fx = path.join(srcDir, "huge.jsonl");
        writeClaudeFixture(fx, { count: 1 });
        const realStat = fs.statSync;
        fs.statSync = (p, ...rest) => {
            const s = realStat(p, ...rest);
            if (p === fx) {
                return { ...s, size: 300 * 1024 * 1024 };
            }
            return s;
        };
        try {
            await assert.rejects(
                () => readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir }),
                /too large/
            );
        } finally {
            fs.statSync = realStat;
        }
    });
});
