import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stripIDEContextTags } from "../../src/utils.mjs";

describe("stripIDEContextTags", () => {
    it("strips <ide_*> tags and their content", () => {
        const input = "hello <ide_opened_file>some/file.ts</ide_opened_file> world";
        assert.equal(stripIDEContextTags(input), "hello  world");
    });

    it("strips <system-reminder> tags", () => {
        const input = "prompt text <system-reminder>internal stuff</system-reminder> more text";
        assert.equal(stripIDEContextTags(input), "prompt text  more text");
    });

    it("strips <user_query> open/close tags but keeps content", () => {
        const input = "<user_query>Refactor the auth module</user_query>";
        assert.equal(stripIDEContextTags(input), "Refactor the auth module");
    });

    it("strips <local-command-stdout> tags", () => {
        const input = "before <local-command-stdout>ls output</local-command-stdout> after";
        assert.equal(stripIDEContextTags(input), "before  after");
    });

    it("strips multiline IDE tags", () => {
        const input = "hello\n<ide_opened_file>\nline1\nline2\n</ide_opened_file>\nworld";
        assert.equal(stripIDEContextTags(input), "hello\n\nworld");
    });

    it("handles multiple tags in one string", () => {
        const input = "<user_query>text</user_query> <system-reminder>x</system-reminder>";
        assert.equal(stripIDEContextTags(input), "text");
    });

    it("returns empty string for null/undefined", () => {
        assert.equal(stripIDEContextTags(null), "");
        assert.equal(stripIDEContextTags(undefined), "");
        assert.equal(stripIDEContextTags(""), "");
    });

    it("returns text unchanged when no tags present", () => {
        assert.equal(stripIDEContextTags("plain text here"), "plain text here");
    });

    it("collapses excessive blank lines after stripping", () => {
        const input = "before\n\n\n\n\nafter";
        assert.equal(stripIDEContextTags(input), "before\n\nafter");
    });
});
