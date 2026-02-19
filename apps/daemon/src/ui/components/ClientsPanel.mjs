import React from "react";
import { Text } from "ink";

import { compact } from "../format.mjs";
import { fitToWidth } from "../format.mjs";
import { Section } from "./Section.mjs";

const CLIENTS_PADDING_X = 2;
const CLIENTS_PADDING_Y = 1;
const CLIENTS_HORIZONTAL_FRAME = 4;
const CLIENTS_VERTICAL_FRAME = 2;
const SPARK_CHARS = "▁▂▃▄▅▆▇█";

function formatLag(ms) {
  const safeMs = Math.max(Number(ms) || 0, 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function sparklineFromLag(history) {
  const values = Array.isArray(history) ? history : [];
  if (values.length === 0) return SPARK_CHARS[0];
  return values
    .map((lagMs) => {
      const normalized = 1 - Math.max(Math.min((Number(lagMs) || 0) / 10000, 1), 0);
      const index = Math.max(Math.min(Math.round(normalized * (SPARK_CHARS.length - 1)), SPARK_CHARS.length - 1), 0);
      return SPARK_CHARS[index];
    })
    .join("");
}

function clientLabel(client) {
  return `${compact(client.engineerId ?? "-", 12)}@${compact(client.host ?? "-", 20)}`;
}

function compactClientLine(client, lagMs, sparkline, maxCols) {
  const base = `● ${clientLabel(client)}  lag ${formatLag(lagMs)}  ${sparkline}`;
  return fitToWidth(base, maxCols);
}

export function ClientsPanel({ clients, now, height, width }) {
  const innerCols = Math.max((Number(width ?? 0) || 0) - CLIENTS_HORIZONTAL_FRAME - CLIENTS_PADDING_X * 2, 10);
  const estimatedRows = Math.max((Number(height ?? 0) || 0) - CLIENTS_VERTICAL_FRAME - CLIENTS_PADDING_Y * 2, 1);
  const nowTs = Number(now ?? Date.now()) || Date.now();
  const historyRef = React.useRef(new Map());

  const list = (Array.isArray(clients) ? clients : [])
    .map((client) => ({
      ...client,
      id: `${String(client?.engineerId ?? "-")}@${String(client?.host ?? "-")}`,
      lagMs: Math.max(nowTs - Number(client?.ts ?? nowTs), 0),
    }))
    .sort((a, b) => a.lagMs - b.lagMs);

  const activeClientIds = new Set();
  for (const client of list) {
    activeClientIds.add(client.id);
    const previous = historyRef.current.get(client.id) ?? [];
    const next = [...previous, client.lagMs].slice(-8);
    historyRef.current.set(client.id, next);
  }
  for (const key of [...historyRef.current.keys()]) {
    if (!activeClientIds.has(key)) historyRef.current.delete(key);
  }

  const rows = [];
  if (list.length === 0) {
    rows.push(
      React.createElement(
        Text,
        { key: "clients-empty", color: "yellow", wrap: "truncate-end" },
        fitToWidth("No clients online", innerCols)
      )
    );
  } else if (estimatedRows < 4) {
    const first = list[0];
    const sparkline = sparklineFromLag(historyRef.current.get(first.id) ?? []);
    rows.push(
      React.createElement(
        Text,
        { key: `clients-compact-${first.id}`, color: "white", wrap: "truncate-end" },
        compactClientLine(first, first.lagMs, sparkline, innerCols)
      )
    );
    if (list.length > 1 && rows.length < estimatedRows) {
      rows.push(
        React.createElement(
          Text,
          { key: "clients-compact-more", color: "gray", dim: true, wrap: "truncate-end" },
          fitToWidth(`+${list.length - 1} more online`, innerCols)
        )
      );
    }
  } else {
    const maxVisibleClients = Math.max(Math.floor(estimatedRows / 2), 1);
    const visible = list.slice(0, maxVisibleClients);
    for (let index = 0; index < visible.length; index += 1) {
      const client = visible[index];
      const sparkline = sparklineFromLag(historyRef.current.get(client.id) ?? []);
      const head = fitToWidth(`● ${clientLabel(client)}`, innerCols);
      const detail = fitToWidth(`lag ${formatLag(client.lagMs)} · activity ${sparkline}`, innerCols);

      rows.push(
        React.createElement(
          Text,
          { key: `clients-head-${client.id}-${index}`, wrap: "truncate-end" },
          React.createElement(Text, { color: "green" }, "● "),
          React.createElement(Text, { color: "white" }, head.slice(2))
        )
      );
      if (rows.length < estimatedRows) {
        rows.push(
          React.createElement(Text, { key: `clients-detail-${client.id}-${index}`, color: "gray", dim: true, wrap: "truncate-end" }, detail)
        );
      }
    }
    if (list.length > visible.length && rows.length < estimatedRows) {
      rows.push(
        React.createElement(
          Text,
          { key: "clients-more", color: "gray", dim: true, wrap: "truncate-end" },
          fitToWidth(`+${list.length - visible.length} more online`, innerCols)
        )
      );
    }
  }

  return React.createElement(
    Section,
    {
      title: "Clients",
      height,
      width,
      borderColor: "gray",
      titleColor: "white",
      paddingX: CLIENTS_PADDING_X,
      paddingY: CLIENTS_PADDING_Y,
    },
    ...rows
  );
}
