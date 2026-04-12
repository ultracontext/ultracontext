import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync } from "node:child_process";

import { parseClaudeCodeLine } from "../src/parsers/claude.mjs";
import { parseCodexLine } from "../src/parsers/codex.mjs";

// find local session files, return empty array if none exist
function findFiles(cmd) {
    try {
        const out = execSync(cmd, { encoding: "utf8" }).trim();
        return out ? out.split("\n") : [];
    } catch {
        return [];
    }
}

// parse every line in every file, track stats
function parseAllFiles(files, parser) {
    let totalLines = 0;
    let totalParsed = 0;
    const skippedTypes = {};

    for (const filePath of files) {
        const raw = fs.readFileSync(filePath, "utf8").trim();
        if (!raw) continue;

        const lines = raw.split("\n");
        for (const line of lines) {
            if (!line.trim() || line.includes("\x00")) continue;
            totalLines++;
            const result = parser({ line, filePath });
            if (result) {
                totalParsed++;
            } else {
                // track what JSON type was skipped
                try {
                    const obj = JSON.parse(line);
                    const key = obj.type ?? obj.event ?? "unknown";
                    skippedTypes[key] = (skippedTypes[key] || 0) + 1;
                } catch {
                    skippedTypes["invalid_json"] = (skippedTypes["invalid_json"] || 0) + 1;
                }
            }
        }
    }

    return { totalLines, totalParsed, skippedTypes, fileCount: files.length };
}

// claude local sessions
describe("bulk local: Claude sessions", () => {
    const files = findFiles('find ~/.claude/projects/ -name "*.jsonl" -not -path "*/subagents/*" -type f');

    it("parses 100% of Claude sessions", (t) => {
        if (files.length === 0) {
            t.skip("no local Claude sessions found");
            return;
        }

        const { totalLines, totalParsed, skippedTypes, fileCount } = parseAllFiles(files, parseClaudeCodeLine);

        t.diagnostic(
            `claude bulk: ${fileCount} files, ${totalParsed}/${totalLines} parsed` +
            (Object.keys(skippedTypes).length ? `, skipped: ${JSON.stringify(skippedTypes)}` : "")
        );

        assert.equal(totalParsed, totalLines, `expected 100% parse rate, got ${totalParsed}/${totalLines}`);
    });
});

// codex local sessions
describe("bulk local: Codex sessions", () => {
    const files = findFiles('find ~/.codex/sessions/ -name "*.jsonl" -type f');

    it("parses 100% of Codex sessions", (t) => {
        if (files.length === 0) {
            t.skip("no local Codex sessions found");
            return;
        }

        const { totalLines, totalParsed, skippedTypes, fileCount } = parseAllFiles(files, parseCodexLine);

        t.diagnostic(
            `codex bulk: ${fileCount} files, ${totalParsed}/${totalLines} parsed` +
            (Object.keys(skippedTypes).length ? `, skipped: ${JSON.stringify(skippedTypes)}` : "")
        );

        assert.equal(totalParsed, totalLines, `expected 100% parse rate, got ${totalParsed}/${totalLines}`);
    });
});
