import React from "react";
import { Box, Text } from "ink";
import { TitledBox } from "@mishieck/ink-titled-box";

import { UC_BRAND_BLUE } from "../constants.mjs";
import { fitToWidth } from "../format.mjs";

export function NarrowWidthPanel({ minWideCols, narrowWidth, stdoutColumns }) {
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      TitledBox,
      {
        borderStyle: "single",
        titles: ["UltraContext v1.1"],
        titleJustify: "flex-start",
        borderColor: UC_BRAND_BLUE,
        flexDirection: "column",
        paddingX: 2,
        paddingY: 1,
        width: narrowWidth,
      },
      React.createElement(Text, { color: "yellow", bold: true, wrap: "truncate-end" }, "Window too narrow"),
      React.createElement(
        Text,
        { color: "gray", wrap: "truncate-end" },
        fitToWidth(`Resize terminal width to at least ${minWideCols} cols (current=${stdoutColumns}).`, Math.max(narrowWidth - 6, 12))
      )
    )
  );
}
