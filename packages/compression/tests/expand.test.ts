import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import type { Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

const PROSE = 'This is a long message about general topics that could be compressed. '.repeat(5);

describe('uncompress', () => {
  it('roundtrip: compress then uncompress restores exact input', () => {
    const codeProse = 'This is a detailed explanation of how the authentication system works and integrates with the session manager. '.repeat(3);
    const input: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: PROSE }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: `${codeProse}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`` }),
      msg({ id: 'u2', index: 3, role: 'user', content: 'Short.' }),
    ];
    const compressed = compress(input, { recencyWindow: 0 });
    expect(compressed.compression.messages_compressed).toBeGreaterThan(0);

    const expanded = uncompress(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(input);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('preserved messages pass through unchanged', () => {
    const input: Message[] = [
      msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: '2', index: 1, role: 'user', content: 'Short.' }),
    ];
    const compressed = compress(input);
    const expanded = uncompress(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(input);
    expect(expanded.messages_expanded).toBe(0);
    expect(expanded.messages_passthrough).toBe(2);
  });

  it('merged message expands to all originals in correct order', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'b', index: 1, role: 'user', content: PROSE }),
    ];
    const compressed = compress(input, { recencyWindow: 0 });
    expect(compressed.messages.length).toBe(1);

    const expanded = uncompress(compressed.messages, compressed.verbatim);
    expect(expanded.messages.length).toBe(2);
    expect(expanded.messages[0].id).toBe('a');
    expect(expanded.messages[1].id).toBe('b');
    expect(expanded.messages_expanded).toBe(1);
  });

  it('empty input returns empty output', () => {
    const result = uncompress([], {});
    expect(result.messages).toEqual([]);
    expect(result.messages_expanded).toBe(0);
    expect(result.messages_passthrough).toBe(0);
    expect(result.missing_ids).toEqual([]);
  });

  it('non-recursive stops after one expansion layer', () => {
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

    const shallow = uncompress([outerMessage], store);
    expect(shallow.messages_expanded).toBe(1);
    expect(shallow.messages[0].id).toBe('mid');
    expect(shallow.messages[0].content).toBe('[summary: mid-level]');
    const hasMeta = !!(shallow.messages[0].metadata?._uc_original as { ids: string[] })?.ids?.length;
    expect(hasMeta).toBe(true);

    const deep = uncompress([outerMessage], store, { recursive: true });
    expect(deep.messages[0].id).toBe('deep');
    expect(deep.messages[0].content).toBe('Original deep content.');
    expect(deep.messages_expanded).toBe(2);
  });

  it('missing and partial IDs: reports missing, keeps summary as fallback', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'b', index: 1, role: 'user', content: PROSE }),
    ];
    const compressed = compress(input, { recencyWindow: 0 });

    const empty = uncompress(compressed.messages, {});
    expect(empty.missing_ids.sort()).toEqual(['a', 'b']);
    expect(empty.messages.length).toBe(1);
    expect(empty.messages[0].content).toMatch(/^\[summary:/);

    const partial = uncompress(compressed.messages, { a: input[0] });
    expect(partial.messages.find(m => m.id === 'a')).toBeDefined();
    expect(partial.missing_ids).toContain('b');
  });

  it('recursive expansion stops on circular references (depth cap)', () => {
    const msgA: Message = {
      ...msg({ id: 'a', index: 0, role: 'user', content: '[summary: A]' }),
      metadata: { _uc_original: { ids: ['b'], summary_id: 'uc_sum_a', version: 0 } },
    };
    const msgB: Message = {
      ...msg({ id: 'b', index: 0, role: 'user', content: '[summary: B]' }),
      metadata: { _uc_original: { ids: ['a'], summary_id: 'uc_sum_b', version: 0 } },
    };
    const store = { a: msgA, b: msgB };

    const result = uncompress([msgA], store, { recursive: true });
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages_expanded).toBeGreaterThan(0);
  });

  it('function store works without recursive option', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
    ];
    const compressed = compress(input, { recencyWindow: 0 });
    expect(compressed.compression.messages_compressed).toBe(1);

    const lookupFn = (id: string) => compressed.verbatim[id];
    const expanded = uncompress(compressed.messages, lookupFn);
    expect(expanded.messages.length).toBe(1);
    expect(expanded.messages[0].id).toBe('a');
    expect(expanded.messages[0].content).toBe(PROSE);
    expect(expanded.messages_expanded).toBe(1);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('recursive expansion respects MAX_DEPTH and terminates', () => {
    // Build a chain of 20 messages where each points to the next.
    // The initial expandOnce runs before the loop, then the loop runs
    // up to MAX_DEPTH=10 more times, so max total expansions = 11.
    const chain: Message[] = [];
    for (let i = 0; i < 20; i++) {
      chain.push({
        ...msg({ id: `m${i}`, index: 0, role: 'user', content: `[summary: level ${i}]` }),
        metadata: i < 19
          ? { _uc_original: { ids: [`m${i + 1}`], summary_id: `uc_sum_${i}`, version: 0 } }
          : {},
      });
    }
    const store: Record<string, Message> = {};
    for (const m of chain) { store[m.id] = m; }

    const result = uncompress([chain[0]], store, { recursive: true });
    // 1 initial expansion + 10 loop iterations = 11 max
    expect(result.messages_expanded).toBeLessThanOrEqual(11);
    // Should NOT have reached the leaf (m19) since depth cap stops well before
    expect(result.messages[0].id).not.toBe('m19');
    // Should have stopped at m11 (0→1 initial, then 1→2, 2→3, ..., 10→11 in loop)
    expect(result.messages[0].id).toBe('m11');
  });

  it('recursive expansion with function store restores double-compressed messages', () => {
    const input: Message[] = [
      msg({ id: 'a', index: 0, role: 'user', content: PROSE }),
      msg({ id: 'b', index: 1, role: 'user', content: PROSE }),
    ];
    const first = compress(input, { recencyWindow: 0 });

    const round2Input: Message[] = [
      ...first.messages,
      msg({ id: 'c', index: 2, role: 'user', content: PROSE }),
    ];
    const second = compress(round2Input, { recencyWindow: 0 });
    const combined = { ...first.verbatim, ...second.verbatim };

    const lookupFn = (id: string) => combined[id];
    const deep = uncompress(second.messages, lookupFn, { recursive: true });
    expect(deep.messages.length).toBe(3);
    expect(deep.messages.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(deep.messages[0].content).toBe(PROSE);
    expect(deep.missing_ids).toEqual([]);
  });
});
