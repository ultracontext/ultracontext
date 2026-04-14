import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractModifiedFiles } from "../../src/extract-modified-files.mjs";

describe("extractModifiedFiles", () => {
    it("extracts file paths from Claude tool_use blocks", () => {
        const events = [{
            raw: {
                message: {
                    content: [
                        { type: "tool_use", name: "Write", input: { file_path: "/src/a.ts" } },
                        { type: "tool_use", name: "Edit", input: { file_path: "/src/b.ts", old_string: "x", new_string: "y" } },
                        { type: "tool_use", name: "Read", input: { file_path: "/src/c.ts" } },
                    ],
                },
            },
        }];
        const files = extractModifiedFiles(events, "claude");
        assert.deepEqual(files, ["/src/a.ts", "/src/b.ts"]);
    });

    it("deduplicates file paths", () => {
        const events = [
            { raw: { message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/src/a.ts" } }] } } },
            { raw: { message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/src/a.ts" } }] } } },
        ];
        assert.deepEqual(extractModifiedFiles(events, "claude"), ["/src/a.ts"]);
    });

    it("uses multi-key fallback for file paths", () => {
        const events = [{
            raw: {
                message: {
                    content: [
                        { type: "tool_use", name: "Write", input: { path: "/src/via-path.ts" } },
                        { type: "tool_use", name: "Edit", input: { filePath: "/src/via-filePath.ts" } },
                    ],
                },
            },
        }];
        const files = extractModifiedFiles(events, "claude");
        assert.deepEqual(files, ["/src/via-path.ts", "/src/via-filePath.ts"]);
    });

    it("extracts from Gemini toolCalls array", () => {
        const events = [{
            raw: {
                toolCalls: [
                    { name: "write_file", args: { file_path: "/src/db.ts" } },
                    { name: "edit_file", args: { path: "/src/config.ts" } },
                ],
            },
        }];
        const files = extractModifiedFiles(events, "gemini");
        assert.deepEqual(files, ["/src/db.ts", "/src/config.ts"]);
    });

    it("returns empty array for events with no file mods", () => {
        const events = [
            { raw: { message: { content: [{ type: "text", text: "hello" }] } } },
            { raw: {} },
        ];
        assert.deepEqual(extractModifiedFiles(events, "claude"), []);
    });

    it("handles null/undefined events gracefully", () => {
        assert.deepEqual(extractModifiedFiles([], "claude"), []);
        assert.deepEqual(extractModifiedFiles([null, undefined, {}], "claude"), []);
    });
});
