import React from "react";
import { Box, Text } from "ink";

import Spinner from "../../Spinner.mjs";
import { HeroLockup } from "../components/index.mjs";
import { formatTime, centerText } from "../format.mjs";

export function HeaderPanel({ snapshot, stdoutColumns }) {
  const health = snapshot.stats.errors > 0 ? "DEGRADED" : "HEALTHY";
  const healthColor = health === "HEALTHY" ? "green" : "yellow";
  const tagline = "Live Context Engine";
  const innerWidth = Math.max(stdoutColumns, 40);
  const spinnerVisualWidth = 28;
  const gap = innerWidth >= 96 ? 3 : 2;
  const artWidth = Math.max(innerWidth - spinnerVisualWidth - gap, 8);
  const statusTail = `   Live View ${formatTime(snapshot.now)}   engineer ${snapshot.cfg.engineerId}`;
  const centeredStatus = centerText(`status ${health}${statusTail}`, innerWidth);
  const healthPos = centeredStatus.indexOf(health);
  const statusBefore = healthPos >= 0 ? centeredStatus.slice(0, healthPos) : centeredStatus;
  const statusAfter = healthPos >= 0 ? centeredStatus.slice(healthPos + health.length) : "";

  return React.createElement(
    Box,
    { flexDirection: "column", width: innerWidth },
    React.createElement(
      Box,
      { flexDirection: "row", alignItems: "center", width: innerWidth },
      React.createElement(Spinner, { color: "white" }),
      React.createElement(Box, { width: gap }),
      React.createElement(
        HeroLockup,
        { width: artWidth, tagline }
      )
    ),
    React.createElement(
      Text,
      { color: "white" },
      statusBefore,
      healthPos >= 0 ? React.createElement(Text, { color: healthColor, bold: true }, health) : "",
      healthPos >= 0 ? statusAfter : ""
    )
  );
}
