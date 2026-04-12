import { extractSessionIdFromPath, normalizeRole, safeJsonParse, toMessage } from "../utils.mjs";

// parse a single JSONL line from a Codex session file
export function parseCodexLine({ line, filePath }) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") return null;

    const payload = parsed.payload ?? {};
    const sessionId =
        payload.session_id ??
        payload.id ??
        parsed.session_id ??
        extractSessionIdFromPath(filePath);

    // event messages (user/agent/task)
    if (parsed.type === "event_msg") {
        const eventType = payload.type ?? "unknown";
        if (!["user_message", "agent_message", "task_started", "task_complete", "token_count", "agent_reasoning", "turn_aborted", "context_compacted"].includes(eventType)) {
            return null;
        }

        // resolve kind based on event subtype
        const kind =
            eventType === "user_message" ? "user" :
            eventType === "agent_message" ? "assistant" :
            "system";

        // resolve message based on event subtype
        const message =
            eventType === "token_count" ? "Token count update" :
            eventType === "agent_reasoning" ? payload.text :
            eventType === "turn_aborted" ? (payload.reason ? `Turn aborted: ${payload.reason}` : "Turn aborted") :
            eventType === "context_compacted" ? "Context compacted" :
            payload.message ??
            payload.last_agent_message ??
            `${eventType}${payload.turn_id ? ` (${payload.turn_id})` : ""}`;

        return {
            sessionId,
            eventType: `event_msg.${eventType}`,
            kind,
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            message: toMessage(message),
            raw: parsed,
        };
    }

    // session metadata
    if (parsed.type === "session_meta") {
        return {
            sessionId,
            eventType: "session_meta",
            kind: "system",
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            message: `Session started in ${payload.cwd ?? "unknown cwd"}`,
            raw: parsed,
        };
    }

    // response items (message, reasoning, function calls)
    if (parsed.type === "response_item") {
        const subtype = payload.type;
        const ts = parsed.timestamp ?? new Date().toISOString();

        // assistant/user/developer messages
        if (subtype === "message") {
            const text = (payload.content ?? [])
                .map((c) => c.text ?? "")
                .filter(Boolean)
                .join("\n");
            const roleMap = { developer: "system", assistant: "assistant", user: "user" };
            const kind = roleMap[payload.role] ?? normalizeRole(payload.role);

            return {
                sessionId,
                eventType: "response_item.message",
                kind,
                timestamp: ts,
                message: toMessage(text || `[${payload.role ?? "unknown"} message]`),
                raw: parsed,
            };
        }

        // reasoning summaries
        if (subtype === "reasoning") {
            const text = (payload.summary ?? [])
                .map((s) => s.text ?? "")
                .filter(Boolean)
                .join("\n");

            return {
                sessionId,
                eventType: "response_item.reasoning",
                kind: "system",
                timestamp: ts,
                message: toMessage(text || "[reasoning]"),
                raw: parsed,
            };
        }

        // tool invocations
        if (subtype === "function_call") {
            const msg = `[${payload.name ?? "unknown"}] ${payload.arguments ?? ""}`;

            return {
                sessionId,
                eventType: "response_item.function_call",
                kind: "system",
                timestamp: ts,
                message: toMessage(msg),
                raw: parsed,
            };
        }

        // tool outputs
        if (subtype === "function_call_output") {
            return {
                sessionId,
                eventType: "response_item.function_call_output",
                kind: "system",
                timestamp: ts,
                message: toMessage(payload.output ?? `[output ${payload.call_id ?? ""}]`),
                raw: parsed,
            };
        }

        // web search invocations
        if (subtype === "web_search_call") {
            const query = payload.action?.query;
            return {
                sessionId,
                eventType: "response_item.web_search_call",
                kind: "system",
                timestamp: ts,
                message: query ? `[web_search] ${query}` : "[web_search]",
                raw: parsed,
            };
        }

        // custom tool invocations (e.g. apply_patch)
        if (subtype === "custom_tool_call") {
            const msg = `[${payload.name ?? "unknown"}] ${payload.input ?? ""}`;
            return {
                sessionId,
                eventType: "response_item.custom_tool_call",
                kind: "system",
                timestamp: ts,
                message: toMessage(msg),
                raw: parsed,
            };
        }

        // custom tool outputs
        if (subtype === "custom_tool_call_output") {
            return {
                sessionId,
                eventType: "response_item.custom_tool_call_output",
                kind: "system",
                timestamp: ts,
                message: toMessage(payload.output ?? `[output ${payload.call_id ?? ""}]`),
                raw: parsed,
            };
        }

        // unknown response_item subtype
        return null;
    }

    // session compacted (context window reset)
    if (parsed.type === "compacted") {
        return {
            sessionId,
            eventType: "compacted",
            kind: "system",
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            message: "Session compacted",
            raw: parsed,
        };
    }

    // turn context (model, policies, cwd)
    if (parsed.type === "turn_context") {
        return {
            sessionId,
            eventType: "turn_context",
            kind: "system",
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            message: `Turn context: model=${payload.model}, policy=${payload.approval_policy}`,
            raw: parsed,
        };
    }

    return null;
}
