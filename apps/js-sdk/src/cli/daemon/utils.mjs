import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function expandHome(inputPath) {
  if (!inputPath || !inputPath.startsWith("~")) return inputPath;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function boolFromEnv(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function truncateString(value, maxLen = 4000) {
  if (typeof value !== "string") return value;
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}... [truncated ${value.length - maxLen} chars]`;
}

export function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function extractSessionIdFromPath(filePath) {
  const uuidMatch = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4,}-[0-9a-f]{4,}-[0-9a-f]{4,}-[0-9a-f]{8,})/i
  );
  if (uuidMatch) return uuidMatch[1];

  const fileName = path.basename(filePath, ".jsonl");
  return fileName || "unknown-session";
}
