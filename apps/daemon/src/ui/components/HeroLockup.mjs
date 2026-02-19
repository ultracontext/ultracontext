import React from "react";
import { Box, Text } from "ink";

import { fitToWidth } from "../format.mjs";
import { heroArtForWidth } from "../hero-art.mjs";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function centerAround(text, width, center) {
  const fitted = fitToWidth(text, width);
  const safeCenter = clamp(Math.floor(center), 0, Math.max(width - 1, 0));
  const maxLeft = Math.max(width - fitted.length, 0);
  const left = clamp(safeCenter - Math.floor(fitted.length / 2), 0, maxLeft);
  const right = Math.max(width - fitted.length - left, 0);
  return `${" ".repeat(left)}${fitted}${" ".repeat(right)}`;
}

export function HeroLockup({ width, tagline, artCenterBias = 0 }) {
  const lockupWidth = Math.max(width, 8);
  const rawArtLines = heroArtForWidth(lockupWidth).map((line) => fitToWidth(String(line ?? ""), lockupWidth));
  const artBlockWidth = Math.max(...rawArtLines.map((line) => line.length), 0);
  const maxLeft = Math.max(lockupWidth - artBlockWidth, 0);
  const artLeft = clamp(Math.floor((lockupWidth - artBlockWidth) / 2) + artCenterBias, 0, maxLeft);
  const artLines = rawArtLines.map((line) => fitToWidth(`${" ".repeat(artLeft)}${line}`, lockupWidth));
  const taglineText = `[ ${tagline} ]`;
  const artCenter = artLeft + Math.floor(Math.max(artBlockWidth - 1, 0) / 2);
  const taglineLine = centerAround(taglineText, lockupWidth, artCenter);

  return React.createElement(
    Box,
    { flexDirection: "column", width: lockupWidth, alignItems: "flex-start", justifyContent: "flex-start" },
    ...artLines.map((line, index) =>
      React.createElement(Text, { key: `hero-${index}`, color: "white", bold: true }, line)
    ),
    React.createElement(Text, { color: "white" }, " "),
    React.createElement(Text, { color: "blue", bold: true }, taglineLine)
  );
}
