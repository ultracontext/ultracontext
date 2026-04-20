import {
    extractSessionIdFromPath,
    normalizeRole,
    normalizeWhitespace,
    preserveText,
    safeJsonParse,
    toMessage,
    truncateString,
} from "../utils.mjs";

// format a tool_use block into a readable string
function formatToolUse(item) {
    const name = (item.name ?? "unknown").toLowerCase();
    const input = item.input ?? {};
    const filePath = input.file_path ?? input.path ?? "";

    if (name === "write") {
        const content = preserveText(input.content ?? input.file_text ?? "");
        return `[Write] ${filePath}\n${content}`;
    }

    if (name === "edit") {
        const parts = [`[Edit] ${filePath}`];
        if (input.old_string) parts.push(`- ${preserveText(input.old_string)}`);
        if (input.new_string) parts.push(`+ ${preserveText(input.new_string)}`);
        return parts.join("\n");
    }

    if (name === "read") return `[Read] ${filePath}`;
    if (name === "bash") return `[Bash] ${preserveText(input.command ?? "")}`;

    // grep and glob share the same shape
    if (name === "grep" || name === "glob") {
        const loc = filePath ? ` in ${filePath}` : "";
        return `[${item.name}] ${input.pattern ?? ""}${loc}`;
    }

    // generic fallback
    const compact = JSON.stringify(input);
    return `[${item.name ?? name}] ${compact.length > 500 ? compact.slice(0, 500) + "..." : compact}`;
}

// format a tool_result block into a readable string
function formatToolResult(item) {
    const content = item.content ?? "";

    if (typeof content === "string") {
        const text = preserveText(content);
        return text ? `[result] ${truncateString(text, 1000)}` : "[result] ok";
    }

    if (Array.isArray(content)) {
        const text = content
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => preserveText(c.text))
            .filter(Boolean)
            .join("\n");
        return text ? `[result] ${truncateString(text, 1000)}` : "[result] ok";
    }

    return "[result] ok";
}

// extract text content from Claude Code's message.content (string, array, or object)
export function extractClaudeTextContent(content) {
    if (!content) return "";
    if (typeof content === "string") return preserveText(content);

    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (!item || typeof item !== "object") continue;
            if (item.type === "text" && typeof item.text === "string") {
                const chunk = preserveText(item.text);
                if (chunk) parts.push(chunk);
            }
            if (item.type === "thinking" && typeof item.thinking === "string") {
                const chunk = preserveText(item.thinking);
                if (chunk) parts.push(`[thinking] ${chunk}`);
            }
            if (item.type === "tool_use") parts.push(formatToolUse(item));
            if (item.type === "tool_result") parts.push(formatToolResult(item));
        }
        return parts.join("\n\n");
    }

    if (typeof content === "object") {
        if (typeof content.text === "string") return preserveText(content.text);
        if (typeof content.content === "string") return preserveText(content.content);
    }

    return "";
}

