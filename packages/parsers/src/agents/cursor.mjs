import { safeJsonParse, stripIDEContextTags } from "../utils.mjs";
import { parseClaudeCodeLine } from "./claude.mjs";

// parse a single JSONL line from a Cursor session file
// Cursor format is nearly identical to Claude Code, but uses "role" instead of "type"
export function parseCursorLine({ line, filePath }) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") return null;

  // normalize: Cursor uses "role" where Claude uses "type"
  if (!parsed.type && parsed.role) {
    parsed.type = parsed.role;
  }

  // delegate to Claude parser with re-serialized line
  const result = parseClaudeCodeLine({ line: JSON.stringify(parsed), filePath });
  if (!result) return null;

  // re-namespace event types: claude.* -> cursor.*
  result.eventType = result.eventType.replace(/^claude\./, "cursor.");

  // strip Cursor's <user_query> tags and other IDE context from user messages
  if (result.kind === "user" && result.message) {
    result.message = stripIDEContextTags(result.message);
  }

  return result;
}
