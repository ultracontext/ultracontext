import { describe, it, expect } from 'vitest';
import { compressMessages } from '../src/compress.js';
import { expandMessages, searchVerbatim } from '../src/expand.js';
import type { Message, VerbatimMap } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

const PROSE = 'This is a long message about general topics that could be compressed. '.repeat(5);

describe('expandMessages', () => {
  it('roundtrip: compress then expand restores exact input', () => {
    const codeProse = 'This is a detailed explanation of how the authentication system works and integrates with the session manager. '.repeat(3);
    const input: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: PROSE }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: `${codeProse}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`` }),
      msg({ id: 'u2', index: 3, role: 'user', content: 'Short.' }),
    ];
    const compressed = compressMessages(input, { recencyWindow: 0 });
    expect(compressed.compression.messages_compressed).toBeGreaterThan(0);

    const expanded = expandMessages(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(input);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('preserved messages pass through unchanged', () => {
    const input: Message[] = [
      msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: '2', index: 1, role: 'user', content: 'Short.' }),
    ];
    const compressed = compressMessages(input);
    const expanded = expandMessages(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(input);
    expect(expanded.messages_expanded).toBe(0);
    expect(expanded.messages_passthrough).toBe(2);
  });

  it('merged message expands to all originals in correct order', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'b', index: 1, role: 'user', content: PROSE }),
    ];
    const compressed = compressMessages(input, { recencyWindow: 0 });
    expect(compressed.messages.length).toBe(1);

    const expanded = expandMessages(compressed.messages, compressed.verbatim);
    expect(expanded.messages.length).toBe(2);
    expect(expanded.messages[0].id).toBe('a');
    expect(expanded.messages[1].id).toBe('b');
    expect(expanded.messages_expanded).toBe(1);
  });

  it('empty input returns empty output', () => {
    const result = expandMessages([], {});
    expect(result.messages).toEqual([]);
    expect(result.messages_expanded).toBe(0);
    expect(result.messages_passthrough).toBe(0);
    expect(result.missing_ids).toEqual([]);
  });

  it('non-recursive stops after one expansion layer', () => {
    // Manually construct a two-layer nesting:
    // outer message points to "mid" which itself has _uc_original pointing to "deep"
    const deepOriginal: Message = msg({ id: 'deep', index: 0, role: 'user', content: 'Original deep content.' });
    const midMessage: Message = {
      ...msg({ id: 'mid', index: 0, role: 'user', content: '[summary: mid-level]' }),
      metadata: { _uc_original: { ids: ['deep'], summary_id: 'uc_sum_test1', version: 0 } },
    };
    const outerMessage: Message = {
      ...msg({ id: 'outer', index: 0, role: 'user', content: '[summary: outer-level]' }),
      metadata: { _uc_original: { ids: ['mid'], summary_id: 'uc_sum_test2', version: 0 } },
    };

    const store = { mid: midMessage, deep: deepOriginal };

    // Non-recursive: outer → mid, but mid still has _uc_original
    const shallow = expandMessages([outerMessage], store);
    expect(shallow.messages_expanded).toBe(1);
    expect(shallow.messages[0].id).toBe('mid');
    expect(shallow.messages[0].content).toBe('[summary: mid-level]');
    const hasMeta = !!(shallow.messages[0].metadata?._uc_original as { ids: string[] })?.ids?.length;
    expect(hasMeta).toBe(true);

    // Recursive: outer → mid → deep
    const deep = expandMessages([outerMessage], store, { recursive: true });
    expect(deep.messages[0].id).toBe('deep');
    expect(deep.messages[0].content).toBe('Original deep content.');
    expect(deep.messages_expanded).toBe(2);
  });

  it('missing and partial IDs: reports missing, keeps summary as fallback', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'b', index: 1, role: 'user', content: PROSE }),
    ];
    const compressed = compressMessages(input, { recencyWindow: 0 });

    // Completely empty store — summary kept as fallback
    const empty = expandMessages(compressed.messages, {});
    expect(empty.missing_ids.sort()).toEqual(['a', 'b']);
    expect(empty.messages.length).toBe(1);
    expect(empty.messages[0].content).toMatch(/^\[summary:/);

    // Partial store — found IDs expanded, missing reported
    const partial = expandMessages(compressed.messages, { a: input[0] });
    expect(partial.messages.find(m => m.id === 'a')).toBeDefined();
    expect(partial.missing_ids).toContain('b');
  });

  it('recursive expansion with function store restores double-compressed messages', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'b', index: 1, role: 'user', content: PROSE }),
    ];
    const first = compressMessages(input, { recencyWindow: 0 });

    const round2Input: Message[] = [
      ...first.messages,
      msg({ id: 'c', index: 2, role: 'user', content: PROSE }),
    ];
    const second = compressMessages(round2Input, { recencyWindow: 0 });
    const combined = { ...first.verbatim, ...second.verbatim };

    // Function store variant
    const lookupFn = (id: string) => combined[id];
    const deep = expandMessages(second.messages, lookupFn, { recursive: true });
    expect(deep.messages.length).toBe(3);
    expect(deep.messages.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(deep.messages[0].content).toBe(PROSE);
    expect(deep.missing_ids).toEqual([]);
  });
});

describe('searchVerbatim', () => {
  it('returns matches grouped by summaryId', () => {
    const input: Message[] = [
      msg({ id: 'u1', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'u2', index: 1, role: 'user', content: PROSE }),
    ];
    const { messages: compressed, verbatim } = compressMessages(input, { recencyWindow: 0 });
    const results = searchVerbatim(compressed, verbatim, /general topics/);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].summaryId).toMatch(/^uc_sum_/);
    expect(results[0].matches).toContain('general topics');
  });

  it('returns [] when no matches', () => {
    const input: Message[] = [
      msg({ id: 'u1', index: 0, role: 'user', content: PROSE }),
    ];
    const { messages: compressed, verbatim } = compressMessages(input, { recencyWindow: 0 });
    const results = searchVerbatim(compressed, verbatim, /ZZZZNOTFOUND/);
    expect(results).toEqual([]);
  });

  it('works with string pattern', () => {
    const input: Message[] = [
      msg({ id: 'u1', index: 0, role: 'user', content: PROSE }),
    ];
    const { messages: compressed, verbatim } = compressMessages(input, { recencyWindow: 0 });
    const results = searchVerbatim(compressed, verbatim, 'general topics');
    expect(results.length).toBe(1);
    expect(results[0].matches.length).toBeGreaterThan(0);
  });

  it('works with RegExp with flags (case-insensitive)', () => {
    const input: Message[] = [
      msg({ id: 'u1', index: 0, role: 'user', content: PROSE }),
    ];
    const { messages: compressed, verbatim } = compressMessages(input, { recencyWindow: 0 });
    const results = searchVerbatim(compressed, verbatim, /GENERAL TOPICS/gi);
    expect(results.length).toBe(1);
    expect(results[0].matches[0]).toBe('general topics');
  });

  it('multiple matches per message', () => {
    const input: Message[] = [
      msg({ id: 'u1', index: 0, role: 'user', content: PROSE }),
    ];
    const { messages: compressed, verbatim } = compressMessages(input, { recencyWindow: 0 });
    // PROSE repeats "general topics" 5 times
    const results = searchVerbatim(compressed, verbatim, /general topics/g);
    expect(results.length).toBe(1);
    expect(results[0].matches.length).toBe(5);
  });

  it('handles merged messages (multi-id summary)', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'b', index: 1, role: 'user', content: PROSE }),
    ];
    const { messages: compressed, verbatim } = compressMessages(input, { recencyWindow: 0 });
    // Both originals should be in verbatim and share the same summaryId
    const results = searchVerbatim(compressed, verbatim, /general topics/);
    expect(results.length).toBe(2); // one per original message
    expect(results[0].summaryId).toBe(results[1].summaryId);
    expect(results[0].summaryId).toMatch(/^uc_sum_/);
  });

  it('empty verbatim returns []', () => {
    const compressed: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: 'test' }),
    ];
    const results = searchVerbatim(compressed, {}, /test/);
    expect(results).toEqual([]);
  });

  it('falls back to messageId when not found in compressed', () => {
    // Verbatim with an entry not referenced in compressed messages
    const verbatim: VerbatimMap = {
      orphan: msg({ id: 'orphan', index: 0, role: 'user', content: 'find me here' }),
    };
    const results = searchVerbatim([], verbatim, /find me/);
    expect(results.length).toBe(1);
    expect(results[0].summaryId).toBe('orphan');
    expect(results[0].messageId).toBe('orphan');
  });
});
