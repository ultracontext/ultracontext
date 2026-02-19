import { describe, it, expect } from 'vitest';
import { compressMessages } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

describe('compressMessages', () => {
  describe('preservation rules', () => {
    it('preserves system role by default', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'You are a helpful assistant. '.repeat(20) }),
        msg({ id: '2', index: 1, role: 'user', content: 'This is a long user message that talks about many things and goes on for a while to exceed the threshold. '.repeat(10) }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toContain('You are a helpful assistant');
      expect(result.compression.messages_preserved).toBeGreaterThanOrEqual(1);
    });

    it('preserves tool messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: 'Tool output result that is fairly long and contains detailed information about the operation. '.repeat(5) }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].role).toBe('tool');
      expect(result.messages[0].content).toContain('Tool output result');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves function messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'function', content: 'Function result with enough content to pass the length threshold easily here. '.repeat(5) }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].role).toBe('function');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves messages with tool_calls', () => {
      const messages: Message[] = [
        msg({
          id: '1',
          index: 0,
          role: 'assistant',
          content: 'Let me help with that request by calling the appropriate function to get the data. '.repeat(5),
          tool_calls: [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }],
        }),
      ];
      const result = compressMessages(messages);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves short messages (< 120 chars)', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: 'Hello there!' }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].content).toBe('Hello there!');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves messages with code blocks', () => {
      const messages: Message[] = [
        msg({
          id: '1',
          index: 0,
          role: 'assistant',
          content: '```typescript\nconst x = 1;\nconst y = 2;\nreturn x + y;\n```\nHere is the code you requested for the addition function.',
        }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].content).toContain('```');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves messages with URLs', () => {
      const messages: Message[] = [
        msg({
          id: '1',
          index: 0,
          role: 'assistant',
          content: 'Check out the documentation at https://docs.example.com/api/v2/reference for more details on the endpoints.',
        }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].content).toContain('https://docs.example.com');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves messages with file paths', () => {
      const messages: Message[] = [
        msg({
          id: '1',
          index: 0,
          role: 'assistant',
          content: 'The configuration file is located at /etc/ultracontext/config.json and should be updated with the new settings.',
        }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].content).toContain('/etc/ultracontext/config.json');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves messages with valid JSON content', () => {
      const jsonContent = JSON.stringify({ key: 'value', nested: { a: 1, b: [1, 2, 3] } }, null, 2);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content: jsonContent }),
      ];
      const result = compressMessages(messages);
      expect(result.messages[0].content).toBe(jsonContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('respects custom preserve roles', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'developer', content: 'Important developer instructions that should be preserved across all interactions. '.repeat(5) }),
        msg({ id: '2', index: 1, role: 'user', content: 'A long message about general topics that could be compressed since it has no special content. '.repeat(10) }),
      ];
      const result = compressMessages(messages, { preserve: ['developer'] });
      expect(result.messages[0].role).toBe('developer');
      expect(result.messages[0].content).toContain('Important developer instructions');
    });
  });

  describe('compression behavior', () => {
    it('merges consecutive non-preserved turns', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
        msg({ id: '3', index: 2, role: 'user', content: prose }),
      ];
      const result = compressMessages(messages);
      // Should merge all 3 into one
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content).toMatch(/\[summary:.*\(\d+ messages merged\)\]/);
      expect(result.compression.messages_compressed).toBe(3);
    });

    it('compresses large prose to bracketed summary', () => {
      const largeProse = 'This is the first sentence about architecture. ' +
        'It continues with many more sentences about various aspects of the system design. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'You are helpful.' }),
        msg({ id: '2', index: 1, role: 'user', content: largeProse }),
      ];
      const result = compressMessages(messages);
      // System preserved, user compressed
      expect(result.messages.length).toBe(2);
      const compressed = result.messages[1];
      expect(compressed.content).toMatch(/^\[summary: /);
      expect(compressed.content).toContain('This is the first sentence about architecture');
    });

    it('writes _uc_original metadata on merged messages', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: 'a', index: 0, role: 'user', content: prose }),
        msg({ id: 'b', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compressMessages(messages);
      const meta = result.messages[0].metadata?._uc_original as { ids: string[]; version: number };
      expect(meta).toBeDefined();
      expect(meta.ids).toEqual(['a', 'b']);
      expect(meta.version).toBe(0);
    });

    it('writes _uc_original metadata on large prose compression', () => {
      const largeProse = 'First sentence here. ' + 'More text. '.repeat(100);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: largeProse }),
      ];
      const result = compressMessages(messages);
      const compressed = result.messages[1];
      const meta = compressed.metadata?._uc_original as { id: string; version: number };
      expect(meta).toBeDefined();
      expect(meta.id).toBe('2');
      expect(meta.version).toBe(0);
    });
  });

  describe('stats and edge cases', () => {
    it('returns correct compression ratio', () => {
      const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compressMessages(messages);
      expect(result.compression.ratio).toBeGreaterThan(1);
    });

    it('returns ratio 1.0 when all preserved', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: 'Short msg.' }),
      ];
      const result = compressMessages(messages);
      expect(result.compression.ratio).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
    });

    it('handles empty input', () => {
      const result = compressMessages([]);
      expect(result.messages).toEqual([]);
      expect(result.compression.ratio).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
      expect(result.compression.messages_preserved).toBe(0);
    });

    it('throws on mode: lossy', () => {
      expect(() =>
        compressMessages(
          [msg({ id: '1', index: 0, role: 'user', content: 'test' })],
          { mode: 'lossy' },
        ),
      ).toThrow('501');
    });
  });

  describe('interleaving and grouping', () => {
    it('splits compressed groups around a preserved message', () => {
      const longProse = 'This talks about general topics without any special formatting or code. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: longProse }),
        msg({ id: '2', index: 1, role: 'tool', content: 'Tool result' }),
        msg({ id: '3', index: 2, role: 'user', content: longProse }),
      ];
      const result = compressMessages(messages);
      expect(result.messages.length).toBe(3);
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.messages[1].role).toBe('tool');
      expect(result.messages[1].content).toBe('Tool result');
      expect(result.messages[2].content).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(2);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('merges consecutive compressible but splits at each preserved boundary', () => {
      const longProse = 'This talks about general topics without any special formatting or code. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: longProse }),
        msg({ id: '2', index: 1, role: 'assistant', content: longProse }),
        msg({ id: '3', index: 2, role: 'tool', content: 'Result' }),
        msg({ id: '4', index: 3, role: 'user', content: longProse }),
        msg({ id: '5', index: 4, role: 'assistant', content: longProse }),
      ];
      const result = compressMessages(messages);
      // [merged 1+2] [preserved 3] [merged 4+5]
      expect(result.messages.length).toBe(3);
      const meta0 = result.messages[0].metadata?._uc_original as { ids: string[] };
      expect(meta0.ids).toEqual(['1', '2']);
      const meta2 = result.messages[2].metadata?._uc_original as { ids: string[] };
      expect(meta2.ids).toEqual(['4', '5']);
    });
  });

  describe('medium prose (120-800 chars)', () => {
    it('compresses a single isolated message in the 120-800 range', () => {
      // ~320 chars of pure prose, no T0 triggers
      const mediumProse = 'This talks about general topics without any special formatting or patterns that would trigger preservation rules. '.repeat(3);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: mediumProse }),
        msg({ id: '3', index: 2, role: 'user', content: 'Thanks.' }),
      ];
      const result = compressMessages(messages);
      expect(result.messages.length).toBe(3);
      const compressed = result.messages[1];
      expect(compressed.content).toMatch(/\[summary:.*\(1 messages merged\)\]/);
      const meta = compressed.metadata?._uc_original as { ids: string[]; version: number };
      expect(meta.ids).toEqual(['2']);
      expect(meta.version).toBe(0);
    });

    it('uses {ids} shape (not {id}) for single-message merge path', () => {
      const mediumProse = 'This talks about general topics without any special formatting or patterns that would trigger preservation rules. '.repeat(3);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'user', content: mediumProse }),
      ];
      const result = compressMessages(messages);
      const meta = result.messages[1].metadata?._uc_original as Record<string, unknown>;
      // Medium prose path uses { ids: [...] }, large prose uses { id: ... }
      expect(meta).toHaveProperty('ids');
      expect(meta).not.toHaveProperty('id');
    });
  });

  describe('edge cases', () => {
    it('compresses system role when preserve is empty array', () => {
      const longSystem = 'You are a helpful assistant who provides detailed and comprehensive responses to all queries. '.repeat(12);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: longSystem }),
      ];
      const result = compressMessages(messages, { preserve: [] });
      expect(result.compression.messages_compressed).toBe(1);
      expect(result.messages[0].content).toMatch(/^\[summary:/);
    });

    it('preserves messages with undefined content (treated as short)', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, content: undefined as unknown as string }),
      ];
      const result = compressMessages(messages);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves existing metadata alongside _uc_original', () => {
      const largeProse = 'First sentence about some topic. ' + 'More text follows here. '.repeat(50);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'user', content: largeProse, metadata: { custom: 'value', priority: 1 } }),
      ];
      const result = compressMessages(messages);
      const compressed = result.messages[1];
      expect(compressed.metadata?.custom).toBe('value');
      expect(compressed.metadata?.priority).toBe(1);
      expect(compressed.metadata?._uc_original).toBeDefined();
    });

    it('maintains message order after compression', () => {
      const longProse = 'General discussion about various topics without special patterns. '.repeat(15);
      const messages: Message[] = [
        msg({ id: 'a', index: 0, role: 'system', content: 'System.' }),
        msg({ id: 'b', index: 1, role: 'user', content: longProse }),
        msg({ id: 'c', index: 2, role: 'tool', content: 'Result' }),
        msg({ id: 'd', index: 3, role: 'user', content: longProse }),
        msg({ id: 'e', index: 4, role: 'user', content: 'Thanks' }),
      ];
      const result = compressMessages(messages);
      const ids = result.messages.map(m => m.id);
      expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('preserves original id and role on compressed messages', () => {
      const longProse = 'General discussion about various topics without special patterns. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'assistant', content: longProse }),
      ];
      const result = compressMessages(messages);
      const compressed = result.messages[1];
      expect(compressed.id).toBe('2');
      expect(compressed.role).toBe('assistant');
    });
  });
});
