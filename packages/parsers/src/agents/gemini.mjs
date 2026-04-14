import path from "node:path";
import { normalizeWhitespace, preserveText, safeJsonParse, toMessage, truncateString } from "../utils.mjs";

// file modification tool names for Gemini CLI
const FILE_MOD_TOOLS = ["write_file", "edit_file", "save_file", "replace"];

// multi-key fallback for file path extraction from tool args
const FILE_PATH_KEYS = ["file_path", "path", "filePath", "filename"];

// extract text from Gemini's polymorphic content field
// user messages: [{text: "..."}] (array), gemini messages: "string" (plain)
export function extractGeminiTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return preserveText(content);

  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string") {
        const chunk = preserveText(item.text);
        if (chunk) parts.push(chunk);
      }
    }
    return parts.join("\n");
  }

  if (typeof content === "object" && typeof content.text === "string") {
    return preserveText(content.text);
  }

  return "";
}

// format a single Gemini tool call into a readable string
function formatToolCall(tc) {
  const name = tc.name ?? "unknown";
  const args = tc.args ?? {};

  // extract file path with multi-key fallback
  let filePath = "";
  for (const key of FILE_PATH_KEYS) {
    if (typeof args[key] === "string" && args[key]) {
      filePath = args[key];
      break;
    }
  }

  // file modification tools get special formatting
  if (FILE_MOD_TOOLS.includes(name)) {
    const content = preserveText(args.content ?? args.file_text ?? args.new_content ?? "");
    if (content) return `[${name}] ${filePath}\n${truncateString(content, 500)}`;
    return `[${name}] ${filePath}`;
  }

  // generic tool formatting
  const compact = JSON.stringify(args);
  const detail = compact.length > 500 ? compact.slice(0, 500) + "..." : compact;
  return `[${name}]${filePath ? ` ${filePath}` : ""} ${detail}`;
}

// extract session ID from Gemini session filename
// pattern: session-<date>-<id>.json -> use <id> portion
function extractGeminiSessionId(filePath) {
  const base = path.basename(filePath, ".json");
  const match = base.match(/session-[\d-]+-(.+)$/);
  if (match) return match[1];

  // fallback: use full filename without extension
  return base || "unknown-session";
}

// extract timestamp from Gemini session filename
// pattern: session-YYYYMMDD-<id>.json
function extractGeminiTimestamp(filePath) {
  const base = path.basename(filePath, ".json");
  const match = base.match(/session-(\d{4})(\d{2})(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  return new Date().toISOString();
}

// parse an entire Gemini CLI session file (JSON, not JSONL)
// returns array of normalized events
export function parseGeminiFile({ fileContents, filePath }) {
  const parsed = safeJsonParse(fileContents);
  if (!parsed || typeof parsed !== "object") return [];

  const messages = parsed.messages;
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const sessionId = extractGeminiSessionId(filePath);
  const fileTimestamp = extractGeminiTimestamp(filePath);
  const events = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    const type = String(msg.type ?? "").toLowerCase();
    const isUser = type === "user";
    const isGemini = type === "gemini";
    if (!isUser && !isGemini) continue;

    // extract text content
    const text = extractGeminiTextContent(msg.content);

    // format tool calls (gemini messages only)
    const toolCallTexts = [];
    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        toolCallTexts.push(formatToolCall(tc));
      }
    }

    // build message: text + tool calls
    const parts = [];
    if (text) parts.push(text);
    if (toolCallTexts.length) parts.push(toolCallTexts.join("\n\n"));
    const message = parts.join("\n\n");
    if (!message) continue;

    events.push({
      sessionId,
      eventType: isUser ? "gemini.user" : "gemini.assistant",
      kind: isUser ? "user" : "assistant",
      timestamp: msg.timestamp ?? fileTimestamp,
      message: toMessage(message),
      raw: {
        type: msg.type,
        id: msg.id,
        index: i,
        hasToolCalls: toolCallTexts.length > 0,
        toolCallCount: toolCallTexts.length,
      },
    });
  }

  return events;
}
