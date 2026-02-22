import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import { analyzeDuplicates } from '../src/dedup.js';
import type { Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

const LONG_CONTENT = 'This is a repeated message with enough content to exceed the two hundred character minimum threshold for dedup eligibility so we can test dedup properly across multiple messages in the conversation. Extra padding here.';
const LONG_CODE_BLOCK = '```typescript\nconst x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\n// more code\nconst a = [1,2,3];\na.forEach(i => console.log(i));\nconst obj = { key: "value", nested: { deep: true } };\nconsole.log(JSON.stringify(obj));\n```';
const LONG_JSON = JSON.stringify({ users: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `user_${i}`, email: `user${i}@example.com`, active: true })) });

describe('analyzeDuplicates', () => {
  it('marks earlier occurrence as duplicate, keeps latest', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: 'different' }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(1);
    expect(result.has(0)).toBe(true);
    expect(result.get(0)!.duplicateOfIndex).toBe(2);
    expect(result.get(0)!.contentLength).toBe(LONG_CONTENT.length);
  });

  it('three copies → first two deduped', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(2);
    expect(result.has(0)).toBe(true);
    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(false);
  });

  it('different pairs handled independently', () => {
    const other = 'A completely different message that is also long enough to exceed the two hundred character threshold for dedup analysis. We need enough text here to satisfy the minimum requirement for processing. Adding extra text.';
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: other }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
      msg({ id: '4', index: 3, content: other }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(2);
    expect(result.has(0)).toBe(true);
    expect(result.has(1)).toBe(true);
    expect(result.get(0)!.duplicateOfIndex).toBe(2);
    expect(result.get(1)!.duplicateOfIndex).toBe(3);
  });

  it('skips system role messages', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'system', content: LONG_CONTENT }),
      msg({ id: '2', index: 1, role: 'system', content: LONG_CONTENT }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(0);
  });

  it('skips messages with tool_calls', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT, tool_calls: [{ id: 'tc1' }] }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(0);
  });

  it('skips already-compressed messages', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: '[summary: previously compressed content that exceeds two hundred characters because we need it to be long enough for the dedup eligibility check to pass the minimum threshold requirement.]' }),
      msg({ id: '2', index: 1, content: '[summary: previously compressed content that exceeds two hundred characters because we need it to be long enough for the dedup eligibility check to pass the minimum threshold requirement.]' }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(0);
  });

  it('skips short messages (< 200 chars)', () => {
    const short = 'Short but identical content.';
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: short }),
      msg({ id: '2', index: 1, content: short }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(0);
  });

  it('prefers recency window occurrence as keep target', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    // recencyStart = 1 → messages at index 1 and 2 are in recency window
    const result = analyzeDuplicates(messages, 1, new Set(['system']));
    expect(result.size).toBe(2);
    // First recency occurrence (index 1) is kept
    expect(result.has(0)).toBe(true);
    expect(result.has(2)).toBe(true);
    expect(result.get(0)!.duplicateOfIndex).toBe(1);
    expect(result.get(2)!.duplicateOfIndex).toBe(1);
  });

  it('near-duplicate (1 char diff) is NOT deduped', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT + 'x' }),
    ];
    const result = analyzeDuplicates(messages, messages.length, new Set(['system']));
    expect(result.size).toBe(0);
  });
});

