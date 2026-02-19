import { handleContextsViewInput } from "./view-contexts.mjs";
import { handleConfigsViewInput } from "./view-configs.mjs";

export function handleViewInput({ input, key, actions, snapshot, selectedTabIndex, setFocusMode, setMenuIndex }) {
  if (key.leftArrow || key.escape) {
    setMenuIndex(selectedTabIndex);
    setFocusMode("menu");
    return;
  }

  if (snapshot.selectedTab === "contexts") {
    handleContextsViewInput({ input, key, actions });
    return;
  }

  if (snapshot.selectedTab === "configs") {
    handleConfigsViewInput({ input, key, actions });
  }
}
