import figlet from "figlet";

const HERO_TEXT = "UltraContext";
const HERO_FONT_ORDER = ["Standard", "Small", "Mini", "Slant"];
const HERO_ART_CACHE = new Map();

function trimBlankEdgeLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !String(lines[start] ?? "").trim()) start += 1;
  while (end > start && !String(lines[end - 1] ?? "").trim()) end -= 1;
  return lines.slice(start, end);
}

const HERO_FONT_ART = HERO_FONT_ORDER.map((font) => {
  try {
    const raw = figlet.textSync(HERO_TEXT, {
      font,
      horizontalLayout: "default",
      verticalLayout: "default",
    });
    const lines = trimBlankEdgeLines(
      raw
        .replace(/\n+$/g, "")
        .split("\n")
        .map((line) => line.replace(/\s+$/g, ""))
    );
    const width = Math.max(...lines.map((line) => line.length), 0);
    return { lines, width };
  } catch {
    return null;
  }
}).filter(Boolean);

export function heroArtForWidth(columns) {
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
