import React from "react";
import { Text } from "ink";

import { compact } from "../format.mjs";
import { fitToWidth } from "../format.mjs";
import { Section } from "./Section.mjs";

const CLIENTS_PADDING_X = 2;
const CLIENTS_PADDING_Y = 1;
const CLIENTS_HORIZONTAL_FRAME = 4;

function buildClientLine(clients, maxCols) {
  if (clients.length === 0) {
    return { key: "clients-empty", text: fitToWidth("No clients online", maxCols), color: "yellow", hasDot: false };
  }
  const first = clients[0] ?? {};
  const label = `${compact(first.engineerId ?? "-", 12)}@${compact(first.host ?? "-", 20)}`;
  const more = clients.length > 1 ? ` +${clients.length - 1}` : "";
  return {
    key: "clients-first",
    text: fitToWidth(`${label}${more}`, Math.max(maxCols - 2, 4)),
    color: "white",
    hasDot: true,
  };
}

export function ClientsPanel({ clients, height, width }) {
  const innerCols = Math.max(
    (Number(width ?? 0) || 0) - CLIENTS_HORIZONTAL_FRAME - CLIENTS_PADDING_X * 2,
    10
  );
  const line = buildClientLine(clients, innerCols);
  const row = React.createElement(
    Text,
    { key: line.key, color: line.color, wrap: "truncate-end" },
    line.hasDot ? React.createElement(Text, { color: "green" }, "● ") : "",
    line.text
  );

  return React.createElement(
    Section,
    {
      title: "Clients",
      height,
      width,
      borderColor: "white",
      titleColor: "white",
      paddingX: CLIENTS_PADDING_X,
      paddingY: CLIENTS_PADDING_Y,
    },
    row
  );
}
