import React from "react";
import { Box, Text } from "ink";

import { fitToWidth, levelColor, padElements, sourceColor, sourceLabel } from "../format.mjs";

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
        const sourceTag = entry.source ? `[${sourceLabel(entry.source)}] ` : "";
        const prefix = `${entry.ts} ${sourceTag}`;
        const messageMax = Math.max(safeCols - prefix.length, 8);
        const message = fitToWidth(String(entry.text ?? ""), messageMax);
        return React.createElement(
          Text,
          { key: `log-${index}`, color: levelColor(entry.level), wrap: "truncate-end" },
          `${entry.ts} `,
          entry.source
            ? React.createElement(
                Text,
                { color: sourceColor(entry.source), bold: true },
                sourceTag
              )
            : null,
          message
        );
      })
    );
  }

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "log"));
}
