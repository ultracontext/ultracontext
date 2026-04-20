import React from "react";
import { Box, Text } from "ink";

import Spinner from "../../Spinner.mjs";
import { HeroLockup } from "../components/index.mjs";
import { fitToWidth, formatTime } from "../format.mjs";

function formatUptime(value) {
  const ms = Math.max(Number(value) || 0, 0);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export { formatUptime };

export function HeaderPanel({ snapshot, stdoutColumns }) {
  const tagline = "Same context, everywhere";
  const innerWidth = Math.max(stdoutColumns, 40);
  const spinnerVisualWidth = 28;

  const gap = 2;
  const artWidth = Math.max(innerWidth - spinnerVisualWidth - gap, 8);

  const padLeft = 1;

  return React.createElement(
    Box,
    { flexDirection: "column", width: innerWidth, paddingX: padLeft, paddingTop: 4, paddingBottom: 3 },
    React.createElement(
      Box,
      { flexDirection: "row", alignItems: "flex-end", width: innerWidth - padLeft * 2 },
      React.createElement(Spinner, { color: "white" }),
      React.createElement(Box, { width: gap }),
      React.createElement(
        HeroLockup,
        { width: artWidth - padLeft * 2, tagline }
      )
    )
  );
}
