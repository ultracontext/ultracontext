import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { asIso, expandHome, firstMessageTimestamp, normalizeRole } from "../utils.mjs";

// validate UUID format
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(value ?? "").trim()
    );
}

// ensure we have a valid UUID, generate one if not
function normalizeSessionUuid(raw) {
    const value = String(raw ?? "").trim();
    if (isUuid(value)) return value;
    return randomUUID();
}

// build Claude Code project directory name from cwd
function claudeProjectDirName(cwd) {
    const resolved = path.resolve(String(cwd || process.cwd()));
    return resolved.replace(/[\\/]/g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

// compute session file path under ~/.claude/projects/<project>/
function claudeSessionFilePath(sessionId, cwd, baseDir) {
    const root = baseDir || expandHome("~/.claude/projects");
    return path.join(root, claudeProjectDirName(cwd), `${sessionId}.jsonl`);
}

// check if a Claude Code session already exists locally
export async function hasLocalClaudeSession(sessionId, cwd = "", baseDir) {
    const id = String(sessionId ?? "").trim();
    if (!id) return false;

    // check preferred path first
    const preferredPath = claudeSessionFilePath(id, cwd || process.cwd(), baseDir);
    try {
        const stat = await fs.stat(preferredPath);
        if (stat.isFile()) return true;
    } catch {
        // fall through to glob
    }

    // dynamic import to avoid bundling fast-glob as hard dep
    const fg = (await import("fast-glob")).default;
    const root = baseDir || expandHome("~/.claude/projects");
    const pattern = path.join(root, `**/*${id}.jsonl`);
    const files = await fg([pattern], {
        onlyFiles: true,
        absolute: true,
        unique: true,
        suppressErrors: true,
        followSymbolicLinks: false,
    });
    return files.some((filePath) => path.basename(filePath, ".jsonl") === id);
}

// check if raw entry is native Claude Code format
function isNativeClaudeEntry(raw) {
    return raw && typeof raw === "object" && ("type" in raw) && ("sessionId" in raw || "uuid" in raw);
}

// write a Claude Code-native JSONL session file from UltraContext messages
export async function writeClaudeSession({ sessionId, cwd, messages, baseDir }) {
    const runCwd = String(cwd || process.cwd());
    const resolvedSessionId = normalizeSessionUuid(sessionId);
    const firstTs = asIso(firstMessageTimestamp(messages));
    const filePath = claudeSessionFilePath(resolvedSessionId, runCwd, baseDir);

    if (await hasLocalClaudeSession(resolvedSessionId, runCwd, baseDir)) {
        return {
            written: false,
            reason: "already_exists",
            filePath,
            sessionId: resolvedSessionId,
        };
    }

    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        const lines = [];
        let parentUuid = null;

        for (let i = 0; i < (messages?.length ?? 0); i += 1) {
            const message = messages[i];
            const raw = message?.content?.raw;

            // native Claude Code entry — write back as-is with updated session linkage
            if (isNativeClaudeEntry(raw)) {
                const entryUuid = raw.uuid || randomUUID();
                lines.push(JSON.stringify({
                    ...raw,
                    parentUuid,
                    sessionId: resolvedSessionId,
                }));
                parentUuid = entryUuid;
                continue;
            }

            // non-claude source (codex, openclaw) — convert to Claude Code format
            const normalizedRole = normalizeRole(message?.role);
            const role = normalizedRole === "assistant" ? "assistant" : normalizedRole === "user" ? "user" : "assistant";
            const text = extractMessageText(message, normalizedRole);
            if (!text) continue;

            const ts = asIso(
                message?.content?.timestamp ??
                    message?.metadata?.timestamp ??
                    new Date(new Date(firstTs).getTime() + i * 1000).toISOString()
            );
            const entryUuid = randomUUID();
            lines.push(JSON.stringify({
                parentUuid,
                isSidechain: false,
                userType: "external",
                cwd: runCwd,
                sessionId: resolvedSessionId,
                version: "adapter",
                gitBranch: "",
                type: role,
                message: { role, content: [{ type: "text", text }] },
                timestamp: ts,
                uuid: entryUuid,
            }));
            parentUuid = entryUuid;
        }

        // fallback if no messages
        if (lines.length === 0) {
            lines.push(JSON.stringify({
                parentUuid: null,
                isSidechain: false,
                userType: "external",
                cwd: runCwd,
                sessionId: resolvedSessionId,
                version: "adapter",
                gitBranch: "",
                type: "assistant",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "[system] Session restored from UltraContext with no user/assistant messages." }],
                },
                timestamp: new Date().toISOString(),
                uuid: randomUUID(),
            }));
        }

        await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
        return {
            written: true,
            reason: "created",
            filePath,
            sessionId: resolvedSessionId,
        };
    } catch (error) {
        return {
            written: false,
            reason: "write_failed",
            filePath,
            sessionId: resolvedSessionId,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// extract text from message, handling various formats
function extractMessageText(message, normalizedRole) {
    const raw = message?.content?.raw;

    // codex response_item.message — extract from content array
    if (raw?.type === "response_item" && raw?.payload?.type === "message") {
        const parts = raw.payload.content ?? [];
        const text = parts.map(c => c.text ?? "").filter(Boolean).join("\n");
        if (text) return normalizedRole === "system" ? `[system] ${text}` : text;
    }

    // codex event_msg.user_message
    if (raw?.type === "event_msg" && raw?.payload?.type === "user_message") {
        return raw.payload.message ?? "";
    }

    // fallback — use stored message text
    const msg = message?.content?.message ?? "";
    if (!msg) return "";
    return normalizedRole === "system" ? `[system] ${msg}` : msg;
}
