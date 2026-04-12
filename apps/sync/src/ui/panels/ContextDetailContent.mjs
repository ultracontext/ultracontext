import React from "react";
import { Box, Text } from "ink";

import { compact, contextBadge, padElements } from "../format.mjs";

// ── role helpers ─────────────────────────────────────────────────

function roleColor(role) {
  if (role === "user") return "green";
  if (role === "assistant") return "blue";
  return "gray";
}

function normalizeRole(msg) {
  const role = String(msg?.role ?? "system").toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "agent") return "assistant";
  return "system";
}

// ── extract full message text (no truncation) ───────────────────

function messageText(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (typeof content.message === "string") return content.message;
    if (typeof content.text === "string") return content.text;
    return JSON.stringify(content, null, 2);
  }
  return "";
}

function messageTimestamp(msg) {
  const raw = msg?.content?.timestamp ?? msg?.metadata?.timestamp ?? "";
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 5);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ── wrap a single line respecting maxWidth ──────────────────────

function wrapLine(text, maxWidth) {
  if (!text) return [""];
  const width = Math.max(maxWidth, 10);
  const lines = [];
  let remaining = text;
  while (remaining.length > width) {
    lines.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  lines.push(remaining);
  return lines;
}

// ── build visual lines from messages ────────────────────────────

function buildMessageLines(messages, maxWidth) {
  const lines = [];
  const separatorWidth = Math.max(maxWidth, 10);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = normalizeRole(msg);
    const ts = messageTimestamp(msg);
    const fullText = messageText(msg);
    const color = roleColor(role);

    // separator: ── role · HH:MM ──────────
    const label = ts ? `${role} · ${ts}` : role;
    const labelPart = `── ${label} `;
    const fillLen = Math.max(separatorWidth - labelPart.length, 0);
    const fill = "─".repeat(fillLen);
    lines.push({ type: "separator", color, label: `${labelPart}${fill}`, msgIndex: i });

    // split by real newlines, wrap each, preserve structure
    const rawLines = (fullText || "(empty)").split(/\r?\n/);
    for (const rawLine of rawLines) {
      for (const wrapped of wrapLine(rawLine, maxWidth)) {
        lines.push({ type: "text", text: wrapped, msgIndex: i });
      }
    }

    // blank line between messages
    if (i < messages.length - 1) {
      lines.push({ type: "blank", msgIndex: i });
    }
  }

  return lines;
}

// ── main component ──────────────────────────────────────────────

export function ContextDetailContent({ snapshot, maxRows, maxCols }) {
  const dv = snapshot.detailView;
  const textWidth = Math.max((maxCols ?? 60) - 2, 20);
  const rows = [];
  const totalMsgs = dv.messages.length;

  const source = dv.contextMeta?.source ?? "unknown";
  const badge = contextBadge(source);

  // header placeholder (filled after scroll info is known)
  const headerIdx = 0;
  rows.push(null);
  rows.push(React.createElement(Text, { key: "detail-spacer" }, " "));

  // loading state
  if (dv.loading) {
    rows[headerIdx] = renderHeader({ badge, dv, scrollInfo: "loading..." });
    rows.push(React.createElement(Text, { key: "detail-loading", color: "yellow" }, "Loading messages..."));
    return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
  }

  // error state
  if (dv.error) {
    rows[headerIdx] = renderHeader({ badge, dv, scrollInfo: "error" });
    rows.push(React.createElement(Text, { key: "detail-error", color: "red" }, `Error: ${dv.error}`));
    return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
  }

  // empty state
  if (totalMsgs === 0) {
    rows[headerIdx] = renderHeader({ badge, dv, scrollInfo: "empty" });
    rows.push(React.createElement(Text, { key: "detail-empty", color: "gray" }, "No messages in this context."));
    return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
  }

  // build all visual lines
  const allLines = buildMessageLines(dv.messages, textWidth);
  const availableRows = Math.max(maxRows - rows.length, 1);

  // two-level scroll: ↑/↓ by message (scrollOffset), j/k by line (lineOffset)
  const targetMsg = Math.max(0, Math.min(dv.scrollOffset, totalMsgs - 1));
  let msgStartLine = 0;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].msgIndex === targetMsg) {
      msgStartLine = i;
      break;
    }
  }

  // apply fine line offset, clamped
  const maxScroll = Math.max(allLines.length - availableRows, 0);
  const startLine = Math.max(0, Math.min(msgStartLine + (dv.lineOffset ?? 0), maxScroll));

  // header with scroll info
  const msgLabel = `msg ${targetMsg + 1}/${totalMsgs}`;
  const pct = allLines.length > 0 ? Math.min(Math.round(((startLine + availableRows) / allLines.length) * 100), 100) : 100;
  rows[headerIdx] = renderHeader({ badge, dv, scrollInfo: `${msgLabel}  ${pct}%` });

  // render visible slice
  const visibleLines = allLines.slice(startLine, startLine + availableRows);
  for (let i = 0; i < visibleLines.length; i++) {
    const line = visibleLines[i];
    if (line.type === "separator") {
      rows.push(React.createElement(Text, { key: `dtl-l-${i}`, color: line.color, bold: true }, line.label));
    } else if (line.type === "text") {
      rows.push(React.createElement(Text, { key: `dtl-l-${i}` }, line.text));
    } else {
      rows.push(React.createElement(Text, { key: `dtl-l-${i}` }, " "));
    }
  }

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
}

// ── header helper ───────────────────────────────────────────────

function renderHeader({ badge, dv, scrollInfo }) {
  return React.createElement(
    Text,
    { key: "detail-header", wrap: "truncate-end" },
    React.createElement(Text, { color: badge.color, bold: true }, `[${badge.text}]`),
    React.createElement(Text, { color: "gray" }, ` ${compact(dv.contextId ?? "", 36)}  `),
    React.createElement(Text, { color: "cyan" }, scrollInfo),
    React.createElement(Text, { color: "gray" }, "  ↑/↓ msg  j/k line  r refresh  Esc back")
  );
}
