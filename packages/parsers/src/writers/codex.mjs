import fs from "node:fs/promises";
import path from "node:path";

import { asIso, coerceMessageText, expandHome, firstMessageTimestamp, normalizeRole } from "../utils.mjs";

// build a single event_msg JSONL entry
function buildEventMsgLine(message, fallbackTs) {
    const ts = asIso(message?.content?.timestamp ?? message?.metadata?.timestamp ?? fallbackTs);
    const role = normalizeRole(message?.role);
    const text = coerceMessageText(message).trim();
    if (!text) return null;

    if (role === "user") {
        return {
            timestamp: ts,
            type: "event_msg",
            payload: {
                type: "user_message",
                message: text,
                images: [],
                local_images: [],
                text_elements: [],
            },
        };
    }

    if (role === "assistant") {
        return {
            timestamp: ts,
            type: "event_msg",
            payload: { type: "agent_message", message: text },
        };
    }

    // system events
    return {
        timestamp: ts,
        type: "event_msg",
        payload: { type: "agent_message", message: `[system] ${text}` },
    };
}

// compute session file path under ~/.codex/sessions/YYYY/MM/DD/
function sessionFilePath(sessionId, firstTimestamp, baseDir) {
    const iso = asIso(firstTimestamp);
    const [year, month, day] = iso.slice(0, 10).split("-");
    const stamp = iso.replace(/\.\d{3}Z$/, "").replace(/:/g, "-").replace("Z", "");
    const root = baseDir || expandHome("~/.codex/sessions");
    const fileName = `rollout-${stamp}-${sessionId}.jsonl`;
    return path.join(root, year, month, day, fileName);
}

// check if a Codex session already exists locally
export async function hasLocalCodexSession(sessionId, baseDir) {
    const id = String(sessionId ?? "").trim();
    if (!id) return false;

    // dynamic import to avoid bundling fast-glob as hard dep
    const fg = (await import("fast-glob")).default;
    const root = baseDir || expandHome("~/.codex/sessions");
    const pattern = path.join(root, `**/*${id}*.jsonl`);
    const files = await fg([pattern], {
        onlyFiles: true,
        absolute: true,
        unique: true,
        suppressErrors: true,
        followSymbolicLinks: false,
    });
    return files.some((filePath) => filePath.includes(id));
}

// write a Codex-native JSONL session file from UltraContext messages
export async function writeCodexSession({ sessionId, cwd, messages, baseDir }) {
    const id = String(sessionId ?? "").trim();
    if (!id) return { written: false, reason: "missing_session_id", filePath: "", sessionId: "" };

    if (await hasLocalCodexSession(id, baseDir)) {
        return { written: false, reason: "already_exists", filePath: "", sessionId: id };
    }

    const firstMessageTs = firstMessageTimestamp(messages);
    const firstTs = asIso(firstMessageTs);
    const filePath = sessionFilePath(id, firstTs, baseDir);

    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // session_meta header
        const lines = [];
        lines.push(
            JSON.stringify({
                timestamp: firstTs,
                type: "session_meta",
                payload: {
                    id,
                    timestamp: firstTs,
                    cwd: cwd || process.cwd(),
                    originator: "ultracontext_daemon",
                    cli_version: "restored",
                    source: "cli",
                    model_provider: "openai",
                },
            })
        );

        // event messages
        let emitted = 0;
        for (let i = 0; i < (messages?.length ?? 0); i += 1) {
            const fallbackTs = new Date(new Date(firstTs).getTime() + i * 1000).toISOString();
            const line = buildEventMsgLine(messages[i], fallbackTs);
            if (!line) continue;
            lines.push(JSON.stringify(line));
            emitted += 1;
        }

        // fallback if no messages
        if (emitted === 0) {
            lines.push(
                JSON.stringify({
                    timestamp: new Date().toISOString(),
                    type: "event_msg",
                    payload: {
                        type: "agent_message",
                        message: "[system] Session restored from UltraContext with no user/assistant messages.",
                    },
                })
            );
        }

        await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
        return { written: true, reason: "created", filePath, sessionId: id };
    } catch (error) {
        return {
            written: false,
            reason: "write_failed",
            filePath,
            sessionId: id,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
