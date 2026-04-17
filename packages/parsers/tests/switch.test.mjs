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

describe("switchSession — file size cap + non-regular files", () => {
    it("rejects session files above the size cap via readLocalSession", async () => {
        // simulate oversize by monkey-patching fs.lstatSync for the specific path
        const fx = path.join(srcDir, "huge.jsonl");
        writeClaudeFixture(fx, { count: 1 });
        const realLstat = fs.lstatSync;
        fs.lstatSync = (p, ...rest) => {
            const s = realLstat(p, ...rest);
            if (p === fx) {
                return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 300 * 1024 * 1024 });
            }
            return s;
        };
        try {
            await assert.rejects(
                () => readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir }),
                /too large/
            );
        } finally {
            fs.lstatSync = realLstat;
        }
    });

    it("rejects non-regular session paths (symlink / socket / fifo)", async () => {
        // simulate a non-regular file by monkey-patching lstat to return isFile()=false
        const fx = path.join(srcDir, "fifo.jsonl");
        writeClaudeFixture(fx, { count: 1 });
        const realLstat = fs.lstatSync;
        fs.lstatSync = (p, ...rest) => {
            const s = realLstat(p, ...rest);
            if (p === fx) {
                return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { isFile: () => false });
            }
            return s;
        };
        try {
            await assert.rejects(
                () => readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir }),
                /not a regular file/
            );
        } finally {
            fs.lstatSync = realLstat;
        }
    });
});

describe("readLocalSession — cwd canonicalization", () => {
    it("rejects non-canonical cwd (contains ..)", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { cwd: "/tmp/foo/../etc" });
        const r = await readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir });
        assert.equal(r.cwd, tmpDir, "non-canonical cwd must not propagate");
    });

    it("rejects cwd with ESC control char", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { cwd: "/tmp/bad\x1b]0;hijack\x07" });
        const r = await readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir });
        assert.equal(r.cwd, tmpDir);
    });

    it("rejects cwd with unicode line separator", async () => {
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { cwd: "/tmp/bad\u2028after" });
        const r = await readLocalSession({ source: "claude", sessionPath: fx, cwd: tmpDir });
        assert.equal(r.cwd, tmpDir);
    });
});

describe("switchSession — retry on UUID collision", () => {
    it("retries with fresh UUID when first write hits already_exists", async () => {
        // pre-seed baseDir with any jsonl so the codex writer's hasLocalCodexSession
        // will only report true for matching UUID. We can't force a real collision
        // without mocking randomUUID, but we can round-trip twice with the same
        // sessionPath → baseDir and assert both succeed with distinct session IDs.
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { count: 2 });
        const r1 = await switchSession({
            source: "claude", target: "codex",
            sessionPath: fx, cwd: tmpDir, baseDir,
        });
        const r2 = await switchSession({
            source: "claude", target: "codex",
            sessionPath: fx, cwd: tmpDir, baseDir,
        });
        assert.equal(r1.written, true);
        assert.equal(r2.written, true);
        assert.notEqual(r1.sessionId, r2.sessionId, "two calls must get distinct session IDs");
    });

    it("returns sessionId=null when write fails", async () => {
        // writer errors out if baseDir is a file (mkdir fails)
        const fx = path.join(srcDir, "claude.jsonl");
        writeClaudeFixture(fx, { count: 1 });
        const badBase = path.join(tmpDir, "not-a-dir");
        fs.writeFileSync(badBase, "blocking file");
        const r = await switchSession({
            source: "claude", target: "codex",
            sessionPath: fx, cwd: tmpDir, baseDir: badBase,
        });
        assert.equal(r.written, false);
        assert.equal(r.sessionId, null, "no sessionId leaks when write fails");
    });
});

describe("switchSession — empty messages end-to-end", () => {
    it("writes fallback line when source has no user/assistant messages", async () => {
        // claude session with only a 'summary' line (no user/assistant kinds)
        const fx = path.join(srcDir, "empty.jsonl");
        fs.writeFileSync(fx, JSON.stringify({
            parentUuid: null, type: "summary",
            sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
            uuid: "11111111-1111-4111-8111-111111111111",
            summary: "nothing",
            timestamp: "2026-04-01T10:00:00.000Z",
            cwd: "/tmp/project",
        }) + "\n");
        const r = await switchSession({
            source: "claude", target: "claude",
            sessionPath: fx, cwd: tmpDir, baseDir,
        });
        assert.equal(r.messageCount, 0);
        assert.equal(r.written, true);
        const content = fs.readFileSync(r.filePath, "utf8").trim().split("\n");
        assert.equal(content.length, 1);
        const parsed = JSON.parse(content[0]);
        assert.ok(parsed.message.content[0].text.includes("no user/assistant messages"));
    });
});

describe("resolveSessionPath — sourceRoots override (hermetic)", () => {
    it("picks latest mtime when multiple claude sessions exist under injected root", async () => {
        // ~/.claude/projects/<dirname>/<uuid>.jsonl layout
        const claudeRoot = path.join(tmpDir, "claude-projects");
        // claudeProjectDirName turns /tmp/proj into "-tmp-proj" style slug — match exactly
        // by using the same algorithm: the cwd here is `/tmp/proj`, slug is `-tmp-proj`
        const projDir = path.join(claudeRoot, "-tmp-proj");
        fs.mkdirSync(projDir, { recursive: true });
        const older = path.join(projDir, "older.jsonl");
        const newer = path.join(projDir, "newer.jsonl");
        writeClaudeFixture(older, { count: 1 });
        writeClaudeFixture(newer, { count: 1 });
        // force mtime ordering
        const past = new Date(Date.now() - 10_000);
        fs.utimesSync(older, past, past);
        const r = await readLocalSession({
            source: "claude",
            cwd: "/tmp/proj",
            sourceRoots: { claude: claudeRoot },
        });
        assert.equal(path.basename(r.filePath), "newer.jsonl");
    });
});
