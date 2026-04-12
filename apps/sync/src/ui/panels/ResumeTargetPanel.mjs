import React from "react";
import { Box, Text } from "ink";
import { TitledBox } from "@mishieck/ink-titled-box";

import { UC_BLUE_LIGHT, UC_BRAND_BLUE } from "../constants.mjs";
import { compact, sourceColor, sourceLabel } from "../format.mjs";

export function ResumeTargetPanel({ snapshot, width }) {
  const picker = snapshot.resumeTargetPicker ?? {};
  const options = picker.options ?? [];
  const selectedIndex = Math.max(
    Math.min(picker.selectedIndex ?? 0, Math.max(options.length - 1, 0)),
    0
  );
  const source = sourceLabel(picker.source || "unknown");
  const contextId = compact(picker.contextId ?? "-", 42);

  return React.createElement(
    TitledBox,
    {
      key: `resume-target:${width}:${options.length}`,
      borderStyle: "single",
      titles: ["Continue Conversation"],
      titleJustify: "flex-start",
      borderColor: UC_BRAND_BLUE,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      width,
    },
    React.createElement(Text, { color: "white", bold: true }, "Continue selected context in:"),
    React.createElement(
      Text,
      { color: "gray" },
      `source=${source} id=${contextId}`
    ),
    React.createElement(Box, { height: 1 }),
    ...options.map((option, index) => {
      const selected = index === selectedIndex;
      return React.createElement(
        Text,
        { key: `resume-target-option-${option.id}`, color: selected ? UC_BLUE_LIGHT : "white" },
        selected ? "[•]" : "[ ]",
        " ",
        React.createElement(Text, { color: sourceColor(option.id), bold: true }, option.label)
      );
    }),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: "gray" }, `Choose: ↑/↓, ${options.map((_, i) => i + 1).join("/")} or Enter`),
    React.createElement(Text, { color: "gray" }, "Cancel: Esc or ←")
  );
}
