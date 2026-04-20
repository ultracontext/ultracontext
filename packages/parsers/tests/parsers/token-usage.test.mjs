import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractClaudeTokenUsage } from "../../src/token-usage.mjs";

describe("extractClaudeTokenUsage", () => {
    it("aggregates token usage from assistant events", () => {
        const events = [
            {
                kind: "assistant",
                raw: { message: { id: "msg-1", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } } },
            },
            {
                kind: "assistant",
                raw: { message: { id: "msg-2", usage: { input_tokens: 200, output_tokens: 80 } } },
            },
        ];
        const usage = extractClaudeTokenUsage(events);
        assert.equal(usage.inputTokens, 300);
        assert.equal(usage.outputTokens, 130);
        assert.equal(usage.cacheCreation, 10);
        assert.equal(usage.cacheRead, 5);
        assert.equal(usage.apiCallCount, 2);
    });

    it("deduplicates by message.id, keeping highest output_tokens", () => {
        const events = [
            { kind: "assistant", raw: { message: { id: "msg-1", usage: { input_tokens: 100, output_tokens: 20 } } } },
            { kind: "assistant", raw: { message: { id: "msg-1", usage: { input_tokens: 100, output_tokens: 50 } } } },
            { kind: "assistant", raw: { message: { id: "msg-1", usage: { input_tokens: 100, output_tokens: 30 } } } },
        ];
        const usage = extractClaudeTokenUsage(events);
        assert.equal(usage.inputTokens, 100);
        assert.equal(usage.outputTokens, 50);
        assert.equal(usage.apiCallCount, 1);
    });

    it("ignores non-assistant events", () => {
        const events = [
            { kind: "user", raw: { message: { id: "msg-1", usage: { input_tokens: 999 } } } },
            { kind: "system", raw: { message: { id: "msg-2", usage: { input_tokens: 888 } } } },
        ];
        const usage = extractClaudeTokenUsage(events);
        assert.equal(usage.inputTokens, 0);
        assert.equal(usage.apiCallCount, 0);
    });

    it("handles events without usage data", () => {
        const events = [
            { kind: "assistant", raw: { message: { id: "msg-1" } } },
            { kind: "assistant", raw: {} },
        ];
        const usage = extractClaudeTokenUsage(events);
        assert.equal(usage.apiCallCount, 0);
    });

    it("returns zeros for empty events", () => {
        const usage = extractClaudeTokenUsage([]);
        assert.equal(usage.inputTokens, 0);
        assert.equal(usage.outputTokens, 0);
        assert.equal(usage.cacheCreation, 0);
        assert.equal(usage.cacheRead, 0);
        assert.equal(usage.apiCallCount, 0);
    });
});
