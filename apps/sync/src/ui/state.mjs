import { MENU_TABS } from "./constants.mjs";

export function selectedTabIndexFromId(tabId) {
  return Math.max(
    MENU_TABS.findIndex((tab) => tab.id === tabId),
    0
  );
}

export function selectedTabTitle(tabId) {
  return MENU_TABS.find((tab) => tab.id === tabId)?.label ?? "View";
}

export function footerHelpText({ updatePromptActive, bootstrapActive, resumeTargetPickerActive, detailViewActive, selectedTab, focusMode }) {
  if (updatePromptActive) {
    return "Update: ↑/↓ select, 1/2, Enter to confirm, q to quit.";
  }
  if (bootstrapActive) {
    return "Bootstrap: choose initial mode (↑/↓, 1/2/3, Enter) or q to quit.";
  }
  if (resumeTargetPickerActive) {
    return "Resume target: choose Claude Code or Codex (↑/↓, 1/2, Enter), Esc/← cancel.";
  }
  if (focusMode !== "view") {
    return "Controls: ↑/↓ navigate, Enter focus/open, ← back, q/Ctrl+C quit.";
  }
  if (selectedTab === "contexts" && detailViewActive) {
    return "Detail: ↑/↓ messages, j/k lines, r refresh, Esc/← back.";
  }
  if (selectedTab === "contexts") {
    return "Contexts: ↑/↓ select, Enter open, r refresh, ← back, q/Ctrl+C quit.";
  }
  if (selectedTab === "configs") {
    return "Controls: ↑/↓ select config, Enter/→ apply, ← back, q/Ctrl+C quit.";
  }
  return "Controls: ↑/↓ navigate, Enter focus/open, ← back, q/Ctrl+C quit.";
}
