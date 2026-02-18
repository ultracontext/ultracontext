import { extractSessionIdFromPath, safeJsonParse, truncateString } from "./utils.mjs";

function normalizeKind(kind, fallback = "system") {
  const lowered = String(kind ?? "").toLowerCase();
  if (["user", "human"].includes(lowered)) return "user";
  if (["assistant", "agent", "ai"].includes(lowered)) return "assistant";
  return fallback;
}

function toMessage(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return truncateString(raw, 3000);
  if (typeof raw === "object") return truncateString(JSON.stringify(raw), 3000);
  return truncateString(String(raw), 3000);
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function extractClaudeTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return normalizeWhitespace(content);

  if (Array.isArray(content)) {
    const textParts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      // Keep only explicit natural-language text. Skip tool_use/tool_result/thinking noise.
      if (item.type === "text" && typeof item.text === "string") {
        const chunk = normalizeWhitespace(item.text);
        if (chunk) textParts.push(chunk);
      }
    }
    return textParts.join("\n");
  }

  if (typeof content === "object") {
    if (typeof content.text === "string") return normalizeWhitespace(content.text);
    if (typeof content.content === "string") return normalizeWhitespace(content.content);
  }

  return "";
}

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

export function parseCodexLine({ line, filePath }) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") return null;

  const payload = parsed.payload ?? {};
  const sessionId =
    payload.session_id ??
    payload.id ??
    parsed.session_id ??
    extractSessionIdFromPath(filePath);

  if (parsed.type === "event_msg") {
    const eventType = payload.type ?? "unknown";
    if (!["user_message", "agent_message", "task_started", "task_complete"].includes(eventType)) {
      return null;
    }

    const kind = eventType === "user_message" ? "user" : eventType === "agent_message" ? "assistant" : "system";
    const message =
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

  return null;
}

export function parseClaudeCodeLine({ line, filePath }) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") return null;

  const type = String(parsed.type ?? "").toLowerCase();
  const sessionId =
    parsed.sessionId ??
    parsed.session_id ??
    parsed.payload?.sessionId ??
    parsed.payload?.session_id ??
    extractSessionIdFromPath(filePath);
  const timestamp = parsed.timestamp ?? parsed.ts ?? new Date().toISOString();

  if (type === "summary") {
    const summary = normalizeWhitespace(parsed.summary);
    if (!summary) return null;
    return {
      sessionId,
      eventType: "claude.summary",
      kind: "system",
      timestamp,
      message: toMessage(summary),
      raw: parsed,
    };
  }

  if (type !== "user" && type !== "assistant") return null;

  const rawContent =
    parsed.message?.content ??
    parsed.message ??
    parsed.content ??
    parsed.payload?.content ??
    "";
  const message = extractClaudeTextContent(rawContent);
  if (!message) return null;

  const roleHint = parsed.message?.role ?? type;
  return {
    sessionId,
    eventType: `claude.${type}`,
    kind: normalizeKind(roleHint, type === "user" ? "user" : "assistant"),
    timestamp,
    message: toMessage(message),
    raw: parsed,
  };
}

export function parseOpenClawLine({ line, filePath }) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") return null;

  const type = String(parsed.type ?? "").toLowerCase();
  const sessionId =
    parsed.session_id ??
    parsed.sessionId ??
    parsed.id ??
    parsed.message?.session_id ??
    parsed.message?.sessionId ??
    extractSessionIdFromPath(filePath);

  const timestamp = parsed.timestamp ?? parsed.message?.timestamp ?? new Date().toISOString();

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

export function parseGenericJsonlLine({ line, filePath, sourceName }) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") return null;

  const sessionId =
    parsed.session_id ??
    parsed.sessionId ??
    parsed.payload?.session_id ??
    parsed.payload?.id ??
    extractSessionIdFromPath(filePath);

  const role =
    parsed.role ??
    parsed.sender ??
    parsed.type ??
    parsed.payload?.role ??
    parsed.payload?.sender ??
    "system";

  const message =
    parsed.message ??
    parsed.text ??
    parsed.content ??
    parsed.payload?.message ??
    parsed.payload?.text ??
    parsed.payload?.content ??
    "";

  if (!message && !parsed.type) return null;

  return {
    sessionId,
    eventType: `${sourceName}.${parsed.type ?? "line"}`,
    kind: normalizeKind(role),
    timestamp: parsed.timestamp ?? parsed.ts ?? new Date().toISOString(),
    message: toMessage(message || parsed.type),
    raw: parsed,
  };
}
