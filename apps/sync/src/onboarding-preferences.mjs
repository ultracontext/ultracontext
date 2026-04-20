import path from "node:path";

import { normalizeBootstrapMode } from "./protocol.mjs";

export const PRIMARY_CAPTURE_AGENTS = ["claude", "codex", "cursor"];

// concrete agents the user can pick in the wizard (order = display order)
export const ONBOARDING_AGENT_OPTIONS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
];

// meta row shown first — a shortcut that toggles all concrete agents at once
export const ONBOARDING_AGENT_ALL_OPTION = { id: "all", label: "All (recommended)" };

export const ONBOARDING_CAPTURE_OPTIONS = [
  { id: "all", label: "All contexts (recommended)" },
  { id: "future_only", label: "Just from now to the future" },
];

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeCaptureAgents(raw) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\n]/)
      : [];

  const normalized = uniqueStrings(
    values
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => PRIMARY_CAPTURE_AGENTS.includes(value))
  );

  return normalized.length > 0 ? normalized : PRIMARY_CAPTURE_AGENTS.slice();
}

export function isPrimaryAgentSourceEnabled(sourceName, captureAgents) {
  const normalizedSource = String(sourceName ?? "").trim().toLowerCase();
  if (!PRIMARY_CAPTURE_AGENTS.includes(normalizedSource)) return true;
  return normalizeCaptureAgents(captureAgents).includes(normalizedSource);
}

export function normalizeProjectPaths(raw) {
  if (raw === undefined || raw === null) return [];

  const values = Array.isArray(raw) ? raw : [raw];
  const normalized = uniqueStrings(
    values
      .flatMap((value) => String(value ?? "").split(/[,\n]/))
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => path.resolve(value))
  );

  return normalized;
}

export function matchesConfiguredProjectPath(projectPaths, candidatePath) {
  const configured = normalizeProjectPaths(projectPaths);
  if (configured.length === 0) return true;

  const candidate = String(candidatePath ?? "").trim();
  if (!candidate) return false;

  const resolvedCandidate = path.resolve(candidate);
  return configured.some((projectPath) => (
    resolvedCandidate === projectPath ||
    resolvedCandidate.startsWith(`${projectPath}${path.sep}`)
  ));
}

export function normalizeAutoCaptureMode(raw) {
  const value = String(raw ?? "all").trim().toLowerCase();
  if (value === "future_only" || value === "future" || value === "new_only") return "future_only";
  return "all";
}

export function bootstrapModeFromAutoCaptureMode(raw) {
  return normalizeAutoCaptureMode(raw) === "future_only" ? "new_only" : "all";
}

export function autoCaptureModeFromBootstrapMode(raw) {
  return normalizeBootstrapMode(raw) === "new_only" ? "future_only" : "all";
}

// projectPaths: empty array means "capture every project"; non-empty scopes capture
// to those paths. There is no separate projectScope input — the list IS the scope.
export function buildOnboardingConfigPatch({
  captureAgents = PRIMARY_CAPTURE_AGENTS,
  projectPaths = [],
  autoCaptureMode = "all",
} = {}) {
  return {
    captureAgents: normalizeCaptureAgents(captureAgents),
    projectPaths: normalizeProjectPaths(projectPaths),
    bootstrapMode: bootstrapModeFromAutoCaptureMode(autoCaptureMode),
  };
}
