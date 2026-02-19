import React from "react";
import { Box, Text } from "ink";
import { TitledBox } from "@mishieck/ink-titled-box";

import { UC_BLUE_LIGHT, UC_BRAND_BLUE } from "../constants.mjs";

export function BootstrapPanel({ snapshot, width }) {
  const options = snapshot.bootstrap?.options ?? [];
  const selectedIndex = Math.max(
    Math.min(snapshot.bootstrap?.selectedIndex ?? 0, Math.max(options.length - 1, 0)),
    0
  );
  const sourceLabel = (snapshot.bootstrap?.sourceNames ?? []).join(", ") || "sources";

  return React.createElement(
    TitledBox,
    {
      key: `bootstrap:${width}:${options.length}`,
      borderStyle: "single",
      titles: ["First Sync Setup"],
      titleJustify: "flex-start",
      borderColor: UC_BRAND_BLUE,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      width,
    },
    React.createElement(Text, { color: "white", bold: true }, `How should sync start for: ${sourceLabel}?`),
    React.createElement(Box, { height: 1 }),
    ...options.map((option, index) => {
      const selected = index === selectedIndex;
      return React.createElement(
        Box,
        { key: `bootstrap-option-${option.id}`, flexDirection: "column" },
        React.createElement(
          Text,
          { color: selected ? UC_BLUE_LIGHT : "white" },
          selected ? "[•]" : "[ ]",
          ` ${index + 1}. ${option.label}`
        ),
        React.createElement(Text, { color: "gray" }, `    ${option.description}`)
      );
    }),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: "gray" }, "Choose: ↑/↓, 1/2/3 or Enter")
  );
}
