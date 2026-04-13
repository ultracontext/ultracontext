import React from "react";
import { Box, Text } from "ink";

import { UC_BLUE_LIGHT, UC_CLAUDE_ORANGE, UC_CODEX_BLUE, UC_OPENCLAW_RED } from "../constants.mjs";
import { compact, contextBadge, formatContextDate, padElements } from "../format.mjs";
import { ContextDetailContent } from "./ContextDetailContent.mjs";

// source filter bar — highlights active filter
function renderFilterBar(activeFilter) {
  const filters = [
    { id: "all", label: "All", color: "white" },
    { id: "claude", label: "Claude", color: UC_CLAUDE_ORANGE },
    { id: "codex", label: "Codex", color: UC_CODEX_BLUE },
    { id: "openclaw", label: "OpenClaw", color: UC_OPENCLAW_RED },
  ];
  const parts = filters.map((f) =>
    React.createElement(
      Text,
      { key: `filter-${f.id}`, color: activeFilter === f.id ? f.color : "gray", bold: activeFilter === f.id, dimColor: activeFilter !== f.id },
      activeFilter === f.id ? `[${f.label}]` : ` ${f.label} `
    )
  );
  return React.createElement(Box, { key: "filter-bar", flexDirection: "row", gap: 1 }, ...parts);
}

export function ContextsContent({ snapshot, viewFocused, maxRows, maxCols }) {
  // detail view takes over the panel
  if (snapshot.detailView?.active) {
    return React.createElement(ContextDetailContent, { snapshot, maxRows, maxCols });
  }

  const contexts = snapshot.resume.filteredContexts ?? snapshot.resume.contexts;
  const total = contexts.length;
  const selected = Math.max(Math.min(snapshot.resume.selectedIndex, Math.max(total - 1, 0)), 0);
  const activeFilter = snapshot.resume.sourceFilter ?? "all";

  // filter bar row
  const rows = [renderFilterBar(activeFilter)];

  const tailRows = [];
  if (total > 0 && (snapshot.resume.notice || snapshot.resume.error || snapshot.resume.summaryPath || snapshot.resume.command)) {
    const selectedContext = contexts[selected];
    const selectedCreatedAt = formatContextDate(selectedContext?.created_at);
    const selectedInfo = contextBadge(selectedContext?.metadata?.source || "unknown");
    tailRows.push(
      React.createElement(
        Text,
        { key: "contexts-selected", color: "gray" },
        `selected: ${selectedCreatedAt} `,
        React.createElement(Text, { color: selectedInfo.color, bold: true }, `[${selectedInfo.text}]`),
        ` id=${compact(selectedContext?.id ?? "-", 36)}`
      )
    );
  }
  if (tailRows.length > 0) tailRows.push(React.createElement(Text, { key: "contexts-spacer-1" }, " "));
  if (snapshot.resume.notice) {
    tailRows.push(
      React.createElement(Text, { key: "contexts-notice", color: "green" }, `info: ${compact(snapshot.resume.notice, 120)}`)
    );
  }
  if (snapshot.resume.error) {
    tailRows.push(React.createElement(Text, { key: "contexts-error", color: "red" }, `error: ${compact(snapshot.resume.error, 120)}`));
  }
  if (snapshot.resume.summaryPath) {
    tailRows.push(
      React.createElement(Text, { key: "contexts-summary", color: "gray" }, `summary: ${compact(snapshot.resume.summaryPath, 120)}`)
    );
  }
  if (snapshot.resume.command) {
    tailRows.push(
      React.createElement(Text, { key: "contexts-command", color: "gray" }, `command: ${compact(snapshot.resume.command, 120)}`)
    );
  }
  if (snapshot.resume.commandPath) {
    tailRows.push(
      React.createElement(Text, { key: "contexts-command-path", color: "gray" }, `command file: ${compact(snapshot.resume.commandPath, 120)}`)
    );
  }

  const availableRows = Math.max(maxRows, 4);
  const listCapacity = Math.max(availableRows - tailRows.length, 1);

  if (total === 0) {
    rows.push(React.createElement(Text, { key: "contexts-empty", color: "yellow" }, "No contexts available."));
  } else {
    const start = Math.max(Math.min(selected - Math.floor(listCapacity / 2), Math.max(total - listCapacity, 0)), 0);
    const end = Math.min(start + listCapacity, total);
    for (let i = start; i < end; i += 1) {
      const ctx = contexts[i];
      const md = ctx?.metadata ?? {};
      const rowSelected = i === selected;
      const marker = rowSelected ? "[•]" : "[ ]";
      const rowColor = viewFocused && rowSelected ? UC_BLUE_LIGHT : "white";
      const sourceInfo = contextBadge(md.source || "unknown");
      const createdAt = formatContextDate(ctx?.created_at);
      const user = compact(md.user_id ?? "-", 12);
      const label = compact(md.title ?? md.session_id ?? "-", 48);
      rows.push(
        React.createElement(
          Text,
          { key: `contexts-row-${i}`, color: rowColor },
          `${marker} `,
          React.createElement(Text, { color: sourceInfo.color, bold: true }, `[${sourceInfo.text}]`),
          ` ${createdAt} ${user} ${label}`
        )
      );
    }
  }
  rows.push(...tailRows);

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "ctx"));
}
