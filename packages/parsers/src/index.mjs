// shared utils
export { expandHome, truncateString, safeJsonParse, extractSessionIdFromPath, stripIDEContextTags } from "./utils.mjs";

// agent session parsers
export { parseClaudeCodeLine, extractClaudeTextContent } from "./agents/claude.mjs";
export { parseCodexLine } from "./agents/codex.mjs";
export { parseOpenClawLine } from "./agents/openclaw.mjs";
export { parseCursorLine } from "./agents/cursor.mjs";
export { parseGeminiFile, extractGeminiTextContent } from "./agents/gemini.mjs";

// tool artifact parsers
export { parseGstackLine } from "./gstack.mjs";
export { parseGenericJsonlLine } from "./generic.mjs";

// post-processing utilities
export { extractModifiedFiles } from "./extract-modified-files.mjs";
export { extractClaudeTokenUsage } from "./token-usage.mjs";

// writers: UltraContext → agent JSONL
export { writeClaudeSession, hasLocalClaudeSession } from "./writers/claude.mjs";
export { writeCodexSession, hasLocalCodexSession } from "./writers/codex.mjs";

// switch: cross-agent session portability
export { switchSession, readLocalSession } from "./switch.mjs";

// compatibility matrix
export { AGENT_COMPAT, isResumePairTested, getTestedVersions } from "./compat.mjs";