describe('compress with dedup', () => {
  it('two identical messages → first deduped, last preserved', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.messages[0].content).toContain(`${LONG_CONTENT.length} chars`);
    // Last occurrence gets normal treatment (may be summarized or preserved)
    expect(result.messages[1].content).not.toMatch(/^\[uc:dup/);
    expect(result.compression.messages_deduped).toBe(1);
  });

  it('three copies → first two deduped', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.messages[1].content).toMatch(/^\[uc:dup/);
    expect(result.messages[2].content).not.toMatch(/^\[uc:dup/);
    expect(result.compression.messages_deduped).toBe(2);
  });

  it('dedup: false → no dedup', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: false });
    expect(result.compression.messages_deduped).toBeUndefined();
    expect(result.messages[0].content).not.toMatch(/^\[uc:dup/);
  });

  it('dedup omitted → dedup active (default: true)', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    expect(result.compression.messages_deduped).toBe(1);
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
  });

  it('system role never deduped', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'system', content: LONG_CONTENT }),
      msg({ id: '2', index: 1, role: 'system', content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages[0].content).not.toMatch(/^\[uc:dup/);
    expect(result.messages[1].content).not.toMatch(/^\[uc:dup/);
  });

  it('tool_calls messages never deduped', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'assistant', content: LONG_CONTENT, tool_calls: [{ id: 'tc1' }] }),
      msg({ id: '2', index: 1, role: 'assistant', content: LONG_CONTENT, tool_calls: [{ id: 'tc2' }] }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages[0].content).not.toMatch(/^\[uc:dup/);
    expect(result.messages[1].content).not.toMatch(/^\[uc:dup/);
  });

  it('code blocks get deduped (content prose summarizer skips)', () => {
    // Code block content that would normally be T0-preserved
    const codeContent = LONG_CODE_BLOCK + '\n\nHere is some code that was read from the file system during tool execution.';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: codeContent }),
      msg({ id: '2', index: 1, content: 'something else entirely with enough characters to not be short preserved by the one hundred twenty char threshold check.' }),
      msg({ id: '3', index: 2, role: 'tool', content: codeContent }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.compression.messages_deduped).toBeGreaterThanOrEqual(1);
  });

  it('JSON content gets deduped', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: LONG_JSON }),
      msg({ id: '2', index: 1, content: 'some other message with enough text here to not be auto-preserved by the short message rule which is one hundred twenty chars. Extra padding needed.' }),
      msg({ id: '3', index: 2, role: 'tool', content: LONG_JSON }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.compression.messages_deduped).toBeGreaterThanOrEqual(1);
  });

  it('recency window respected — dedup only outside window', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    // recencyWindow: 2 → last 2 messages preserved by recency
    // First message is duplicate outside window → deduped
    const result = compress(messages, { recencyWindow: 2, dedup: true });
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    // Last 2 are in recency window, preserved
    expect(result.messages[1].content).toBe(LONG_CONTENT);
    expect(result.messages[2].content).toBe(LONG_CONTENT);
  });

  it('round-trip: compress(dedup) → uncompress = original messages', () => {
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, content: LONG_CONTENT }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: 'Short reply.' }),
      msg({ id: 'u2', index: 3, content: LONG_CONTENT }),
    ];
    const compressed = compress(messages, { recencyWindow: 0, dedup: true });
    expect(compressed.compression.messages_deduped).toBeGreaterThanOrEqual(1);
    const expanded = uncompress(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('dedup + prose summarization coexist', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(5);
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    // First message deduped
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    // Middle message summarized
    expect(result.messages[1].content).toMatch(/^\[summary:/);
    // Last duplicate preserved (or summarized, not deduped)
    expect(result.messages[2].content).not.toMatch(/^\[uc:dup/);
    expect(result.compression.messages_deduped).toBe(1);
    expect(result.compression.messages_compressed).toBeGreaterThan(1);
  });

  it('dedup + code-split coexist', () => {
    const proseWithCode = 'This is a detailed explanation of how the authentication system works and integrates with the session manager. '.repeat(3)
      + '\n\n```ts\nconst x = await auth.getToken();\n```';
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, role: 'assistant', content: proseWithCode }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    // First message deduped
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    // Middle message code-split compressed
    expect(result.messages[1].content).toContain('```ts');
    expect(result.compression.messages_deduped).toBe(1);
  });

  it('near-duplicate (1 char diff) → NOT deduped', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_CONTENT }),
      msg({ id: '2', index: 1, role: 'assistant', content: LONG_CONTENT + '!' }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].content).not.toMatch(/^\[uc:dup/);
    expect(result.messages[1].content).not.toMatch(/^\[uc:dup/);
  });

  it('stats: messages_deduped > 0 and ratio > 1', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.compression.messages_deduped).toBeGreaterThan(0);
    expect(result.compression.ratio).toBeGreaterThan(1);
  });

  it('verbatim map contains deduped originals', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.verbatim['1']).toBeDefined();
    expect(result.verbatim['1'].content).toBe(LONG_CONTENT);
  });

  it('idempotent: re-compressing dedup output does not break', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const first = compress(messages, { recencyWindow: 0, dedup: true });
    expect(first.compression.messages_deduped).toBeGreaterThan(0);
    // The dedup replacement is <120 chars → auto-preserved by short message rule
    const second = compress(first.messages, { recencyWindow: 0, dedup: true });
    expect(second.compression.messages_deduped ?? 0).toBe(0);
    expect(second.messages[0].content).toBe(first.messages[0].content);
  });

  it('dedup with tokenBudget', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { tokenBudget: 200, dedup: true });
    expect(typeof result.fits).toBe('boolean');
    expect(typeof result.tokenCount).toBe('number');
  });

  it('dedup with async summarizer', async () => {
    const mockSummarizer = async (text: string) => text.slice(0, 50) + '...';
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = await compress(messages, { recencyWindow: 0, dedup: true, summarizer: mockSummarizer });
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.compression.messages_deduped).toBe(1);
  });

  it('dedup with tokenBudget and async summarizer', async () => {
    const mockSummarizer = async (text: string) => text.slice(0, 50) + '...';
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
      msg({ id: '3', index: 2, content: LONG_CONTENT }),
    ];
    const result = await compress(messages, { tokenBudget: 200, dedup: true, summarizer: mockSummarizer });
    expect(typeof result.fits).toBe('boolean');
    expect(typeof result.tokenCount).toBe('number');
  });

  it('dedup replacement is always shorter than original', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    const dedupMsg = result.messages[0];
    expect(dedupMsg.content!.length).toBeLessThan(LONG_CONTENT.length);
    // Replacement should be compact
    expect(dedupMsg.content!.length).toBeLessThan(120);
  });

  it('_uc_original metadata present on deduped messages', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    const meta = result.messages[0].metadata?._uc_original as { ids: string[]; version: number };
    expect(meta).toBeDefined();
    expect(meta.ids).toEqual(['1']);
    expect(meta.version).toBe(0);
  });

  it('dedup across different roles works', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_CONTENT }),
      msg({ id: '2', index: 1, role: 'tool', content: LONG_CONTENT }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    // One of them should be deduped (the earlier one)
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.compression.messages_deduped).toBe(1);
  });

  it('no dedup when all occurrences are in recency window', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG_CONTENT }),
      msg({ id: '2', index: 1, content: LONG_CONTENT }),
    ];
    // recencyWindow covers all messages → all preserved, no dedup annotations created
    const result = compress(messages, { recencyWindow: 2, dedup: true });
    expect(result.messages[0].content).toBe(LONG_CONTENT);
    expect(result.messages[1].content).toBe(LONG_CONTENT);
    expect(result.compression.messages_deduped).toBeUndefined();
  });
});
