import { MENU_TABS } from "../constants.mjs";

export function handleMenuInput({ input, key, actions, menuIndex, setFocusMode, moveMenuIndex }) {
  const activeTab = MENU_TABS[Math.max(Number(menuIndex) || 0, 0)]?.id ?? "logs";
  if ((input === "r" || input === "R") && activeTab === "contexts") {
    actions.refreshResume?.();
    return;
  }

  if (key.upArrow) {
    moveMenuIndex(-1);
    return;
  }
  if (key.downArrow) {
    moveMenuIndex(1);
    return;
  }
  if (key.return || key.rightArrow) {
    actions.selectTab(menuIndex);
    setFocusMode("view");
  }
}

export function buildMoveMenuIndex(actions, setMenuIndex) {
  return (delta) => {
    setMenuIndex((prev) => {
      const base = Number.isInteger(prev) ? prev : 0;
      const next = Math.max(0, Math.min(base + delta, MENU_TABS.length - 1));
      if (next !== base) actions.selectTab(next);
      return next;
    });
  };
}
