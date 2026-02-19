export function computeTuiLayout(stdoutColumns, stdoutRows) {
  const safeCols = Math.max(Math.floor(Number(stdoutColumns) || 0), 1);
  const safeRows = Math.max(Math.floor(Number(stdoutRows) || 0), 1);
  const minWideCols = 64;
  const isNarrowWidth = safeCols < minWideCols;
  const frameWidth = Math.max(safeCols - 2, 1);
  const narrowWidth = frameWidth;
  const containerWidth = frameWidth;
  const contentWidth = Math.max(containerWidth - 2, 1);

  const compactLayoutBreakpoint = 114;
  const isCompactLayout = contentWidth < compactLayoutBreakpoint;
  const sidebarWidth = contentWidth >= 140 ? 40 : contentWidth >= 112 ? 34 : 28;
  const fullBottomPanelHeight = Math.max(safeRows - 17, 6);
  const targetBottomPanelHeight = Math.max(Math.floor(fullBottomPanelHeight * 0.67), 6);
  const maxBottomPanelHeight = Math.max(safeRows - 10, 4);
  const bottomPanelHeight = Math.min(targetBottomPanelHeight, maxBottomPanelHeight);

  // Wide layout (left sidebar + right panel)
  const minMenuPanelHeight = Math.min(5, Math.max(bottomPanelHeight, 1));
  const minAgentsPanelHeight = 0;
  let menuPanelHeight = Math.max(Math.floor(bottomPanelHeight * 0.62), minMenuPanelHeight);
  if (menuPanelHeight > bottomPanelHeight - minAgentsPanelHeight) {
    menuPanelHeight = Math.max(bottomPanelHeight - minAgentsPanelHeight, minMenuPanelHeight);
  }
  const agentsPanelHeight = Math.max(bottomPanelHeight - menuPanelHeight, 0);
  const showClientsPanel = agentsPanelHeight >= 4;
  const rightPanelContentRows = Math.max(bottomPanelHeight - 5, 1);
  const rightPanelApproxWidth = Math.max(contentWidth - sidebarWidth - 3, 24);
  const rightPanelTextCols = Math.max(rightPanelApproxWidth - 12, 12);

  // Compact layout (stacked panels)
  // In compact mode, prioritize readability of the main view.
  let compactMenuPanelHeight = Math.min(Math.max(Math.floor(bottomPanelHeight * 0.35), 3), Math.max(bottomPanelHeight - 3, 1));
  let compactRemaining = Math.max(bottomPanelHeight - compactMenuPanelHeight, 1);
  let compactAgentsPanelHeight = compactRemaining >= 9 ? 4 : 0;
  let compactViewPanelHeight = Math.max(compactRemaining - compactAgentsPanelHeight, 1);
  if (compactMenuPanelHeight + compactAgentsPanelHeight + compactViewPanelHeight > bottomPanelHeight) {
    compactViewPanelHeight = Math.max(bottomPanelHeight - compactMenuPanelHeight - compactAgentsPanelHeight, 1);
  }
  if (compactMenuPanelHeight + compactAgentsPanelHeight + compactViewPanelHeight > bottomPanelHeight) {
    compactAgentsPanelHeight = 0;
    compactViewPanelHeight = Math.max(bottomPanelHeight - compactMenuPanelHeight, 1);
  }
  compactRemaining = Math.max(bottomPanelHeight - compactMenuPanelHeight, 1);
  if (compactViewPanelHeight > compactRemaining) compactViewPanelHeight = compactRemaining;
  const compactShowClientsPanel = compactAgentsPanelHeight >= 4;
  const compactRightPanelContentRows = Math.max(compactViewPanelHeight - 4, 1);
  const compactRightPanelTextCols = Math.max(contentWidth - 12, 12);

  return {
    minWideCols,
    isNarrowWidth,
    narrowWidth,
    containerWidth,
    contentWidth,
    isCompactLayout,
    sidebarWidth,
    bottomPanelHeight,
    menuPanelHeight,
    agentsPanelHeight,
    showClientsPanel,
    rightPanelContentRows,
    rightPanelTextCols,
    compactMenuPanelHeight,
    compactAgentsPanelHeight,
    compactShowClientsPanel,
    compactViewPanelHeight,
    compactRightPanelContentRows,
    compactRightPanelTextCols,
  };
}
