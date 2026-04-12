import React from "react";
import { Box, Text } from "ink";
import { TitledBox } from "@mishieck/ink-titled-box";

import { UC_BLUE_LIGHT, UC_BRAND_BLUE } from "../constants.mjs";

export function UpdatePromptPanel({ snapshot, width }) {
  const prompt = snapshot.updatePrompt ?? {};
  const options = prompt.options ?? [];
  const selectedIndex = Math.max(
    Math.min(prompt.selectedIndex ?? 0, Math.max(options.length - 1, 0)),
    0
  );
  const current = snapshot.currentVersion ?? "?";
  const latest = prompt.latestVersion ?? "?";

  return React.createElement(
    TitledBox,
    {
      key: `update-prompt:${width}`,
      borderStyle: "single",
      titles: ["Update Available"],
      titleJustify: "flex-start",
      borderColor: UC_BRAND_BLUE,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      width,
    },
    React.createElement(
      Text,
      { color: "white", bold: true },
      `New version available: `,
      React.createElement(Text, { color: "gray" }, `v${current}`),
      ` → `,
      React.createElement(Text, { color: "green", bold: true }, `v${latest}`)
    ),
    React.createElement(Box, { height: 1 }),
    ...options.map((option, index) => {
      const selected = index === selectedIndex;
      return React.createElement(
        Text,
        { key: `update-option-${option.id}`, color: selected ? UC_BLUE_LIGHT : "white" },
        selected ? "[•]" : "[ ]",
        ` ${index + 1}. ${option.label}`
      );
    }),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: "gray" }, "Choose: ↑/↓, 1/2 or Enter")
  );
}