// parse a single JSONL line from a Claude Code session file
export function parseClaudeCodeLine({ line, filePath }) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") return null;

    const type = String(parsed.type ?? "").toLowerCase();
    const sessionId =
        parsed.sessionId ??
        parsed.session_id ??
        parsed.payload?.sessionId ??
        parsed.payload?.session_id ??
        extractSessionIdFromPath(filePath);
    const timestamp = parsed.timestamp ?? parsed.ts ?? new Date().toISOString();

    // summary entries
    if (type === "summary") {
        const summary = normalizeWhitespace(parsed.summary);
        if (!summary) return null;
        return {
            sessionId,
            eventType: "claude.summary",
            kind: "system",
            timestamp,
            message: toMessage(summary),
            raw: parsed,
        };
    }

    // file history snapshots
    if (type === "file-history-snapshot") {
        const trackedFiles = Object.keys(parsed.snapshot?.trackedFileBackups ?? {}).length;
        const label = parsed.isSnapshotUpdate ? "File snapshot update" : "File snapshot";
        const message = `${label}: ${trackedFiles} tracked files`;
        return {
            sessionId,
            eventType: "claude.file_snapshot",
            kind: "system",
            timestamp,
            message: toMessage(message),
            raw: parsed,
        };
    }

    // system entries (local_command, stop_hook_summary, turn_duration, etc.)
    if (type === "system") {
        const subtype = parsed.subtype ?? "unknown";
        let message;

        if (subtype === "local_command") {
            message = parsed.content ? preserveText(parsed.content) : "Local command executed";
        } else if (subtype === "stop_hook_summary") {
            message = `Hook summary: ${parsed.hookCount ?? 0} hooks`;
        } else if (subtype === "turn_duration") {
            message = `Turn completed in ${parsed.durationMs ?? 0}ms (${parsed.messageCount ?? 0} messages)`;
        } else {
            message = `System event: ${subtype}`;
        }

        if (!message) return null;
        return {
            sessionId,
            eventType: `claude.system.${subtype}`,
            kind: "system",
            timestamp,
            message: toMessage(message),
            raw: parsed,
        };
    }

    // attachment entries (deferred_tools_delta, mcp_instructions_delta, etc.)
    if (type === "attachment") {
        const attachmentType = parsed.attachment?.type ?? "unknown";
        const parts = [];
        const added = parsed.attachment?.addedNames;
        const removed = parsed.attachment?.removedNames;
        if (Array.isArray(added) && added.length) parts.push(`added: ${added.join(", ")}`);
        if (Array.isArray(removed) && removed.length) parts.push(`removed: ${removed.join(", ")}`);
        const detail = parts.length ? ` (${parts.join("; ")})` : "";
        return {
            sessionId,
            eventType: `claude.attachment.${attachmentType}`,
            kind: "system",
            timestamp,
            message: toMessage(`Attachment: ${attachmentType}${detail}`),
            raw: parsed,
        };
    }

    // progress entries (hook_progress, etc.)
    if (type === "progress") {
        const data = parsed.data ?? {};
        const subtype = data.type ?? "unknown";
        const label = data.hookName ?? subtype;
        return {
            sessionId,
            eventType: `claude.progress.${subtype}`,
            kind: "system",
            timestamp,
            message: toMessage(`Progress: ${subtype} (${label})`),
            raw: parsed,
        };
    }

    // queue operation entries (enqueue, dequeue, etc.)
    if (type === "queue-operation") {
        const operation = parsed.operation ?? "unknown";
        const content = parsed.content ? `: ${parsed.content}` : "";
        return {
            sessionId,
            eventType: "claude.queue_operation",
            kind: "system",
            timestamp,
            message: toMessage(`Queue ${operation}${content}`),
            raw: parsed,
        };
    }

    // custom title entries
    if (type === "custom-title") {
        const customTitle = parsed.customTitle ?? "unknown";
        return {
            sessionId,
            eventType: "claude.custom_title",
            kind: "system",
            timestamp,
            message: toMessage(`Custom title: ${customTitle}`),
            raw: parsed,
        };
    }

    // agent name entries
    if (type === "agent-name") {
        const agentName = parsed.agentName ?? "unknown";
        return {
            sessionId,
            eventType: "claude.agent_name",
            kind: "system",
            timestamp,
            message: toMessage(`Agent name: ${agentName}`),
            raw: parsed,
        };
    }

    // PR link entries
    if (type === "pr-link") {
        const prNumber = parsed.prNumber ?? 0;
        const prUrl = parsed.prUrl ?? "";
        return {
            sessionId,
            eventType: "claude.pr_link",
            kind: "system",
            timestamp,
            message: toMessage(`PR #${prNumber}: ${prUrl}`),
            raw: parsed,
        };
    }

    // permission mode changes
    if (type === "permission-mode") {
        return {
            sessionId,
            eventType: "claude.permission_mode",
            kind: "system",
            timestamp,
            message: toMessage(`Permission mode: ${parsed.permissionMode ?? "unknown"}`),
            raw: parsed,
        };
    }

    // last user prompt captured by the session
    if (type === "last-prompt") {
        const prompt = parsed.lastPrompt ?? "";
        if (!prompt) return null;
        return {
            sessionId,
            eventType: "claude.last_prompt",
            kind: "system",
            timestamp,
            message: toMessage(prompt),
            raw: parsed,
        };
    }

    // AI-generated session title
    if (type === "ai-title") {
        return {
            sessionId,
            eventType: "claude.ai_title",
            kind: "system",
            timestamp,
            message: toMessage(`AI title: ${parsed.aiTitle ?? "unknown"}`),
            raw: parsed,
        };
    }

    // periodic task summary (fork-generated, every min(5 steps, 2min))
    if (type === "task-summary") {
        return {
            sessionId,
            eventType: "claude.task_summary",
            kind: "system",
            timestamp,
            message: toMessage(parsed.summary ?? "[task summary]"),
            raw: parsed,
        };
    }

    // session tag for searchability
    if (type === "tag") {
        return {
            sessionId,
            eventType: "claude.tag",
            kind: "system",
            timestamp,
            message: toMessage(`Tag: ${parsed.tag ?? ""}`),
            raw: parsed,
        };
    }

    // agent color assignment (from /rename or swarm)
    if (type === "agent-color") {
        return {
            sessionId,
            eventType: "claude.agent_color",
            kind: "system",
            timestamp,
            message: toMessage(`Agent color: ${parsed.agentColor ?? "unknown"}`),
            raw: parsed,
        };
    }

    // agent setting/definition (from --agent flag)
    if (type === "agent-setting") {
        return {
            sessionId,
            eventType: "claude.agent_setting",
            kind: "system",
            timestamp,
            message: toMessage(`Agent setting: ${parsed.agentSetting ?? "unknown"}`),
            raw: parsed,
        };
    }

    // session mode (coordinator/normal)
    if (type === "mode") {
        return {
            sessionId,
            eventType: "claude.mode",
            kind: "system",
            timestamp,
            message: toMessage(`Mode: ${parsed.mode ?? "unknown"}`),
            raw: parsed,
        };
    }

    // worktree session state
    if (type === "worktree-state") {
        const ws = parsed.worktreeSession;
        const label = ws ? `entered ${ws.worktreePath ?? ""}` : "exited";
        return {
            sessionId,
            eventType: "claude.worktree_state",
            kind: "system",
            timestamp,
            message: toMessage(`Worktree: ${label}`),
            raw: parsed,
        };
    }

    // file attribution snapshot (character-level contribution tracking)
    if (type === "attribution-snapshot") {
        const fileCount = Object.keys(parsed.fileStates ?? {}).length;
        return {
            sessionId,
            eventType: "claude.attribution_snapshot",
            kind: "system",
            timestamp,
            message: toMessage(`Attribution snapshot: ${fileCount} files`),
            raw: parsed,
        };
    }

    // content replacement stubs (replayed on resume for prompt cache stability)
    if (type === "content-replacement") {
        const count = parsed.replacements?.length ?? 0;
        return {
            sessionId,
            eventType: "claude.content_replacement",
            kind: "system",
            timestamp,
            message: toMessage(`Content replacement: ${count} blocks`),
            raw: parsed,
        };
    }

    // speculation accept (speculative execution savings)
    if (type === "speculation-accept") {
        return {
            sessionId,
            eventType: "claude.speculation_accept",
            kind: "system",
            timestamp,
            message: toMessage(`Speculation accepted: saved ${parsed.timeSavedMs ?? 0}ms`),
            raw: parsed,
        };
    }

    // context collapse commit (marble-origami)
    if (type === "marble-origami-commit") {
        return {
            sessionId,
            eventType: "claude.context_collapse_commit",
            kind: "system",
            timestamp,
            message: toMessage(parsed.summary ?? `Context collapse: ${parsed.collapseId ?? ""}`),
            raw: parsed,
        };
    }

    // context collapse snapshot (marble-origami staged queue)
    if (type === "marble-origami-snapshot") {
        const stagedCount = parsed.staged?.length ?? 0;
        return {
            sessionId,
            eventType: "claude.context_collapse_snapshot",
            kind: "system",
            timestamp,
            message: toMessage(`Context collapse snapshot: ${stagedCount} staged`),
            raw: parsed,
        };
    }

    if (type !== "user" && type !== "assistant") return null;

    // user/assistant messages
    const rawContent =
        parsed.message?.content ??
        parsed.message ??
        parsed.content ??
        parsed.payload?.content ??
        "";
    let message = extractClaudeTextContent(rawContent);

    // thinking-only entries have redacted content — preserve them as system events
    if (!message) {
        const hasThinking = Array.isArray(rawContent) && rawContent.some((c) => c?.type === "thinking");
        if (!hasThinking) return null;
        message = "[thinking]";
    }

    const roleHint = parsed.message?.role ?? type;
    return {
        sessionId,
        eventType: `claude.${type}`,
        kind: normalizeRole(roleHint, type === "user" ? "user" : "assistant"),
        timestamp,
        message: toMessage(message),
        raw: parsed,
    };
}
