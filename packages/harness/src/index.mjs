// shared utils
export { expandHome, truncateString, safeJsonParse, extractSessionIdFromPath } from "./utils.mjs";

// parsers: agent JSONL → UltraContext
export { parseClaudeCodeLine, extractClaudeTextContent } from "./parsers/claude.mjs";
export { parseCodexLine } from "./parsers/codex.mjs";
export { parseOpenClawLine } from "./parsers/openclaw.mjs";
export { parseGstackLine } from "./parsers/gstack.mjs";
export { parseGenericJsonlLine } from "./parsers/generic.mjs";

// writers: UltraContext → agent JSONL
export { writeClaudeSession, hasLocalClaudeSession } from "./writers/claude.mjs";
export { writeCodexSession, hasLocalCodexSession } from "./writers/codex.mjs";

// compatibility matrix
export { AGENT_COMPAT, isResumePairTested, getTestedVersions } from "./compat.mjs";
