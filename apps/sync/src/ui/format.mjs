import React from "react";
import { Text } from "ink";

import { UC_CLAUDE_ORANGE, UC_CODEX_BLUE, UC_OPENCLAW_RED } from "./constants.mjs";

export function compact(value, max = 80) {
  const raw = String(value ?? "");
  if (raw.length <= max) return raw;
  if (max <= 3) return raw.slice(0, max);
  return `${raw.slice(0, max - 3)}...`;
}

export function formatTime(value = Date.now()) {
  return new Date(value).toISOString().slice(11, 19);
}

export function formatContextDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function levelColor(level) {
  if (level === "error") return "red";
  if (level === "warn") return "yellow";
  if (level === "info") return "green";
  return "cyan";
}

export function sourceColor(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude code") return UC_CLAUDE_ORANGE;
  if (normalized === "codex") return UC_CODEX_BLUE;
  if (normalized === "openclaw") return UC_OPENCLAW_RED;
  return "gray";
}

export function sourceLabel(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude code") return "Claude Code";
  if (normalized === "codex") return "Codex";
  if (normalized === "openclaw") return "OpenClaw";
  return String(source ?? "");
}

export function contextBadge(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (normalized === "codex") return { text: "Codex", color: sourceColor("codex") };
  if (normalized === "claude" || normalized === "claude code") {
    return { text: "Claude Code", color: sourceColor("claude") };
  }
  if (normalized === "openclaw") {
    return { text: "OpenClaw", color: sourceColor("openclaw") };
  }
  const label = sourceLabel(source) || "Unknown";
  return { text: `Context: ${label}`, color: "gray" };
}

export function fitToWidth(text, width) {
  const raw = String(text ?? "");
  if (width <= 0) return "";
  if (raw.length <= width) return raw;
  if (width === 1) return raw.slice(0, 1);
  return `${raw.slice(0, width - 1)}…`;
}

export function padElements(elements, maxRows, keyPrefix) {
  const rows = elements.slice(0, Math.max(maxRows, 0));
  while (rows.length < maxRows) {
    rows.push(React.createElement(Text, { key: `${keyPrefix}-pad-${rows.length}` }, " "));
  }
  return rows;
}

export function centerText(text, width, bias = 0) {
  const fitted = fitToWidth(text, width);
  const centeredLeft = Math.floor((width - fitted.length) / 2);
  const left = Math.max(centeredLeft + bias, 0);
  const right = Math.max(width - fitted.length - left, 0);
  return `${" ".repeat(left)}${fitted}${" ".repeat(right)}`;
}
