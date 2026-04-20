import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { shellQuote, appleScriptEscape, parseArgs } from "../../src/cli/switch.mjs";

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    assert.equal(shellQuote("hello"), "'hello'");
  });

  it("handles empty string", () => {
    assert.equal(shellQuote(""), "''");
  });

  it("escapes embedded single quote via '\\''", () => {
    assert.equal(shellQuote("O'Brien"), "'O'\\''Brien'");
  });

  it("preserves spaces and special chars literally", () => {
    assert.equal(shellQuote("my project"), "'my project'");
    assert.equal(shellQuote("/tmp/$(id)"), "'/tmp/$(id)'");
    assert.equal(shellQuote("foo;rm -rf /"), "'foo;rm -rf /'");
    assert.equal(shellQuote("`cat /etc/passwd`"), "'`cat /etc/passwd`'");
  });

  it("handles newlines safely (shell sees literal newline inside quotes)", () => {
    const quoted = shellQuote("line1\nline2");
    assert.ok(quoted.startsWith("'"));
    assert.ok(quoted.endsWith("'"));
    assert.ok(quoted.includes("\n"));
  });

  it("coerces non-string input", () => {
    assert.equal(shellQuote(42), "'42'");
    assert.equal(shellQuote(null), "'null'");
  });
});

describe("appleScriptEscape", () => {
  it("escapes backslash and double quote only", () => {
    assert.equal(appleScriptEscape('a"b\\c'), 'a\\"b\\\\c');
  });

  it("passes safe input unchanged", () => {
    assert.equal(appleScriptEscape("hello world"), "hello world");
    assert.equal(appleScriptEscape("/tmp/foo"), "/tmp/foo");
  });

  it("escapes \\ before \"  (order matters)", () => {
    // input: \"  →  expected: \\\"
    // if order were wrong, \" would double-escape to \\\\\\"
    assert.equal(appleScriptEscape('\\"'), '\\\\\\"');
  });

  it("handles empty string", () => {
    assert.equal(appleScriptEscape(""), "");
  });
});

describe("parseArgs", () => {
  let originalArgv;

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  function setArgs(...args) {
    process.argv = ["node", "u", "switch", ...args];
  }

  it("accepts target only", () => {
    setArgs("codex");
    assert.deepEqual(parseArgs(), { target: "codex", last: null, session: null, noLaunch: false });
  });

  it("accepts target + --last", () => {
    setArgs("codex", "--last", "50");
    assert.deepEqual(parseArgs(), { target: "codex", last: 50, session: null, noLaunch: false });
  });

  it("accepts target + --session", () => {
    setArgs("claude", "--session", "/tmp/session.jsonl");
    assert.deepEqual(parseArgs(), { target: "claude", last: null, session: "/tmp/session.jsonl", noLaunch: false });
  });

  it("accepts target + --no-launch", () => {
    setArgs("codex", "--no-launch");
    assert.deepEqual(parseArgs(), { target: "codex", last: null, session: null, noLaunch: true });
  });

  it("lowercases target", () => {
    setArgs("CODEX");
    assert.equal(parseArgs().target, "codex");
  });

  it("throws on missing target", () => {
    setArgs();
    assert.throws(parseArgs, /Missing target/);
  });

  it("throws on invalid target", () => {
    setArgs("gemini");
    assert.throws(parseArgs, /Invalid target/);
  });

  it("throws on --last non-positive", () => {
    setArgs("codex", "--last", "0");
    assert.throws(parseArgs, /positive number/);
  });

  it("throws on --last negative", () => {
    setArgs("codex", "--last", "-5");
    assert.throws(parseArgs, /positive number/);
  });

  it("throws on --last non-numeric", () => {
    setArgs("codex", "--last", "abc");
    assert.throws(parseArgs, /positive number/);
  });

  it("throws on --session missing value", () => {
    setArgs("codex", "--session");
    assert.throws(parseArgs, /--session requires/);
  });

  it("throws on unknown flag", () => {
    setArgs("codex", "--wrong");
    assert.throws(parseArgs, /Unknown argument/);
  });
});
