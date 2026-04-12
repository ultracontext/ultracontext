import { extractSessionIdFromPath, normalizeRole, safeJsonParse, toMessage } from "./utils.mjs";

// parse a generic JSONL line (best-effort for unknown agents)
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
        kind: normalizeRole(role),
        timestamp: parsed.timestamp ?? parsed.ts ?? new Date().toISOString(),
        message: toMessage(message || parsed.type),
        raw: parsed,
    };
}
