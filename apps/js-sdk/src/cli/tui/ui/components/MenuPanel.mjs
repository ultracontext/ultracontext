import React from "react";
import { Text } from "ink";

import { MENU_TABS, UC_BRAND_BLUE, UC_BLUE_LIGHT } from "../constants.mjs";
import { fitToWidth } from "../format.mjs";
import { Section } from "./Section.mjs";

const MENU_PADDING_X = 2;
const MENU_PADDING_Y = 1;
const MENU_HORIZONTAL_FRAME = 4;
const MENU_VERTICAL_FRAME = 2;

export function MenuPanel({ focusMode, menuIndex, selectedTab, height, width }) {
  const innerCols = Math.max(
    (Number(width ?? 0) || 0) - MENU_HORIZONTAL_FRAME - MENU_PADDING_X * 2,
    10
  );
  const activeIndex = Math.max(
    focusMode === "menu" ? Number(menuIndex ?? 0) : MENU_TABS.findIndex((tab) => tab.id === selectedTab),
    0
  );
  const estimatedRows = Math.max(
    (Number(height ?? 0) || 0) - MENU_VERTICAL_FRAME - MENU_PADDING_Y * 2,
    1
  );
  const listCapacity = Math.max(Math.min(estimatedRows, MENU_TABS.length), 1);
  const start = Math.max(
    Math.min(activeIndex - Math.floor(listCapacity / 2), Math.max(MENU_TABS.length - listCapacity, 0)),
    0
  );
  const end = Math.min(start + listCapacity, MENU_TABS.length);
  const visibleTabs = MENU_TABS.slice(start, end);

  return React.createElement(
    Section,
    {
      title: "Menu",
      width,
      height,
      borderColor: "gray",
      titleColor: "white",
      paddingX: MENU_PADDING_X,
      paddingY: MENU_PADDING_Y,
    },
    ...visibleTabs.map((tab, visibleIndex) => {
      const index = start + visibleIndex;
      const isFocusedInMenu = focusMode === "menu" && index === menuIndex;
      const isActiveInView = focusMode !== "menu" && index === activeIndex;
      const isHighlighted = isFocusedInMenu || isActiveInView;
      const marker = isHighlighted ? "[•]" : "[ ]";
      const markerColor = isHighlighted ? UC_BRAND_BLUE : "white";
      const labelColor = isHighlighted ? UC_BLUE_LIGHT : "white";
      const labelMax = Math.max(innerCols - marker.length - 1, 4);
      const label = fitToWidth(tab.label, labelMax);
      const lineLen = marker.length + 1 + label.length;
      const tailPad = " ".repeat(Math.max(innerCols - lineLen, 0));

      return React.createElement(
        Text,
        { key: `menu-${tab.id}-${start}-${listCapacity}`, wrap: "truncate-end" },
        React.createElement(Text, { color: markerColor }, marker),
        " ",
        React.createElement(Text, { color: labelColor, dim: !isHighlighted }, label),
        tailPad
      );
    })
  );
}
