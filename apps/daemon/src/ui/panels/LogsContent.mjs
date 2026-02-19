import React from "react";
import { Box, Text } from "ink";

import { fitToWidth, levelColor, padElements, sourceColor, sourceLabel } from "../format.mjs";

function classifyLog(entry) {
  const text = String(entry?.text ?? "").toLowerCase();
  if (text.includes("bootstrap")) return { label: "BOOTSTRAP", color: "cyan" };
  if (text.includes("config")) return { label: "CONFIG", color: "yellow" };
  if (text.includes("daemon") || text.includes("instance lock")) return { label: "DAEMON", color: "green" };
  if (entry?.level === "error") return { label: "ERROR", color: "red" };
  if (entry?.level === "warn") return { label: "WARN", color: "yellow" };
  return { label: "", color: "gray" };
}

export function LogsContent({ snapshot, maxRows, maxCols = 100 }) {
  const rows = [];
  const safeCols = Math.max(maxCols, 12);
  const visibleLogs = snapshot.recentLogs.slice(-Math.max(maxRows, 1)).reverse();

  if (visibleLogs.length === 0) {
    rows.push(
      React.createElement(Text, { key: "log-empty", color: "gray", wrap: "truncate-end" }, fitToWidth("waiting for activity...", safeCols))
    );
  } else {
    rows.push(
      ...visibleLogs.map((entry, index) => {
        const category = classifyLog(entry);
        const sourceTag = entry.source ? `[${sourceLabel(entry.source)}]` : "";
        const timePrefix = `${String(entry.ts ?? "--:--:--")} `;
        const typePrefix = category.label ? `[${category.label}] ` : "";
        const sourcePrefix = sourceTag ? `${sourceTag} ` : "";
        const prefixWidth = 2 + 1 + timePrefix.length + typePrefix.length + sourcePrefix.length;
        const messageMax = Math.max(safeCols - prefixWidth, 8);
        const message = fitToWidth(String(entry.text ?? ""), messageMax);
        const messageColor = entry.level === "warn" || entry.level === "error" ? levelColor(entry.level) : "white";

        return React.createElement(
          Text,
          { key: `log-${index}`, wrap: "truncate-end" },
          React.createElement(Text, { color: category.color }, "● "),
          React.createElement(Text, { color: "gray", dim: true }, timePrefix),
          typePrefix
            ? React.createElement(Text, { color: category.color, bold: true }, typePrefix)
            : null,
          sourceTag
            ? React.createElement(Text, { color: sourceColor(entry.source), bold: true }, sourcePrefix)
            : null,
          React.createElement(Text, { color: messageColor }, message)
        );
      })
    );
  }

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "log"));
}
