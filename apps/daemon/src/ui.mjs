import React from "react";
import { Box, Text, render, useInput } from "ink";
import Spinner from "./Spinner.mjs";
import { TitledBox } from "@mishieck/ink-titled-box";
import figlet from "figlet";

const UC_BRAND_BLUE = "#2f6fb3";
const UC_BLUE_LIGHT = "#7ec3ff";
const UC_CLAUDE_ORANGE = "#f4a261";
const UC_CODEX_BLUE = "#5fb2ff";
const UC_OPENCLAW_RED = "#e76f51";

export const MENU_TABS = [
  { id: "logs", label: "Live View" },
  { id: "contexts", label: "Contexts" },
  { id: "configs", label: "Configs" },
];

function compact(value, max = 80) {
  const raw = String(value ?? "");
  if (raw.length <= max) return raw;
  if (max <= 3) return raw.slice(0, max);
  return `${raw.slice(0, max - 3)}...`;
}

function formatTime(value = Date.now()) {
  return new Date(value).toISOString().slice(11, 19);
}

function formatContextDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function pct(part, total) {
  if (!total || total <= 0) return "0.0";
  return ((part / total) * 100).toFixed(1);
}

function bar(part, total, width = 20) {
  if (!total || total <= 0) {
    return `[${"-".repeat(width)}] 0.0%`;
  }
  const ratio = Math.max(Math.min(part / total, 1), 0);
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(width - filled, 0))}] ${pct(part, total)}%`;
}

function ageFromTs(ts, now = Date.now()) {
  if (!ts) return "-";
  const sec = Math.max(Math.floor((now - ts) / 1000), 0);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function levelColor(level) {
  if (level === "error") return "red";
  if (level === "warn") return "yellow";
  if (level === "info") return "green";
  return "cyan";
}

function sourceColor(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude code") return UC_CLAUDE_ORANGE;
  if (normalized === "codex") return UC_CODEX_BLUE;
  if (normalized === "openclaw") return UC_OPENCLAW_RED;
  return "gray";
}

function sourceLabel(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude code") return "Claude Code";
  if (normalized === "codex") return "Codex";
  if (normalized === "openclaw") return "OpenClaw";
  return String(source ?? "");
}

function contextBadge(source) {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (normalized === "codex") return { text: "Codex", color: sourceColor("codex") };
  if (normalized === "claude" || normalized === "claude code") {
    return { text: "Claude Code", color: sourceColor("claude") };
  }
  if (normalized === "openclaw") {
    return { text: "OpenClaw", color: sourceColor("openclaw") };
  }
  const label = sourceLabel(source) || "Unknown";
  return { text: `Context: ${label}`, color: "gray" };
}

function fitToWidth(text, width) {
  const raw = String(text ?? "");
  if (width <= 0) return "";
  if (raw.length <= width) return raw;
  if (width === 1) return raw.slice(0, 1);
  return `${raw.slice(0, width - 1)}…`;
}

function padElements(elements, maxRows, keyPrefix) {
  const rows = elements.slice(0, Math.max(maxRows, 0));
  while (rows.length < maxRows) {
    rows.push(React.createElement(Text, { key: `${keyPrefix}-pad-${rows.length}` }, " "));
  }
  return rows;
}

function centerText(text, width, bias = 0) {
  const fitted = fitToWidth(text, width);
  const centeredLeft = Math.floor((width - fitted.length) / 2);
  const left = Math.max(centeredLeft + bias, 0);
  const right = Math.max(width - fitted.length - left, 0);
  return `${" ".repeat(left)}${fitted}${" ".repeat(right)}`;
}

const HERO_TEXT = "UltraContext";
const HERO_FONT_ORDER = ["Slant", "Standard", "Small", "Mini"];
const HERO_ART_CACHE = new Map();
const HERO_FONT_ART = HERO_FONT_ORDER.map((font) => {
  try {
    const raw = figlet.textSync(HERO_TEXT, {
      font,
      horizontalLayout: "default",
      verticalLayout: "default",
    });
    const lines = raw
      .replace(/\n+$/g, "")
      .split("\n")
      .map((line) => line.replace(/\s+$/g, ""));
    const width = Math.max(...lines.map((line) => line.length), 0);
    return { lines, width };
  } catch {
    return null;
  }
}).filter(Boolean);

function heroArtForWidth(columns) {
  const available = Math.max(columns ?? 8, 8);
  const cacheKey = String(available);
  if (HERO_ART_CACHE.has(cacheKey)) return HERO_ART_CACHE.get(cacheKey);

  const candidate = HERO_FONT_ART.find((entry) => entry.width <= available);
  const art = candidate
    ? candidate.lines.map((line) => line.padEnd(candidate.width, " "))
    : available >= 12
      ? [HERO_TEXT]
      : ["UC"];

  HERO_ART_CACHE.set(cacheKey, art);
  return art;
}

function Section({
  title,
  width,
  grow,
  height,
  children,
  marginRight = 0,
  borderColor = "blue",
  titleColor = "cyan",
  borderStyle = "single",
}) {
  return React.createElement(
    TitledBox,
    {
      borderStyle,
      titles: [title],
      titleJustify: "flex-start",
      borderColor,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      width,
      flexGrow: grow ? 1 : 0,
      height,
      flexShrink: 0,
      marginRight,
    },
    children
  );
}

function ConfigsContent({ snapshot, viewFocused, maxRows }) {
  const configItems = snapshot.configEditor?.items ?? [];
  const selectedConfigIndex = Math.max(
    Math.min(snapshot.configEditor?.selectedIndex ?? 0, Math.max(configItems.length - 1, 0)),
    0
  );
  const rows = [];
  for (let index = 0; index < configItems.length; index += 1) {
    const item = configItems[index];
    const selected = index === selectedConfigIndex;
    const marker = selected ? "[•]" : "[ ]";
    const rowColor = selected && viewFocused ? UC_BLUE_LIGHT : "white";
    const status =
      item.kind === "action"
        ? item.valueLabel ?? "RUN"
        : item.kind === "enum"
          ? item.valueLabel ?? String(item.value ?? "-")
          : item.value ? "ON" : "OFF";
    const detail = item.blockedByMaster
      ? `${item.description ?? ""} (disabled while Master sounds is OFF)`
      : item.description ?? "";
    rows.push(
      React.createElement(
        Text,
        { key: `config-row-${item.key}`, color: rowColor },
        `${marker} ${item.label} [${status}]`
      )
    );
    if (detail) {
      rows.push(
        React.createElement(
          Text,
          { key: `config-detail-${item.key}`, color: item.blockedByMaster ? "yellow" : "gray" },
          compact(`    ${detail}`, 130)
        )
      );
    }
  }

  if (rows.length === 0) {
    rows.push(React.createElement(Text, { key: "config-empty", color: "yellow" }, "No editable configs found."));
  }
  if (snapshot.resume.notice) {
    rows.push(React.createElement(Text, { key: "config-gap" }, " "));
    rows.push(
      React.createElement(Text, { key: "config-notice", color: "gray" }, compact(`last action: ${snapshot.resume.notice}`, 130))
    );
  }

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "cfg"));
}

function LogsContent({ snapshot, maxRows }) {
  const rows = [];
  const visibleLogs = snapshot.recentLogs.slice(-Math.max(maxRows, 1));

  if (visibleLogs.length === 0) {
    rows.push(React.createElement(Text, { key: "log-empty", color: "gray" }, "waiting for activity..."));
  } else {
    rows.push(
      ...visibleLogs.map((entry, index) =>
        React.createElement(
          Text,
          { key: `log-${index}`, color: levelColor(entry.level) },
          `${entry.ts} `,
          entry.source
            ? React.createElement(
                Text,
                { color: sourceColor(entry.source), bold: true },
                `[${sourceLabel(entry.source)}] `
              )
            : null,
          `${entry.text}`
        )
      )
    );
  }

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "log"));
}

function ContextsContent({ snapshot, viewFocused, maxRows }) {
  const contexts = snapshot.resume.contexts;
  const total = contexts.length;
  const selected = Math.max(Math.min(snapshot.resume.selectedIndex, Math.max(total - 1, 0)), 0);
  const status = snapshot.resume.loading ? "loading" : snapshot.resume.syncing ? "syncing" : "ready";

  const rows = [];
  const topRows = [
    React.createElement(
      Text,
      { key: "contexts-status" },
      `status=${status} contexts=${total} sort=created_at(desc)   controls: r refresh | ↑/↓ select | Enter adapt(codex/claude only) | ← menu`
    ),
    React.createElement(Text, { key: "contexts-spacer-0" }, " "),
  ];
  rows.push(...topRows);

  const tailRows = [];
  if (total > 0) {
    const selectedContext = contexts[selected];
    const selectedCreatedAt = formatContextDate(selectedContext?.created_at);
    const selectedInfo = contextBadge(selectedContext?.metadata?.source || "unknown");
    tailRows.push(
      React.createElement(
        Text,
        { key: "contexts-selected", color: "gray" },
        `selected: ${selectedCreatedAt} `,
        React.createElement(Text, { color: selectedInfo.color, bold: true }, `[${selectedInfo.text}]`),
        ` id=${compact(selectedContext?.id ?? "-", 36)}`
      )
    );
  }
  if (snapshot.resume.notice || snapshot.resume.error || snapshot.resume.summaryPath || snapshot.resume.command) {
    tailRows.push(React.createElement(Text, { key: "contexts-spacer-1" }, " "));
  }
  if (snapshot.resume.notice) {
    tailRows.push(
      React.createElement(Text, { key: "contexts-notice", color: "green" }, `info: ${compact(snapshot.resume.notice, 120)}`)
    );
  }
  if (snapshot.resume.error) {
    tailRows.push(React.createElement(Text, { key: "contexts-error", color: "red" }, `error: ${compact(snapshot.resume.error, 120)}`));
  }
  if (snapshot.resume.summaryPath) {
    tailRows.push(
      React.createElement(Text, { key: "contexts-summary", color: "gray" }, `summary: ${compact(snapshot.resume.summaryPath, 120)}`)
    );
  }
  if (snapshot.resume.command) {
    tailRows.push(
      React.createElement(Text, { key: "contexts-command", color: "gray" }, `command: ${compact(snapshot.resume.command, 120)}`)
    );
  }

  const availableRows = Math.max(maxRows, 4);
  const listCapacity = Math.max(availableRows - topRows.length - tailRows.length, 1);

  if (total === 0) {
    rows.push(React.createElement(Text, { key: "contexts-empty", color: "yellow" }, "No contexts available."));
  } else {
    const start = Math.max(Math.min(selected - Math.floor(listCapacity / 2), Math.max(total - listCapacity, 0)), 0);
    const end = Math.min(start + listCapacity, total);
    for (let i = start; i < end; i += 1) {
      const ctx = contexts[i];
      const md = ctx?.metadata ?? {};
      const rowSelected = i === selected;
      const marker = rowSelected ? "[•]" : "[ ]";
      const rowColor = viewFocused && rowSelected ? UC_BLUE_LIGHT : "white";
      const sourceInfo = contextBadge(md.source || "unknown");
      const createdAt = formatContextDate(ctx?.created_at);
      const engineer = compact(md.engineer_id ?? "-", 12);
      const sessionId = compact(md.session_id ?? "-", 28);
      rows.push(
        React.createElement(
          Text,
          { key: `contexts-row-${i}`, color: rowColor },
          `${marker} `,
          React.createElement(Text, { color: sourceInfo.color, bold: true }, `[${sourceInfo.text}]`),
          ` ${createdAt} ${engineer} ${sessionId}`
        )
      );
    }
  }
  rows.push(...tailRows);

  return React.createElement(Box, { flexDirection: "column" }, ...padElements(rows, maxRows, "ctx"));
}

function RightPanel({ snapshot, viewFocused, maxRows }) {
  if (snapshot.selectedTab === "configs") return React.createElement(ConfigsContent, { snapshot, viewFocused, maxRows });
  if (snapshot.selectedTab === "contexts") return React.createElement(ContextsContent, { snapshot, viewFocused, maxRows });
  return React.createElement(LogsContent, { snapshot, maxRows });
}

function ResumeTargetPanel({ snapshot, width }) {
  const picker = snapshot.resumeTargetPicker ?? {};
  const options = picker.options ?? [];
  const selectedIndex = Math.max(
    Math.min(picker.selectedIndex ?? 0, Math.max(options.length - 1, 0)),
    0
  );
  const source = sourceLabel(picker.source || "unknown");
  const contextId = compact(picker.contextId ?? "-", 42);

  return React.createElement(
    TitledBox,
    {
      borderStyle: "single",
      titles: ["Continue Conversation"],
      titleJustify: "flex-start",
      borderColor: UC_BRAND_BLUE,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      width,
    },
    React.createElement(Text, { color: "white", bold: true }, `Continue selected context in:`),
    React.createElement(
      Text,
      { color: "gray" },
      `source=${source} id=${contextId}`
    ),
    React.createElement(Box, { height: 1 }),
    ...options.map((option, index) => {
      const selected = index === selectedIndex;
      return React.createElement(
        Text,
        { key: `resume-target-option-${option.id}`, color: selected ? UC_BLUE_LIGHT : "white" },
        selected ? "[•]" : "[ ]",
        " ",
        React.createElement(Text, { color: sourceColor(option.id), bold: true }, option.label)
      );
    }),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: "gray" }, "Choose: ↑/↓, 1/2 or Enter"),
    React.createElement(Text, { color: "gray" }, "Cancel: Esc or ←")
  );
}

function BootstrapPanel({ snapshot, width }) {
  const options = snapshot.bootstrap?.options ?? [];
  const selectedIndex = Math.max(
    Math.min(snapshot.bootstrap?.selectedIndex ?? 0, Math.max(options.length - 1, 0)),
    0
  );
  const sourceLabel = (snapshot.bootstrap?.sourceNames ?? []).join(", ") || "sources";

  return React.createElement(
    TitledBox,
    {
      borderStyle: "single",
      titles: ["First Sync Setup"],
      titleJustify: "flex-start",
      borderColor: UC_BRAND_BLUE,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      width,
    },
    React.createElement(Text, { color: "white", bold: true }, `How should sync start for: ${sourceLabel}?`),
    React.createElement(Box, { height: 1 }),
    ...options.map((option, index) => {
      const selected = index === selectedIndex;
      return React.createElement(
        Box,
        { key: `bootstrap-option-${option.id}`, flexDirection: "column" },
        React.createElement(
          Text,
          { color: selected ? UC_BLUE_LIGHT : "white" },
          selected ? "[•]" : "[ ]",
          ` ${index + 1}. ${option.label}`
        ),
        React.createElement(Text, { color: "gray" }, `    ${option.description}`)
      );
    }),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: "gray" }, "Choose: ↑/↓, 1/2/3 or Enter")
  );
}

function HeaderPanel({ snapshot, stdoutColumns }) {
  const health = snapshot.stats.errors > 0 ? "DEGRADED" : "HEALTHY";
  const healthColor = health === "HEALTHY" ? "green" : "yellow";
  const innerWidth = Math.max(stdoutColumns, 40);
  const spinnerVisualWidth = 28;
  const gap = innerWidth >= 96 ? 3 : 2;
  const artWidth = Math.max(innerWidth - spinnerVisualWidth - gap, 8);
  const artCenterBias = -10;
  const headerArt = heroArtForWidth(artWidth).map((line) => fitToWidth(line, artWidth));
  const artBlockHeight = 12;
  const statusTail = `   Live View ${formatTime(snapshot.now)}   engineer ${snapshot.cfg.engineerId}`;
  const centeredStatus = centerText(`status ${health}${statusTail}`, innerWidth);
  const healthPos = centeredStatus.indexOf(health);
  const statusBefore = healthPos >= 0 ? centeredStatus.slice(0, healthPos) : centeredStatus;
  const statusAfter = healthPos >= 0 ? centeredStatus.slice(healthPos + health.length) : "";

  return React.createElement(
    Box,
    { flexDirection: "column", width: innerWidth },
    React.createElement(
      Box,
      { flexDirection: "row", alignItems: "flex-start", width: innerWidth },
      React.createElement(Spinner, { color: "white" }),
      React.createElement(Box, { width: gap }),
        React.createElement(
          Box,
          { flexDirection: "column", width: artWidth, height: artBlockHeight, alignItems: "center", justifyContent: "center" },
          ...headerArt.map((line, index) =>
          React.createElement(Text, { key: `hero-${index}`, color: "white", bold: true }, centerText(line, artWidth, artCenterBias))
          )
        )
      ),
    React.createElement(
      Text,
      { color: "white" },
      statusBefore,
      healthPos >= 0 ? React.createElement(Text, { color: healthColor, bold: true }, health) : "",
      healthPos >= 0 ? statusAfter : ""
    )
  );
}

function DaemonTui({ snapshot, actions }) {
  const stdoutColumns = process.stdout.columns ?? 120;
  const stdoutRows = process.stdout.rows ?? 40;
  const containerWidth = Math.max(stdoutColumns - 2, 80);
  const contentWidth = Math.max(containerWidth - 2, 40);
  const selectedTabIndex = Math.max(
    MENU_TABS.findIndex((tab) => tab.id === snapshot.selectedTab),
    0
  );
  const bootstrapActive = Boolean(snapshot.bootstrap?.active);
  const resumeTargetPickerActive = Boolean(snapshot.resumeTargetPicker?.active);
  const [focusMode, setFocusMode] = React.useState("menu");
  const [menuIndex, setMenuIndex] = React.useState(selectedTabIndex);

  React.useEffect(() => {
    if (focusMode === "menu") setMenuIndex(selectedTabIndex);
  }, [focusMode, selectedTabIndex]);

  const moveMenuIndex = React.useCallback((delta) => {
    setMenuIndex((prev) => {
      const base = Number.isInteger(prev) ? prev : 0;
      const next = (base + delta + MENU_TABS.length) % MENU_TABS.length;
      actions.selectTab(next);
      return next;
    });
  }, [actions]);

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "\u0003") {
      actions.stop();
      return;
    }
    if (input === "q" || input === "Q") {
      actions.stop();
      return;
    }
    if (bootstrapActive) {
      if (key.upArrow) {
        actions.moveBootstrap?.(-1);
        return;
      }
      if (key.downArrow) {
        actions.moveBootstrap?.(1);
        return;
      }
      if (input === "1" || input === "2" || input === "3") {
        actions.chooseBootstrap?.(Number(input) - 1);
        return;
      }
      if (key.return || input === " ") {
        actions.chooseBootstrap?.(snapshot.bootstrap?.selectedIndex ?? 0);
      }
      return;
    }
    if (resumeTargetPickerActive) {
      if (key.upArrow) {
        actions.moveResumeTarget?.(-1);
        return;
      }
      if (key.downArrow) {
        actions.moveResumeTarget?.(1);
        return;
      }
      if (input === "1" || input === "2") {
        actions.chooseResumeTarget?.(Number(input) - 1);
        return;
      }
      if (key.leftArrow || key.escape) {
        actions.cancelResumeTarget?.();
        return;
      }
      if (key.return || input === " ") {
        actions.chooseResumeTarget?.(snapshot.resumeTargetPicker?.selectedIndex ?? 0);
      }
      return;
    }

    if (focusMode === "menu") {
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
      return;
    }

    if (key.leftArrow || key.escape) {
      setMenuIndex(selectedTabIndex);
      setFocusMode("menu");
      return;
    }

    if (snapshot.selectedTab === "contexts") {
      if (key.upArrow) {
        actions.moveResume(-1);
        return;
      }
      if (key.downArrow) {
        actions.moveResume(1);
        return;
      }
      if (input === "r") {
        actions.refreshResume();
        return;
      }
      if (key.return || input === " ") {
        actions.promptResumeTarget();
        return;
      }
    }

    if (snapshot.selectedTab === "configs") {
      if (key.upArrow) {
        actions.moveConfig(-1);
        return;
      }
      if (key.downArrow) {
        actions.moveConfig(1);
        return;
      }
      if (key.return || key.rightArrow || input === " ") {
        actions.toggleConfig();
      }
    }
  });

  const sidebarWidth = contentWidth >= 140 ? 40 : contentWidth >= 112 ? 34 : 28;
  const fullBottomPanelHeight = Math.max(stdoutRows - 17, 14);
  const bottomPanelHeight = Math.max(Math.floor(fullBottomPanelHeight * 0.67), 10);
  const menuPanelHeight = Math.max(Math.floor(bottomPanelHeight * 0.62), 8);
  const agentsPanelHeight = Math.max(bottomPanelHeight - menuPanelHeight, 4);
  const rightPanelContentRows = Math.max(bottomPanelHeight - 5, 4);

  const activeSources = snapshot.sourceStats.length;
  const activeAgentNames = snapshot.sourceStats.map((source) => source.name).join(", ");

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      TitledBox,
      {
        borderStyle: "single",
        titles: ["UltraContext v1.1"],
        titleJustify: "flex-start",
        borderColor: UC_BRAND_BLUE,
        flexDirection: "column",
        paddingX: 0,
        paddingY: 0,
        width: containerWidth,
      },
      React.createElement(HeaderPanel, { snapshot, stdoutColumns: contentWidth }),
      bootstrapActive
        ? React.createElement(BootstrapPanel, { snapshot, width: contentWidth })
        : resumeTargetPickerActive
          ? React.createElement(ResumeTargetPanel, { snapshot, width: contentWidth })
        : React.createElement(
            Box,
            { flexDirection: "row", alignItems: "flex-start", height: bottomPanelHeight, width: contentWidth },
            React.createElement(
              Box,
              { flexDirection: "column", width: sidebarWidth, marginRight: 0, height: bottomPanelHeight, flexShrink: 0 },
              React.createElement(
                Section,
                {
                  title: "Menu",
                  height: menuPanelHeight,
                  borderColor: "white",
                  titleColor: "white",
                },
                ...MENU_TABS.map((tab, index) =>
                  (() => {
                    const isFocusedInMenu = focusMode === "menu" && index === menuIndex;
                    const isActiveInView = focusMode !== "menu" && tab.id === snapshot.selectedTab;
                    const isHighlighted = isFocusedInMenu || isActiveInView;
                    const marker = isHighlighted ? "[•]" : "[ ]";
                    const markerColor = isHighlighted ? UC_BRAND_BLUE : "white";
                    const labelColor = isHighlighted ? UC_BLUE_LIGHT : "white";

                    return React.createElement(
                      Text,
                      { key: `menu-${tab.id}` },
                      React.createElement(Text, { color: markerColor }, marker),
                      " ",
                      React.createElement(Text, { color: labelColor }, tab.label)
                    );
                  })()
                ),
                React.createElement(Box, { height: 1 }),
                React.createElement(
                  Text,
                  { color: "gray" },
                  focusMode === "menu" ? "↑/↓ navigate + preview, Enter/→ focus view" : "← back to menu"
                )
              ),
              React.createElement(
                Section,
                { title: "Agents", height: agentsPanelHeight, borderColor: "white", titleColor: "white" },
                ...(activeSources === 0
                  ? [React.createElement(Text, { key: "agent-empty", color: "yellow" }, "No agents enabled")]
                  : [React.createElement(Text, { key: "agent-line" }, `[ON] ${activeAgentNames}`)])
              )
            ),
            React.createElement(
              Section,
              {
                title: MENU_TABS.find((tab) => tab.id === snapshot.selectedTab)?.label ?? "View",
                height: bottomPanelHeight,
                grow: true,
                borderColor: "white",
                titleColor: "white",
              },
              React.createElement(RightPanel, {
                snapshot,
                viewFocused: focusMode === "view",
                maxRows: rightPanelContentRows,
              })
            )
          )
    ),
    React.createElement(
      Text,
      { color: "blue" },
      bootstrapActive
        ? "Bootstrap: choose initial mode (↑/↓, 1/2/3, Enter) or q to quit."
        : resumeTargetPickerActive
          ? "Resume target: choose Claude Code or Codex (↑/↓, 1/2, Enter), Esc/← cancel."
        : snapshot.selectedTab === "configs" && focusMode === "view"
          ? "Controls: ↑/↓ select config, Enter/→ apply, ← back, q/Ctrl+C quit."
        : "Controls: ↑/↓ navigate, Enter focus/open, ← back, q/Ctrl+C quit."
    )
  );
}

export function createInkUiController({ getSnapshot, actions }) {
  let app = null;
  const view = () => React.createElement(DaemonTui, { snapshot: getSnapshot(), actions });

  return {
    start() {
      if (app) return;
      app = render(view(), { exitOnCtrlC: false });
    },
    refresh() {
      if (!app) return;
      app.rerender(view());
    },
    stop() {
      if (!app) return;
      app.unmount();
      app = null;
    },
  };
}
