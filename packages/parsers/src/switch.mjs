import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseClaudeCodeLine } from "./agents/claude.mjs";
import { parseCodexLine } from "./agents/codex.mjs";
import { writeCodexSession } from "./writers/codex.mjs";
import { writeClaudeSession } from "./writers/claude.mjs";
import { expandHome, extractSessionIdFromPath } from "./utils.mjs";

// build Claude project dir name from cwd (mirrors writers/claude.mjs)
function claudeProjectDirName(cwd) {
    const resolved = path.resolve(String(cwd || process.cwd()));
    return resolved.replace(/[\\/]/g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

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
async function resolveSessionPath(source, cwd) {
    if (source === "claude") {
        const projectDir = claudeProjectDirName(cwd);
        const root = expandHome("~/.claude/projects");
        const pattern = path.join(root, projectDir, "*.jsonl");
        return findLatestSession(pattern, "**/subagents/**");
    }

    if (source === "codex") {
        const root = expandHome("~/.codex/sessions");
        const pattern = path.join(root, "**/*.jsonl");
        return findLatestSession(pattern);
    }

    return null;
}

// read and parse a local agent session file
export async function readLocalSession({ source, sessionPath, cwd }) {
    const resolvedCwd = cwd || process.cwd();

    // resolve session file path
    const filePath = sessionPath || (await resolveSessionPath(source, resolvedCwd));
    if (!filePath) {
        throw new Error(`No ${source} session found. Specify --session <path>.`);
    }
    if (!fs.existsSync(filePath)) {
        throw new Error(`Session file not found: ${filePath}`);
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

        // extract cwd from metadata entries
        if (source === "claude" && parsed.raw?.cwd && !extractedCwd) {
            extractedCwd = parsed.raw.cwd;
        }
        if (source === "codex" && parsed.raw?.type === "session_meta" && !extractedCwd) {
            extractedCwd = parsed.raw.payload?.cwd;
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
export async function switchSession({ source, target, sessionPath, cwd, last }) {
    const session = await readLocalSession({ source, sessionPath, cwd });

    // optionally slice to last N messages
    let msgs = session.messages;
    if (typeof last === "number" && last > 0) {
        msgs = msgs.slice(-last);
    }

    // convert to writer format
    const writerMessages = toWriterMessages(msgs, source);
    const newSessionId = randomUUID();

    // pick writer
    const writer = target === "codex" ? writeCodexSession : writeClaudeSession;
    let result = await writer({
        sessionId: newSessionId,
        cwd: session.cwd,
        messages: writerMessages,
    });

    // retry with fresh UUID if already exists
    if (!result.written && result.reason === "already_exists") {
        const retryId = randomUUID();
        result = await writer({
            sessionId: retryId,
            cwd: session.cwd,
            messages: writerMessages,
        });
        if (result.written) result.sessionId = retryId;
    }

    return {
        written: result.written,
        filePath: result.filePath,
        sessionId: result.sessionId || newSessionId,
        messageCount: writerMessages.length,
        reason: result.reason,
        cwd: session.cwd,
    };
}
