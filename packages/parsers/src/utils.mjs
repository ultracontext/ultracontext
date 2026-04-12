import os from "node:os";
import path from "node:path";

// resolve ~ to home directory
export function expandHome(inputPath) {
    if (!inputPath || !inputPath.startsWith("~")) return inputPath;
    if (inputPath === "~") return os.homedir();
    if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
    return inputPath;
}

// safe truncation with indicator
export function truncateString(value, maxLen = 4000) {
    if (typeof value !== "string") return value;
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}... [truncated ${value.length - maxLen} chars]`;
}

// swallow malformed JSON
export function safeJsonParse(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

// pull UUID from file path, fall back to filename
export function extractSessionIdFromPath(filePath) {
    const uuidMatch = filePath.match(
        /([0-9a-f]{8}-[0-9a-f]{4,}-[0-9a-f]{4,}-[0-9a-f]{4,}-[0-9a-f]{8,})/i
    );
    if (uuidMatch) return uuidMatch[1];

    const fileName = path.basename(filePath, ".jsonl");
    return fileName || "unknown-session";
}

// normalize role strings across agents
export function normalizeRole(role, fallback = "system") {
    const lowered = String(role ?? "").toLowerCase();
    if (["user", "human"].includes(lowered)) return "user";
    if (["assistant", "agent", "ai"].includes(lowered)) return "assistant";
    return fallback;
}

// collapse whitespace to single spaces
export function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

// preserve newlines, trim lines, collapse 3+ blank lines → 2
export function preserveText(value) {
    return String(value ?? "")
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// coerce message content to string
export function toMessage(raw, maxLen = 12000) {
    if (!raw) return "";
    if (typeof raw === "string") return truncateString(raw, maxLen);
    if (typeof raw === "object") return truncateString(JSON.stringify(raw), maxLen);
    return truncateString(String(raw), maxLen);
}

// coerce message content to plain text
export function coerceMessageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (content && typeof content === "object") {
        if (typeof content.message === "string") return content.message;
        if (typeof content.text === "string") return content.text;
        if (typeof content.raw === "string") return content.raw;
    }
    if (typeof message?.message === "string") return message.message;
    return "";
}

// get timestamp from first message
export function firstMessageTimestamp(messages) {
    return (
        messages?.[0]?.content?.timestamp ??
        messages?.[0]?.metadata?.timestamp ??
        new Date().toISOString()
    );
}

// coerce ISO timestamp, fall back to now
export function asIso(value) {
    if (!value) return new Date().toISOString();
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
}
