// file modification tool names by agent
const FILE_MOD_TOOLS = {
  claude: ["Write", "Edit", "NotebookEdit", "WriteFile"],
  cursor: ["Write", "Edit", "NotebookEdit", "WriteFile"],
  gemini: ["write_file", "edit_file", "save_file", "replace"],
  codex: ["apply_patch"],
  openclaw: ["editFile", "writeFile", "createFile"],
};

// multi-key fallback for file path extraction
const FILE_PATH_KEYS = ["file_path", "path", "filePath", "filename", "notebook_path"];

// extract file path from a tool input/args object using multi-key fallback
function extractFilePath(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of FILE_PATH_KEYS) {
    const val = input[key];
    if (typeof val === "string" && val) return val;
  }
  return null;
}

// extract deduplicated modified file paths from parsed events
// works across all agent formats by inspecting raw content blocks
export function extractModifiedFiles(events, agent = "claude") {
  const tools = FILE_MOD_TOOLS[agent] ?? FILE_MOD_TOOLS.claude;
  const seen = new Set();
  const files = [];

  for (const event of events) {
    if (!event?.raw) continue;

    // Claude/Cursor: content blocks with tool_use type
    const content =
      event.raw?.message?.content ??
      event.raw?.content ??
      [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;

        // standard tool_use blocks (Claude, Cursor)
        if (block.type === "tool_use" && tools.includes(block.name)) {
          const fp = extractFilePath(block.input);
          if (fp && !seen.has(fp)) { seen.add(fp); files.push(fp); }
        }

        // Gemini tool calls
        if (block.type === "toolCall" && tools.includes(block.name)) {
          const fp = extractFilePath(block.args);
          if (fp && !seen.has(fp)) { seen.add(fp); files.push(fp); }
        }
      }
    }

    // Gemini: toolCalls array on raw message
    const toolCalls = event.raw?.toolCalls ?? event.raw?.message?.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        if (!tools.includes(tc.name)) continue;
        const fp = extractFilePath(tc.args);
        if (fp && !seen.has(fp)) { seen.add(fp); files.push(fp); }
      }
    }

    // Codex: function_call payloads
    const payload = event.raw?.payload;
    if (payload?.type === "function_call" && tools.includes(payload.name)) {
      const args = typeof payload.arguments === "string"
        ? (() => { try { return JSON.parse(payload.arguments); } catch { return null; } })()
        : payload.arguments;
      if (args) {
        const fp = extractFilePath(args);
        if (fp && !seen.has(fp)) { seen.add(fp); files.push(fp); }
      }
    }
  }

  return files;
}
