import React from "react";
import { TitledBox } from "@mishieck/ink-titled-box";

export function Section({
  title,
  width,
  grow,
  height,
  children,
  marginRight = 0,
  borderColor = "blue",
  titleColor = "cyan",
  borderStyle = "single",
  paddingX = 2,
  paddingY = 1,
}) {
  return React.createElement(
    TitledBox,
    {
      key: `section:${title}:${width ?? "auto"}:${height ?? "auto"}:${paddingX}:${paddingY}:${borderStyle}`,
      borderStyle,
      titles: [title],
      titleJustify: "flex-start",
      borderColor,
      flexDirection: "column",
      paddingX,
      paddingY,
      width,
      flexGrow: grow ? 1 : 0,
      height,
      flexShrink: 0,
      marginRight,
    },
    children
  );
}
