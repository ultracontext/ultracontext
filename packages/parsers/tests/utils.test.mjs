import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isSafeCwd, claudeProjectDirName } from "../src/utils.mjs";

describe("isSafeCwd", () => {
    it("accepts plain absolute path", () => {
        assert.equal(isSafeCwd("/tmp/foo"), true);
        assert.equal(isSafeCwd("/Users/alice/Code/app"), true);
    });

    it("rejects empty, non-string, relative", () => {
        for (const bad of ["", null, undefined, 0, false, ".", "./x", "relative/path"]) {
            assert.equal(isSafeCwd(bad), false, `should reject ${JSON.stringify(bad)}`);
        }
    });

    it("rejects all C0 control chars", () => {
        for (let code = 0; code <= 0x1f; code++) {
            const ch = String.fromCharCode(code);
            assert.equal(isSafeCwd(`/tmp/bad${ch}x`), false, `should reject U+${code.toString(16).padStart(4, "0")}`);
        }
    });

    it("rejects DEL and unicode line separators", () => {
        assert.equal(isSafeCwd("/tmp/bad\x7fafter"), false, "DEL");
        assert.equal(isSafeCwd("/tmp/bad\u0085after"), false, "NEL");
        assert.equal(isSafeCwd("/tmp/bad\u2028after"), false, "LS");
        assert.equal(isSafeCwd("/tmp/bad\u2029after"), false, "PS");
    });

    it("rejects non-canonical paths (..)", () => {
        assert.equal(isSafeCwd("/tmp/foo/../etc"), false);
        assert.equal(isSafeCwd("/tmp/./foo"), false);
        assert.equal(isSafeCwd("/tmp//foo"), false);
    });

    it("accepts canonical paths with dashes, dots, underscores", () => {
        assert.equal(isSafeCwd("/opt/my-app_v2.0/bin"), true);
    });
});

describe("claudeProjectDirName", () => {
    it("produces a filesystem-safe slug from a cwd", () => {
        assert.equal(claudeProjectDirName("/Users/alice/Code/app"), "-Users-alice-Code-app");
    });

    it("falls back to process.cwd() for empty input", () => {
        const result = claudeProjectDirName("");
        assert.ok(result.length > 0);
        assert.match(result, /^[A-Za-z0-9._-]+$/);
    });

    it("sanitizes special chars", () => {
        assert.match(claudeProjectDirName("/tmp/my project!@#"), /^[A-Za-z0-9._-]+$/);
    });
});
