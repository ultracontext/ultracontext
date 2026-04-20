import {
    extractSessionIdFromPath,
    normalizeWhitespace,
    safeJsonParse,
    toMessage,
    truncateString,
} from "../utils.mjs";

// extract text from OpenClaw content (string, array, or object)
function extractOpenClawTextContent(content) {
    if (!content) return "";
    if (typeof content === "string") return normalizeWhitespace(content);

    if (Array.isArray(content)) {
        const textParts = [];
        for (const item of content) {
            if (!item || typeof item !== "object") continue;
            if (item.type === "text" && typeof item.text === "string") {
                const chunk = normalizeWhitespace(item.text);
                if (chunk) textParts.push(chunk);
            }
        }
        return textParts.join("\n");
    }

    if (typeof content === "object" && typeof content.text === "string") {
        return normalizeWhitespace(content.text);
    }

    return "";
}

// extract tool call names from OpenClaw content array
function extractOpenClawToolCalls(content) {
    if (!Array.isArray(content)) return [];
    const names = [];
    for (const item of content) {
        if (!item || typeof item !== "object" || item.type !== "toolCall") continue;
        const name = normalizeWhitespace(item.name);
        if (name) names.push(name);
    }
    return names;
}

// build compact raw representation for storage
function buildOpenClawRaw(parsed) {
    const raw = {
        type: parsed.type,
        id: parsed.id,
        parentId: parsed.parentId,
        timestamp: parsed.timestamp,
    };

    if (parsed.type === "session") {
        raw.session = {
            id: parsed.id,
            version: parsed.version,
            cwd: parsed.cwd,
            parentSession: parsed.parentSession,
        };
        return raw;
    }

    if (parsed.type === "custom") {
        raw.customType = parsed.customType;
        if (parsed.customType === "model-snapshot" && parsed.data && typeof parsed.data === "object") {
            raw.data = {
                provider: parsed.data.provider,
                modelApi: parsed.data.modelApi,
                modelId: parsed.data.modelId,
                timestamp: parsed.data.timestamp,
            };
        }
        return raw;
    }

    if (parsed.message && typeof parsed.message === "object") {
        const contentTypes = Array.isArray(parsed.message.content)
            ? parsed.message.content
                  .filter((item) => item && typeof item === "object")
                  .map((item) => String(item.type ?? "unknown"))
                  .slice(0, 12)
            : [];

        raw.message = {
            role: parsed.message.role,
            stopReason: parsed.message.stopReason,
            toolName: parsed.message.toolName,
            toolCallId: parsed.message.toolCallId,
            isError: parsed.message.isError,
            contentTypes,
        };
    }

    if (parsed.type === "compaction") {
        raw.compaction = {
            firstKeptEntryId: parsed.firstKeptEntryId,
            tokensBefore: parsed.tokensBefore,
        };
    } else if (parsed.type === "branch_summary") {
        raw.branchSummary = {
            firstKeptEntryId: parsed.firstKeptEntryId,
            summary: typeof parsed.summary === "string" ? truncateString(parsed.summary, 350) : "",
        };
    }

    return raw;
}

// parse a single JSONL line from an OpenClaw session file
export function parseOpenClawLine({ line, filePath }) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") return null;

    const type = String(parsed.type ?? "").toLowerCase();
    const sessionId =
        parsed.session_id ??
        parsed.sessionId ??
        parsed.message?.session_id ??
        parsed.message?.sessionId ??
        extractSessionIdFromPath(filePath);

    const timestamp = parsed.timestamp ?? parsed.message?.timestamp ?? new Date().toISOString();

    // session start
    if (type === "session") {
        return {
            sessionId,
            eventType: "openclaw.session",
            kind: "system",
            timestamp,
            message: toMessage(`Session started in ${parsed.cwd ?? "unknown cwd"}`),
            raw: buildOpenClawRaw(parsed),
        };
    }

    // custom events
    if (type === "custom") {
        const customType = normalizeWhitespace(parsed.customType || "custom");
        if (customType === "openclaw.cache-ttl") return null;

        let message = `Custom event: ${customType}`;
        if (customType === "model-snapshot" && parsed.data && typeof parsed.data === "object") {
            const provider = normalizeWhitespace(parsed.data.provider || "");
            const modelId = normalizeWhitespace(parsed.data.modelId || "");
            const modelApi = normalizeWhitespace(parsed.data.modelApi || "");
            const details = [provider, modelId].filter(Boolean).join("/");
            message = `Model snapshot${details ? `: ${details}` : ""}${modelApi ? ` (${modelApi})` : ""}`;
        }

        return {
            sessionId,
            eventType: `openclaw.custom.${customType || "custom"}`,
            kind: "system",
            timestamp,
            message: toMessage(message),
            raw: buildOpenClawRaw(parsed),
        };
    }

    // compaction
    if (type === "compaction") {
        return {
            sessionId,
            eventType: "openclaw.compaction",
            kind: "system",
            timestamp,
            message: toMessage("Session compaction summary updated"),
            raw: buildOpenClawRaw(parsed),
        };
    }

    // branch summary
    if (type === "branch_summary") {
        const summary = normalizeWhitespace(parsed.summary || "");
        return {
            sessionId,
            eventType: "openclaw.branch_summary",
            kind: "system",
            timestamp,
            message: toMessage(summary || "Branch summary updated"),
            raw: buildOpenClawRaw(parsed),
        };
    }

    if (type !== "message" && type !== "custom_message") return null;

    // user/assistant messages
    const eventMessage = parsed.message ?? {};
    const role = String(eventMessage.role ?? "").toLowerCase();

    if (role === "user" || role === "assistant") {
        const text = extractOpenClawTextContent(eventMessage.content);
        if (text) {
            return {
                sessionId,
                eventType: `openclaw.${role}`,
                kind: role === "user" ? "user" : "assistant",
                timestamp,
                message: toMessage(text),
                raw: buildOpenClawRaw(parsed),
            };
        }

        // assistant tool calls without text
        if (role === "assistant") {
            const toolCalls = extractOpenClawToolCalls(eventMessage.content);
            if (toolCalls.length > 0) {
                const list = toolCalls.slice(0, 5).join(", ");
                const suffix = toolCalls.length > 5 ? ` (+${toolCalls.length - 5})` : "";
                return {
                    sessionId,
                    eventType: "openclaw.assistant.tool_use",
                    kind: "system",
                    timestamp,
                    message: toMessage(`Assistant requested tools: ${list}${suffix}`),
                    raw: buildOpenClawRaw(parsed),
                };
            }
        }

        return null;
    }

    // tool results
    if (role === "toolresult") {
        const toolName = normalizeWhitespace(eventMessage.toolName || "");
        const isError = Boolean(eventMessage.isError);
        let message = `Tool result${toolName ? `: ${toolName}` : ""} (${isError ? "error" : "ok"})`;
        const text = extractOpenClawTextContent(eventMessage.content);
        if (text) message = `${message} ${truncateString(text, 320)}`;

        return {
            sessionId,
            eventType: "openclaw.tool_result",
            kind: "system",
            timestamp,
            message: toMessage(message),
            raw: buildOpenClawRaw(parsed),
        };
    }

    return null;
}
