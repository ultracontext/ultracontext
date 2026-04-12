import React from "react";
import { render } from "ink";

import { DaemonTui } from "./DaemonTui.mjs";

export function createInkUiController({ getSnapshot, actions }) {
  let app = null;
  let lastCols = null;
  let lastRows = null;
  const view = () => React.createElement(DaemonTui, { snapshot: getSnapshot(), actions });

  const readDims = () => ({
    cols: process.stdout.columns ?? 0,
    rows: process.stdout.rows ?? 0,
  });

  return {
    start() {
      if (app) return;
      app = render(view(), { exitOnCtrlC: false });
      const dims = readDims();
      lastCols = dims.cols;
      lastRows = dims.rows;
    },
    refresh() {
      if (!app) return;
      const dims = readDims();
      const sizeChanged = dims.cols !== lastCols || dims.rows !== lastRows;
      if (sizeChanged && typeof app.clear === "function") {
        app.clear();
      }
      lastCols = dims.cols;
      lastRows = dims.rows;
      app.rerender(view());
    },
    stop() {
      if (!app) return;
      app.unmount();
      app = null;
      lastCols = null;
      lastRows = null;
    },
  };
}
