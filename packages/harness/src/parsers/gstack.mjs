import { normalizeWhitespace, safeJsonParse, toMessage } from "../utils.mjs";

// extract project slug from gstack path: ~/.gstack/projects/{slug}/...
function extractGstackProjectSlug(filePath) {
    const match = filePath.match(/\.gstack\/projects\/([^/]+)\//);
    return match?.[1] ?? "unknown-project";
}

// detect gstack file type from filename
function gstackFileType(filePath) {
    const base = filePath.split("/").pop() ?? "";
    if (base === "learnings.jsonl") return "learning";
    if (base === "timeline.jsonl") return "timeline";
    if (base === "resources-shown.jsonl") return "resource";
    if (base.endsWith("-reviews.jsonl")) return "review";
    return "unknown";
}

// parse a single JSONL line from a gstack artifact file
export function parseGstackLine({ line, filePath }) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") return null;

    const projectSlug = extractGstackProjectSlug(filePath);
    const fileType = gstackFileType(filePath);
    const timestamp = parsed.ts ?? parsed.timestamp ?? new Date().toISOString();

    // sessionId = project slug — one context per gstack project
    const sessionId = projectSlug;

    // skill learnings (insights, patterns, preferences)
    if (fileType === "learning") {
        const insight = normalizeWhitespace(parsed.insight);
        if (!insight) return null;
        const skill = parsed.skill ?? "unknown";
        const conf = typeof parsed.confidence === "number" ? ` [${parsed.confidence}/10]` : "";
        return {
            sessionId,
            eventType: `gstack.learning.${parsed.type ?? "insight"}`,
            kind: "system",
            timestamp,
            message: toMessage(`[${skill}]${conf} ${insight}`),
            raw: parsed,
        };
    }

    // skill execution timeline (started, completed)
    if (fileType === "timeline") {
        const skill = parsed.skill ?? "unknown";
        const event = parsed.event ?? "unknown";
        const branch = parsed.branch ? ` (${parsed.branch})` : "";
        const outcome = parsed.outcome ? ` → ${parsed.outcome}` : "";
        const duration = parsed.duration_s ? ` ${parsed.duration_s}s` : "";
        return {
            sessionId,
            eventType: `gstack.timeline.${event}`,
            kind: "system",
            timestamp,
            message: toMessage(`${skill} ${event}${branch}${outcome}${duration}`),
            raw: parsed,
        };
    }

    // code review records
    if (fileType === "review") {
        const skill = parsed.skill ?? "review";
        const score = parsed.overall_score != null ? ` score=${parsed.overall_score}` : "";
        const status = parsed.status ? ` [${parsed.status}]` : "";
        return {
            sessionId,
            eventType: "gstack.review",
            kind: "system",
            timestamp,
            message: toMessage(`${skill}${status}${score}`),
            raw: parsed,
        };
    }

    // external resources shown during sessions
    if (fileType === "resource") {
        const title = normalizeWhitespace(parsed.title);
        const url = parsed.url ?? "";
        if (!title && !url) return null;
        return {
            sessionId,
            eventType: "gstack.resource",
            kind: "system",
            timestamp,
            message: toMessage(title ? `${title} — ${url}` : url),
            raw: parsed,
        };
    }

    return null;
}
