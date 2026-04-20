import React from "react";

import { ConfigsContent } from "./ConfigsContent.mjs";
import { ContextsContent } from "./ContextsContent.mjs";
import { LogsContent } from "./LogsContent.mjs";

export function RightPanel({ snapshot, viewFocused, maxRows, maxCols }) {
  if (snapshot.selectedTab === "configs") return React.createElement(ConfigsContent, { snapshot, viewFocused, maxRows });
  if (snapshot.selectedTab === "contexts") return React.createElement(ContextsContent, { snapshot, viewFocused, maxRows, maxCols });
  return React.createElement(LogsContent, { snapshot, maxRows, maxCols });
}
