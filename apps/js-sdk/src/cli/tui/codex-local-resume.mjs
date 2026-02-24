import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import fg from "fast-glob";

import { expandHome } from "./utils.mjs";

function asIso(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function coerceMessageText(message) {
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

function normalizeRole(role) {
  const lowered = String(role ?? "").toLowerCase();
  if (["user", "human"].includes(lowered)) return "user";
  if (["assistant", "agent", "ai"].includes(lowered)) return "assistant";
  return "system";
}

function firstMessageTimestamp(messages) {
  return (
    messages?.[0]?.content?.timestamp ??
    messages?.[0]?.metadata?.timestamp ??
    new Date().toISOString()
  );
}

function buildEventMsgLine(message, fallbackTs) {
  const ts = asIso(message?.content?.timestamp ?? message?.metadata?.timestamp ?? fallbackTs);
  const role = normalizeRole(message?.role);
  const text = coerceMessageText(message).trim();
  if (!text) return null;

  if (role === "user") {
    return {
      timestamp: ts,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: text,
        images: [],
        local_images: [],
        text_elements: [],
      },
    };
  }

  if (role === "assistant") {
    return {
      timestamp: ts,
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: text,
      },
    };
  }

  // Keep system events visible without pretending they are user input.
  return {
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "agent_message",
      message: `[system] ${text}`,
    },
  };
}

function sessionFilePath(sessionId, firstTimestamp) {
  const iso = asIso(firstTimestamp);
  const [year, month, day] = iso.slice(0, 10).split("-");
  const stamp = iso.replace(/\.\d{3}Z$/, "").replace(/:/g, "-").replace("Z", "");
  const baseDir = expandHome("~/.codex/sessions");
  const fileName = `rollout-${stamp}-${sessionId}.jsonl`;
  return path.join(baseDir, year, month, day, fileName);
}

export async function hasLocalCodexSession(sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id) return false;
  const pattern = expandHome(`~/.codex/sessions/**/*${id}*.jsonl`);
  const files = await fg([pattern], {
    onlyFiles: true,
    absolute: true,
    unique: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  return files.some((filePath) => filePath.includes(id));
}

export async function materializeCodexSession({ sessionId, cwd, messages }) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    return { written: false, reason: "missing_session_id", filePath: "" };
  }

  if (await hasLocalCodexSession(id)) {
    return { written: false, reason: "already_exists", filePath: "" };
  }

  const firstMessageTs = firstMessageTimestamp(messages);
  const firstTs = asIso(firstMessageTs);
  const filePath = sessionFilePath(id, firstTs);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const lines = [];
    lines.push(
      JSON.stringify({
        timestamp: firstTs,
        type: "session_meta",
        payload: {
          id,
          timestamp: firstTs,
          cwd: cwd || process.cwd(),
          originator: "ultracontext_daemon",
          cli_version: "restored",
          source: "cli",
          model_provider: "openai",
        },
      })
    );

    let emitted = 0;
    for (let i = 0; i < (messages?.length ?? 0); i += 1) {
      const fallbackTs = new Date(new Date(firstTs).getTime() + i * 1000).toISOString();
      const line = buildEventMsgLine(messages[i], fallbackTs);
      if (!line) continue;
      lines.push(JSON.stringify(line));
      emitted += 1;
    }

    if (emitted === 0) {
      lines.push(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "[system] Session restored from UltraContext with no user/assistant messages.",
          },
        })
      );
    }

    await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
    return { written: true, reason: "created", filePath };
  } catch (error) {
    return {
      written: false,
      reason: "write_failed",
      filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? "").trim()
  );
}

function normalizeSessionUuid(raw) {
  const value = String(raw ?? "").trim();
  if (isUuid(value)) return value;
  return randomUUID();
}

function claudeProjectDirName(cwd) {
  const resolved = path.resolve(String(cwd || process.cwd()));
  return resolved.replace(/[\\/]/g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

function claudeSessionFilePath(sessionId, cwd) {
  const baseDir = expandHome("~/.claude/projects");
  return path.join(baseDir, claudeProjectDirName(cwd), `${sessionId}.jsonl`);
}

export async function hasLocalClaudeSession(sessionId, cwd = "") {
  const id = String(sessionId ?? "").trim();
  if (!id) return false;

  const preferredPath = claudeSessionFilePath(id, cwd || process.cwd());
  try {
    const stat = await fs.stat(preferredPath);
    if (stat.isFile()) return true;
  } catch {
    // Fall through to glob lookup.
  }

  const pattern = expandHome(`~/.claude/projects/**/*${id}.jsonl`);
  const files = await fg([pattern], {
    onlyFiles: true,
    absolute: true,
    unique: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  return files.some((filePath) => path.basename(filePath, ".jsonl") === id);
}

export async function materializeClaudeSession({ sessionId, cwd, messages }) {
  const runCwd = String(cwd || process.cwd());
  const resolvedSessionId = normalizeSessionUuid(sessionId);
  const firstTs = asIso(firstMessageTimestamp(messages));
  const filePath = claudeSessionFilePath(resolvedSessionId, runCwd);

  if (await hasLocalClaudeSession(resolvedSessionId, runCwd)) {
    return {
      written: false,
      reason: "already_exists",
      filePath,
      sessionId: resolvedSessionId,
    };
  }

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const lines = [];
    let parentUuid = null;
    for (let i = 0; i < (messages?.length ?? 0); i += 1) {
      const message = messages[i];
      const normalizedRole = normalizeRole(message?.role);
      const role = normalizedRole === "assistant" ? "assistant" : normalizedRole === "user" ? "user" : "assistant";
      const rawText = coerceMessageText(message).trim();
      if (!rawText) continue;
      const text = normalizedRole === "system" ? `[system] ${rawText}` : rawText;
      const ts = asIso(
        message?.content?.timestamp ??
          message?.metadata?.timestamp ??
          new Date(new Date(firstTs).getTime() + i * 1000).toISOString()
      );
      const entryUuid = randomUUID();
      const entry = {
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd: runCwd,
        sessionId: resolvedSessionId,
        version: "adapter",
        gitBranch: "",
        type: role,
        message: {
          role,
          content: text,
        },
        timestamp: ts,
        uuid: entryUuid,
      };
      lines.push(JSON.stringify(entry));
      parentUuid = entryUuid;
    }

    if (lines.length === 0) {
      const entryUuid = randomUUID();
      lines.push(
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: "external",
          cwd: runCwd,
          sessionId: resolvedSessionId,
          version: "adapter",
          gitBranch: "",
          type: "assistant",
          message: {
            role: "assistant",
            content: "[system] Session restored from UltraContext with no user/assistant messages.",
          },
          timestamp: new Date().toISOString(),
          uuid: entryUuid,
        })
      );
    }

    await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
    return {
      written: true,
      reason: "created",
      filePath,
      sessionId: resolvedSessionId,
    };
  } catch (error) {
    return {
      written: false,
      reason: "write_failed",
      filePath,
      sessionId: resolvedSessionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
