import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseClaudeCodeLine } from "./agents/claude.mjs";
import { parseCodexLine } from "./agents/codex.mjs";
import { writeCodexSession } from "./writers/codex.mjs";
import { writeClaudeSession } from "./writers/claude.mjs";
import { claudeProjectDirName, expandHome, extractSessionIdFromPath, isSafeCwd } from "./utils.mjs";

// reject sessions larger than this — prevents OOM on crafted/huge JSONL
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

// find latest .jsonl file matching a glob pattern
async function findLatestSession(pattern, excludePattern) {
    const fg = (await import("fast-glob")).default;
    const files = await fg([pattern], {
        onlyFiles: true,
        absolute: true,
        unique: true,
        suppressErrors: true,
        followSymbolicLinks: false,
        ignore: excludePattern ? [excludePattern] : [],
        stats: true,
    });
    if (!files.length) return null;

    // sort by mtime descending, pick latest
    files.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    return files[0].path;
}

// auto-detect latest session file for a given agent
// baseDirs override lets tests point at tmp roots instead of ~/.claude or ~/.codex
async function resolveSessionPath(source, cwd, baseDirs = {}) {
    if (source === "claude") {
        const projectDir = claudeProjectDirName(cwd);
        const root = baseDirs.claude || expandHome("~/.claude/projects");
        const pattern = path.join(root, projectDir, "*.jsonl");
        return findLatestSession(pattern, "**/subagents/**");
    }

    if (source === "codex") {
        const root = baseDirs.codex || expandHome("~/.codex/sessions");
        const pattern = path.join(root, "**/*.jsonl");
        return findLatestSession(pattern);
    }

    return null;
}

// read and parse a local agent session file
export async function readLocalSession({ source, sessionPath, cwd, sourceRoots }) {
    const resolvedCwd = cwd || process.cwd();

    // resolve session file path — sourceRoots lets callers/tests override ~/.claude + ~/.codex
    const filePath = sessionPath || (await resolveSessionPath(source, resolvedCwd, sourceRoots));
    if (!filePath) {
        throw new Error(`No ${source} session found. Specify --session <path>.`);
    }
    if (!fs.existsSync(filePath)) {
        throw new Error(`Session file not found: ${filePath}`);
    }

    // stat via lstat to detect symlinks / special files before read
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Session path is not a regular file: ${filePath}`);
    }
    if (stat.size > MAX_SESSION_BYTES) {
        throw new Error(`Session file too large: ${stat.size} bytes (max ${MAX_SESSION_BYTES}).`);
    }

    // read and parse lines
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const parser = source === "claude" ? parseClaudeCodeLine : parseCodexLine;

    const messages = [];
    let extractedCwd = null;
    let sessionId = null;

    for (const line of lines) {
        const parsed = parser({ line, filePath });
        if (!parsed) continue;

        // capture session id
        if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;

        // extract cwd from metadata entries — only accept safe absolute paths (shell sink)
        if (source === "claude" && parsed.raw?.cwd && !extractedCwd && isSafeCwd(parsed.raw.cwd)) {
            extractedCwd = parsed.raw.cwd;
        }
        if (
            source === "codex" &&
            parsed.raw?.type === "session_meta" &&
            !extractedCwd &&
            isSafeCwd(parsed.raw.payload?.cwd)
        ) {
            extractedCwd = parsed.raw.payload.cwd;
        }

        // only keep user/assistant messages
        if (parsed.kind === "user" || parsed.kind === "assistant") {
            messages.push(parsed);
        }
    }

    return {
        messages,
        sessionId: sessionId || extractSessionIdFromPath(filePath),
        cwd: extractedCwd || resolvedCwd,
        filePath,
    };
}

// convert parsed messages to writer format
function toWriterMessages(messages, source) {
    return messages.map((m) => ({
        role: m.kind,
        content: {
            message: typeof m.message === "string" ? m.message : m.message ?? "",
            timestamp: m.timestamp,
            raw: m.raw,
        },
        metadata: { source },
    }));
}

// switch a session from one agent to another
// baseDir: override target writer's output root (for tests)
// sourceRoots: { claude, codex } override source auto-detect roots (for tests)
export async function switchSession({ source, target, sessionPath, cwd, last, baseDir, sourceRoots }) {
    const session = await readLocalSession({ source, sessionPath, cwd, sourceRoots });

    // optionally slice to last N messages
    let msgs = session.messages;
    if (typeof last === "number" && last > 0) {
        msgs = msgs.slice(-last);
    }

    // convert to writer format
    const writerMessages = toWriterMessages(msgs, source);
    const firstId = randomUUID();

    // pick writer
    const writer = target === "codex" ? writeCodexSession : writeClaudeSession;
    let result = await writer({
        sessionId: firstId,
        cwd: session.cwd,
        messages: writerMessages,
        baseDir,
    });
    let usedId = firstId;

    // retry with fresh UUID if already exists
    if (!result.written && result.reason === "already_exists") {
        const retryId = randomUUID();
        result = await writer({
            sessionId: retryId,
            cwd: session.cwd,
            messages: writerMessages,
            baseDir,
        });
        usedId = retryId;
    }

    return {
        written: result.written,
        filePath: result.filePath,
        // only claim a sessionId when write actually succeeded
        sessionId: result.written ? (result.sessionId || usedId) : null,
        messageCount: writerMessages.length,
        reason: result.reason,
        cwd: session.cwd,
    };
}
