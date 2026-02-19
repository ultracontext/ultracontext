import React from "react";
import { Box } from "ink";

import { selectedTabTitle } from "../state.mjs";
import { ClientsPanel, MenuPanel, Section } from "../components/index.mjs";
import { RightPanel } from "./RightPanel.mjs";

function ViewSection({ snapshot, focusMode, width, grow, height, maxRows, maxCols }) {
  return React.createElement(
    Section,
    {
      title: selectedTabTitle(snapshot.selectedTab),
      width,
      height,
      grow,
      borderColor: "white",
      titleColor: "white",
    },
    React.createElement(RightPanel, {
      snapshot,
      viewFocused: focusMode === "view",
      maxRows,
      maxCols,
    })
  );
}

export function MainPanels({ snapshot, layout, focusMode, menuIndex, clients }) {
  if (layout.isCompactLayout) {
    const clientsSection = layout.compactShowClientsPanel
      ? React.createElement(ClientsPanel, {
          clients,
          height: layout.compactAgentsPanelHeight,
          width: layout.contentWidth,
        })
      : null;

    return React.createElement(
      Box,
      { flexDirection: "column", alignItems: "flex-start", width: layout.contentWidth },
      React.createElement(MenuPanel, {
        focusMode,
        menuIndex,
        selectedTab: snapshot.selectedTab,
        height: layout.compactMenuPanelHeight,
        width: layout.contentWidth,
      }),
      React.createElement(ViewSection, {
        snapshot,
        focusMode,
        width: layout.contentWidth,
        height: layout.compactViewPanelHeight,
        maxRows: layout.compactRightPanelContentRows,
        maxCols: layout.compactRightPanelTextCols,
      }),
      clientsSection
    );
  }

  const clientsSection = layout.showClientsPanel
    ? React.createElement(ClientsPanel, {
        clients,
        height: layout.agentsPanelHeight,
        width: layout.sidebarWidth,
      })
    : null;

  const rightPanelWidth = Math.max(layout.contentWidth - layout.sidebarWidth, 20);

  return React.createElement(
    Box,
    { flexDirection: "row", alignItems: "flex-start", height: layout.bottomPanelHeight, width: layout.contentWidth },
    React.createElement(
      Box,
      { flexDirection: "column", width: layout.sidebarWidth, marginRight: 0, height: layout.bottomPanelHeight, flexShrink: 0 },
      React.createElement(MenuPanel, {
        focusMode,
        menuIndex,
        selectedTab: snapshot.selectedTab,
        height: layout.menuPanelHeight,
        width: layout.sidebarWidth,
      }),
      clientsSection
    ),
    React.createElement(ViewSection, {
      snapshot,
      focusMode,
      width: rightPanelWidth,
      height: layout.bottomPanelHeight,
      maxRows: layout.rightPanelContentRows,
      maxCols: layout.rightPanelTextCols,
    })
  );
}
