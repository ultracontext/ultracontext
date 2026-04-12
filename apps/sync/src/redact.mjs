import { truncateString } from "./utils.mjs";

const REDACTED = "***REDACTED***";

const SENSITIVE_KEY_REGEX = /(token|secret|password|api[-_]?key|authorization|cookie|session[-_]?key)/i;

const SECRET_PATTERNS = [
  { regex: /\buc_(live|test)_[A-Za-z0-9_-]+\b/g, replacement: "uc_$1_***" },
  { regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "sk-***" },
  { regex: /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, replacement: "Bearer ***" },
  {
    regex: /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
    replacement: "AIza***",
  },
];

function redactString(value) {
  let output = truncateString(value, 8000);
  for (const { regex, replacement } of SECRET_PATTERNS) {
    output = output.replace(regex, replacement);
  }
  return output;
}

export function redact(value, currentKey = "") {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return SENSITIVE_KEY_REGEX.test(currentKey) ? REDACTED : redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_REGEX.test(key) ? REDACTED : redact(raw, key);
    }
    return out;
  }

  return REDACTED;
}
