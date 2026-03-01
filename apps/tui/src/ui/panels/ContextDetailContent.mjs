import React from "react";
import { Box, Text } from "ink";

import { compact, contextBadge, fitToWidth, padElements } from "../format.mjs";

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

function messageText(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (content && typeof content === "object") {
    if (typeof content.message === "string") return content.message.replace(/\s+/g, " ").trim();
    if (typeof content.text === "string") return content.text.replace(/\s+/g, " ").trim();
    return JSON.stringify(content);
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

// ── wrap text into lines of maxWidth ────────────────────────────

function wrapText(text, maxWidth) {
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
    const text = messageText(msg);
    const color = roleColor(role);

    // separator: ── role · HH:MM ──────────
    const label = ts ? `${role} · ${ts}` : role;
    const labelPart = `── ${label} `;
    const fillLen = Math.max(separatorWidth - labelPart.length, 0);
    const fill = "─".repeat(fillLen);

    lines.push({ type: "separator", role, color, label: `${labelPart}${fill}`, msgIndex: i });

    // text lines (wrapped)
    const wrapped = wrapText(text || "(empty)", maxWidth);
    for (const line of wrapped) {
      lines.push({ type: "text", color: "white", text: line, msgIndex: i });
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

  // header: source badge + context id + scroll hint
  const source = dv.contextMeta?.source ?? "unknown";
  const badge = contextBadge(source);
  const totalMsgs = dv.messages.length;
  const scrollPos = totalMsgs > 0 ? `${dv.scrollOffset + 1}/${totalMsgs}` : "0/0";

  rows.push(
    React.createElement(
      Text,
      { key: "detail-header", wrap: "truncate-end" },
      React.createElement(Text, { color: badge.color, bold: true }, `[${badge.text}]`),
      React.createElement(Text, { color: "gray" }, ` ${compact(dv.contextId ?? "", 36)}  `),
      React.createElement(Text, { color: "cyan" }, scrollPos),
      React.createElement(Text, { color: "gray" }, "  ↑/↓ scroll  Esc/← back")
    )
  );
  rows.push(React.createElement(Text, { key: "detail-spacer" }, " "));

  // loading state
  if (dv.loading) {
    rows.push(React.createElement(Text, { key: "detail-loading", color: "yellow" }, "Loading messages..."));
    return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
  }

  // error state
  if (dv.error) {
    rows.push(React.createElement(Text, { key: "detail-error", color: "red" }, `Error: ${dv.error}`));
    return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
  }

  // empty state
  if (totalMsgs === 0) {
    rows.push(React.createElement(Text, { key: "detail-empty", color: "gray" }, "No messages in this context."));
    return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
  }

  // build visual lines for all messages
  const allLines = buildMessageLines(dv.messages, textWidth);

  // find the first visual line of the current scroll-offset message
  const targetMsgIndex = dv.scrollOffset;
  let startLine = 0;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].msgIndex === targetMsgIndex) {
      startLine = i;
      break;
    }
  }

  // render visible lines
  const availableRows = Math.max(maxRows - rows.length, 1);
  const visibleLines = allLines.slice(startLine, startLine + availableRows);

  for (let i = 0; i < visibleLines.length; i++) {
    const line = visibleLines[i];
    if (line.type === "separator") {
      rows.push(
        React.createElement(Text, { key: `dtl-sep-${i}`, color: line.color, bold: true }, line.label)
      );
    } else if (line.type === "text") {
      rows.push(
        React.createElement(Text, { key: `dtl-txt-${i}`, color: line.color }, line.text)
      );
    } else {
      rows.push(React.createElement(Text, { key: `dtl-blk-${i}` }, " "));
    }
  }

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "dtl"));
}
