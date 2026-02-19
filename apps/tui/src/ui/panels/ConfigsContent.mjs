import React from "react";
import { Box, Text } from "ink";

import { UC_BLUE_LIGHT } from "../constants.mjs";
import { compact, padElements } from "../format.mjs";

export function ConfigsContent({ snapshot, viewFocused, maxRows }) {
  const configItems = snapshot.configEditor?.items ?? [];
  const selectedConfigIndex = Math.max(
    Math.min(snapshot.configEditor?.selectedIndex ?? 0, Math.max(configItems.length - 1, 0)),
    0
  );
  const rows = [];
  for (let index = 0; index < configItems.length; index += 1) {
    const item = configItems[index];
    const selected = index === selectedConfigIndex;
    const marker = selected ? "[•]" : "[ ]";
    const rowColor = selected && viewFocused ? UC_BLUE_LIGHT : "white";
    const status =
      item.kind === "action"
        ? item.valueLabel ?? "RUN"
        : item.kind === "enum"
          ? item.valueLabel ?? String(item.value ?? "-")
          : item.value ? "ON" : "OFF";
    const detail = item.blockedByMaster
      ? `${item.description ?? ""} (disabled while Master sounds is OFF)`
      : item.description ?? "";
    rows.push(
      React.createElement(
        Text,
        { key: `config-row-${item.key}`, color: rowColor },
        `${marker} ${item.label} [${status}]`
      )
    );
    if (detail) {
      rows.push(
        React.createElement(
          Text,
          { key: `config-detail-${item.key}`, color: item.blockedByMaster ? "yellow" : "gray" },
          compact(`    ${detail}`, 130)
        )
      );
    }
  }

  if (rows.length === 0) {
    rows.push(React.createElement(Text, { key: "config-empty", color: "yellow" }, "No editable configs found."));
  }
  if (snapshot.resume.notice) {
    rows.push(React.createElement(Text, { key: "config-gap" }, " "));
    rows.push(
      React.createElement(Text, { key: "config-notice", color: "gray" }, compact(`last action: ${snapshot.resume.notice}`, 130))
    );
  }

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "cfg"));
}
