import React from "react";
import { Box, Text } from "ink";

import Spinner from "../components/Spinner.mjs";
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

export function HeaderPanel({ snapshot, stdoutColumns }) {
  const [pulseOn, setPulseOn] = React.useState(true);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setPulseOn((current) => !current);
    }, 320);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);

  const health = snapshot.stats.errors > 0 ? "DEGRADED" : "HEALTHY";
  const healthColor = health === "HEALTHY" ? "green" : "yellow";
  const tagline = "The Context Hub for AI Agents";
  const innerWidth = Math.max(stdoutColumns, 40);
  const spinnerVisualWidth = 28;
  const gap = innerWidth >= 96 ? 3 : 2;
  const artWidth = Math.max(innerWidth - spinnerVisualWidth - gap, 8);
  const statusPrefix = "status ";
  const healthToken = `● ${health}`;
  const clientsOnline = Array.isArray(snapshot.onlineClients) ? snapshot.onlineClients.length : 0;
  const dashboardTail = [
    `live ${formatTime(snapshot.now)}`,
    `engineer ${snapshot.cfg.engineerId}`,
    `clients ${clientsOnline}`,
    `uptime ${formatUptime(Date.now() - Number(snapshot.stats.startedAt ?? 0))}`,
  ].join(" │ ");
  const tailMax = Math.max(innerWidth - statusPrefix.length - healthToken.length - 3, 0);
  const fittedTail = fitToWidth(dashboardTail, tailMax);

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
      Box,
      { flexDirection: "row", width: innerWidth },
      React.createElement(Text, { color: "gray", dim: true }, statusPrefix),
      React.createElement(
        Text,
        { color: healthColor, bold: true },
        React.createElement(Text, { color: healthColor, dim: !pulseOn }, "●"),
        ` ${health}`
      ),
      fittedTail
        ? React.createElement(Text, { color: "gray", dim: true }, ` │ ${fittedTail}`)
        : null
    )
  );
}
