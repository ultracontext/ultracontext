import crypto from "node:crypto";

// shared utils from harness
export { expandHome, truncateString, safeJsonParse, extractSessionIdFromPath } from "@ultracontext/parsers/utils";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
