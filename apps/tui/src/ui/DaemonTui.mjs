import React from "react";
import { Box, Text, useInput, useStdout } from "ink";

import { UC_BLUE_LIGHT, UC_BRAND_BLUE } from "./constants.mjs";
import { computeTuiLayout } from "./layout.mjs";
import { buildMoveMenuIndex, createInputHandler } from "./input.mjs";
import { fitToWidth } from "./format.mjs";
import { footerHelpText, selectedTabIndexFromId } from "./state.mjs";
import { NarrowWidthPanel } from "./components/index.mjs";
import { BootstrapPanel, HeaderPanel, MainPanels, ResumeTargetPanel } from "./panels/index.mjs";

const FOOTER_QUIPS = [
  "Who is John Galt?",
  "ultrathink -> ultracontext",
  "Welcome to the beginning of infinity.",
  "Our job is to take the jobs.",
];

function renderFooterQuip(quip) {
  const keyword = "ultrathink";
  const lower = String(quip ?? "").toLowerCase();
  const index = lower.indexOf(keyword);
  if (index < 0) {
    return React.createElement(Text, { color: "gray", bold: true }, quip);
  }

  const before = quip.slice(0, index);
  const match = quip.slice(index, index + keyword.length);
  const after = quip.slice(index + keyword.length);

  return React.createElement(
    Box,
    { flexDirection: "row", flexShrink: 0 },
    before ? React.createElement(Text, { key: "quip-before", color: "gray", bold: true }, before) : null,
    React.createElement(Text, { key: "quip-strike", color: "gray", bold: true, strikethrough: true }, match),
    after ? React.createElement(Text, { key: "quip-after", color: "gray", bold: true }, after) : null
  );
}

function renderMainFrameTop(width, title) {
  const safeWidth = Math.max(Number(width) || 0, 4);
  const innerWidth = Math.max(safeWidth - 2, 1);
  const paddedTitle = ` ${title} `;
  const shownTitle = fitToWidth(paddedTitle, innerWidth);
  const fillWidth = Math.max(innerWidth - shownTitle.length, 0);

  return React.createElement(
    Text,
    { color: UC_BRAND_BLUE, wrap: "truncate-end" },
    "┌",
    React.createElement(Text, { color: UC_BLUE_LIGHT, bold: true }, shownTitle),
    "─".repeat(fillWidth),
    "┐"
  );
}

export function DaemonTui({ snapshot, actions }) {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = React.useState(() => ({
    cols: stdout?.columns ?? process.stdout.columns ?? 120,
    rows: stdout?.rows ?? process.stdout.rows ?? 40,
  }));

  React.useEffect(() => {
    const target = stdout ?? process.stdout;
    if (!target) return;

    const update = () => {
      const next = {
        cols: Math.max(target.columns ?? process.stdout.columns ?? 120, 1),
        rows: Math.max(target.rows ?? process.stdout.rows ?? 40, 1),
      };
      setTerminalSize((current) => (current.cols === next.cols && current.rows === next.rows ? current : next));
    };

    update();
    target.on?.("resize", update);
    return () => {
      if (typeof target.off === "function") {
        target.off("resize", update);
      } else if (typeof target.removeListener === "function") {
        target.removeListener("resize", update);
      }
    };
  }, [stdout]);

  const stdoutColumns = terminalSize.cols;
  const stdoutRows = terminalSize.rows;
  const layout = computeTuiLayout(stdoutColumns, stdoutRows);
  const selectedTabIndex = selectedTabIndexFromId(snapshot.selectedTab);

  const bootstrapActive = Boolean(snapshot.bootstrap?.active);
  const resumeTargetPickerActive = Boolean(snapshot.resumeTargetPicker?.active);
  const [focusMode, setFocusMode] = React.useState("menu");
  const [menuIndex, setMenuIndex] = React.useState(selectedTabIndex);
  const [quipIndex, setQuipIndex] = React.useState(0);

  React.useEffect(() => {
    if (focusMode === "menu") setMenuIndex(selectedTabIndex);
  }, [focusMode, selectedTabIndex]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setQuipIndex((current) => (current + 1) % FOOTER_QUIPS.length);
    }, 3800);
    return () => clearInterval(timer);
  }, []);

  const moveMenuIndex = React.useMemo(() => buildMoveMenuIndex(actions, setMenuIndex), [actions]);

  useInput(
    createInputHandler({
      snapshot,
      actions,
      focusMode,
      menuIndex,
      selectedTabIndex,
      setFocusMode,
      setMenuIndex,
      moveMenuIndex,
      bootstrapActive,
      resumeTargetPickerActive,
    })
  );

  const clients = Array.isArray(snapshot.onlineClients) ? snapshot.onlineClients : [];

  if (layout.isNarrowWidth) {
    return React.createElement(NarrowWidthPanel, {
      minWideCols: layout.minWideCols,
      narrowWidth: layout.narrowWidth,
      stdoutColumns,
    });
  }

  const bodyContent = bootstrapActive
    ? React.createElement(BootstrapPanel, { snapshot, width: layout.contentWidth })
    : resumeTargetPickerActive
      ? React.createElement(ResumeTargetPanel, { snapshot, width: layout.contentWidth })
      : React.createElement(MainPanels, { snapshot, layout, focusMode, menuIndex, clients });

  const footerLeft = footerHelpText({
    bootstrapActive,
    resumeTargetPickerActive,
    selectedTab: snapshot.selectedTab,
    focusMode,
  });
  const footerWidth = Math.max(layout.containerWidth, 24);
  const quipRaw = FOOTER_QUIPS[quipIndex % FOOTER_QUIPS.length];
  const quip = fitToWidth(quipRaw, Math.max(Math.floor(footerWidth * 0.48), 18));
  const leftMax = Math.max(footerWidth - quip.length - 2, 12);
  const left = fitToWidth(footerLeft, leftMax);
  const gap = " ".repeat(Math.max(footerWidth - left.length - quip.length, 1));
  const footerRule = "─".repeat(Math.max(footerWidth, 1));

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Box, { width: layout.containerWidth }, renderMainFrameTop(layout.containerWidth, "UltraContext v1.1")),
    React.createElement(
      Box,
      {
        borderStyle: "single",
        borderTop: false,
        borderColor: UC_BRAND_BLUE,
        flexDirection: "column",
        paddingX: 0,
        paddingY: 0,
        width: layout.containerWidth,
      },
      React.createElement(HeaderPanel, { snapshot, stdoutColumns: layout.contentWidth }),
      bodyContent
    ),
    React.createElement(
      Box,
      { width: footerWidth, flexDirection: "column" },
      React.createElement(Text, { color: "gray", dim: true, wrap: "truncate-end" }, footerRule),
      React.createElement(
        Box,
        { width: footerWidth, flexDirection: "row" },
        React.createElement(
          Text,
          { color: "gray", wrap: "truncate-end" },
          `${left}${gap}`
        ),
        renderFooterQuip(quip)
      )
    )
  );
}
