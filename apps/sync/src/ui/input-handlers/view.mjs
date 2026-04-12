import { handleContextsViewInput } from "./view-contexts.mjs";
import { handleConfigsViewInput } from "./view-configs.mjs";

export function handleViewInput({ input, key, actions, snapshot, selectedTabIndex, setFocusMode, setMenuIndex }) {
  // detail view captures Esc/← to close itself instead of leaving view mode
  if (snapshot.selectedTab === "contexts" && snapshot.detailView?.active) {
    handleContextsViewInput({ input, key, actions, snapshot });
    return;
  }

  if (key.leftArrow || key.escape) {
    setMenuIndex(selectedTabIndex);
    setFocusMode("menu");
    return;
  }

  if (snapshot.selectedTab === "contexts") {
    handleContextsViewInput({ input, key, actions, snapshot });
    return;
  }

  if (snapshot.selectedTab === "configs") {
    handleConfigsViewInput({ input, key, actions });
  }
}
