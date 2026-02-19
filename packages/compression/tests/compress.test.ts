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
    it('compresses each role separately (no cross-role merging)', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
        msg({ id: '3', index: 2, role: 'user', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      // Each role compressed separately: 3 messages → 3 compressed messages
      expect(result.messages.length).toBe(3);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.messages[1].content).toMatch(/^\[summary:/);
      expect(result.messages[2].content).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(3);
    });

    it('compresses large prose to bracketed summary', () => {
      const largeProse = 'This is the first sentence about architecture. ' +
        'It continues with many more sentences about various aspects of the system design. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'You are helpful.' }),
        msg({ id: '2', index: 1, role: 'user', content: largeProse }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      // System preserved, user compressed
      expect(result.messages.length).toBe(2);
      const compressed = result.messages[1];
      expect(compressed.content).toMatch(/^\[summary: /);
      expect(compressed.content).toContain('This is the first sentence about architecture');
    });

    it('writes _uc_original metadata on same-role merged messages', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: 'a', index: 0, role: 'user', content: prose }),
        msg({ id: 'b', index: 1, role: 'user', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      // Same role → merged into 1
      expect(result.messages.length).toBe(1);
      const meta = result.messages[0].metadata?._uc_original as { ids: string[]; version: number };
      expect(meta).toBeDefined();
      expect(meta.ids).toEqual(['a', 'b']);
      expect(meta.version).toBe(0);
    });

    it('writes _uc_original with ids array on large prose compression', () => {
      const largeProse = 'First sentence here. ' + 'More text follows here. '.repeat(50);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: largeProse }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const compressed = result.messages[1];
      const meta = compressed.metadata?._uc_original as { ids: string[]; version: number };
      expect(meta).toBeDefined();
      expect(meta.ids).toEqual(['2']);
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
      const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages.length).toBe(3);
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.messages[1].role).toBe('tool');
      expect(result.messages[1].content).toBe('Tool result');
      expect(result.messages[2].content).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(2);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('splits at role boundaries and at preserved boundaries', () => {
      const longProse = 'This talks about general topics without any special formatting or code. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: longProse }),
        msg({ id: '2', index: 1, role: 'assistant', content: longProse }),
        msg({ id: '3', index: 2, role: 'tool', content: 'Result' }),
        msg({ id: '4', index: 3, role: 'user', content: longProse }),
        msg({ id: '5', index: 4, role: 'assistant', content: longProse }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      // [user compressed] [assistant compressed] [tool preserved] [user compressed] [assistant compressed]
      expect(result.messages.length).toBe(5);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].content).toMatch(/^\[summary:/);
      expect(result.messages[2].role).toBe('tool');
      expect(result.messages[2].content).toBe('Result');
      expect(result.messages[3].role).toBe('user');
      expect(result.messages[3].content).toMatch(/^\[summary:/);
      expect(result.messages[4].role).toBe('assistant');
      expect(result.messages[4].content).toMatch(/^\[summary:/);
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages.length).toBe(3);
      const compressed = result.messages[1];
      expect(compressed.content).toMatch(/\[summary:.*\(1 message merged\)/);
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      const meta = result.messages[1].metadata?._uc_original as Record<string, unknown>;
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
      const result = compressMessages(messages, { preserve: [], recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      const ids = result.messages.map(m => m.id);
      expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('preserves original id and role on compressed messages', () => {
      const longProse = 'General discussion about various topics without special patterns. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'assistant', content: longProse }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const compressed = result.messages[1];
      expect(compressed.id).toBe('2');
      expect(compressed.role).toBe('assistant');
    });
  });

  describe('role-boundary grouping', () => {
    it('does not merge user and assistant messages together', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages.length).toBe(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
    });

    it('merges consecutive same-role messages', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'user', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toContain('2 messages merged');
      const meta = result.messages[0].metadata?._uc_original as { ids: string[] };
      expect(meta.ids).toEqual(['1', '2']);
    });

    it('each compressed message retains its original role and id', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: 'u1', index: 0, role: 'user', content: prose }),
        msg({ id: 'a1', index: 1, role: 'assistant', content: prose }),
        msg({ id: 'u2', index: 2, role: 'user', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages.length).toBe(3);
      expect(result.messages[0].id).toBe('u1');
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].id).toBe('a1');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].id).toBe('u2');
      expect(result.messages[2].role).toBe('user');
    });
  });

  describe('recency protection', () => {
    it('preserves last 4 messages by default', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: prose }));
      }
      const result = compressMessages(messages);
      // Last 4 preserved by recency, first 4 compressible
      const preserved = result.messages.filter(m => !m.content?.startsWith('[summary:'));
      expect(preserved.length).toBeGreaterThanOrEqual(4);
      // Check that the last 4 original messages are in the result untouched
      for (let i = 4; i < 8; i++) {
        const found = result.messages.find(m => m.id === `${i}`);
        expect(found).toBeDefined();
        expect(found!.content).not.toMatch(/^\[summary:/);
      }
    });

    it('respects custom recencyWindow', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: prose }));
      }
      const result = compressMessages(messages, { recencyWindow: 2 });
      // Last 2 preserved by recency
      const last2 = result.messages.slice(-2);
      expect(last2[0].content).not.toMatch(/^\[summary:/);
      expect(last2[1].content).not.toMatch(/^\[summary:/);
    });

    it('recencyWindow: 0 disables protection', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.compression.messages_compressed).toBe(2);
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.messages[1].content).toMatch(/^\[summary:/);
    });

    it('window larger than message count preserves all', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 10 });
      expect(result.compression.messages_compressed).toBe(0);
      expect(result.compression.messages_preserved).toBe(2);
    });
  });

  describe('summarize quality', () => {
    it('skips leading filler like "Great."', () => {
      const text = 'Great. Now I need help with the Express project structure. The team has four developers.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(5) }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).not.toMatch(/\[summary: Great\./);
      expect(content).toContain('Express');
    });

    it('caps at 200 chars when no punctuation', () => {
      const noPunct = 'word '.repeat(100); // 500 chars, no sentence-ending punctuation
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: noPunct }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      // The summary text (between [summary: and the suffix) should not exceed 200 chars
      const match = result.messages[0].content!.match(/\[summary: (.*?)(?:\s*\(|\s*\||\])/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(200);
    });

    it('includes first substantive + last sentence', () => {
      const text = 'Sure. The database needs three replicas for redundancy. Each replica handles read traffic. The final config uses PostgreSQL.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(4) }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('database needs three replicas');
      expect(content).toContain('PostgreSQL');
    });

    it('hard caps overall summary at 200 chars', () => {
      // Use non-hex chars to avoid triggering hash_or_sha T0 detection
      const longSentence = 'Wor '.repeat(50) + 'is the architecture we chose for this particular deployment. ';
      const text = longSentence + 'The last sentence describes the final outcome of this deployment strategy.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(5) }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const match = result.messages[0].content!.match(/\[summary: (.*?)(?:\s*\(|\s*\||\])/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(200);
    });
  });

  describe('entity extraction', () => {
    it('extracts camelCase identifiers', () => {
      const text = 'We should refactor the getUserProfile function and update fetchData accordingly. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('entities:');
      expect(content).toContain('getUserProfile');
      expect(content).toContain('fetchData');
    });

    it('extracts snake_case identifiers', () => {
      const text = 'The user_profile table and auth_token column need migration. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('entities:');
      expect(content).toContain('user_profile');
      expect(content).toContain('auth_token');
    });

    it('extracts proper nouns (filtered against common starters)', () => {
      const text = 'Express and TypeScript are used in the project. The team uses Redis for caching. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('entities:');
      expect(content).toContain('Express');
      expect(content).toContain('Redis');
      // "The" should be filtered out as a common starter
      expect(content).not.toMatch(/entities:.*\bThe\b/);
    });

    it('extracts PascalCase identifiers (TypeScript, WebSocket)', () => {
      const text = 'We need TypeScript support and WebSocket connections for the JavaScript project. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('entities:');
      expect(content).toContain('TypeScript');
      expect(content).toContain('WebSocket');
      expect(content).toContain('JavaScript');
    });

    it('extracts numbers with context', () => {
      const text = 'The system handles 5000 requests per batch and allows 3 retries per operation. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('entities:');
      expect(content).toMatch(/3 retries/);
    });

    it('extracts vowelless abbreviations (pnpm, npm, ssh)', () => {
      const text = 'We use pnpm workspaces and connect via ssh to deploy the grpc service. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('entities:');
      expect(content).toContain('pnpm');
      expect(content).toContain('ssh');
      expect(content).toContain('grpc');
    });

    it('caps entities at 10', () => {
      const text = 'Alice Bob Charlie Dave Eve Frank Grace Heidi Ivan Judy Karl Liam Mallory spoke about getUserData fetchItems parseConfig with user_id auth_token db_name cache_key log_level queue_size worker_count and 5 retries and 10 seconds. '.repeat(3);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      const entitiesMatch = content.match(/entities: ([^\]]+)/);
      expect(entitiesMatch).toBeTruthy();
      const entityList = entitiesMatch![1].split(', ');
      expect(entityList.length).toBeLessThanOrEqual(10);
    });
  });

  describe('code-aware splitting', () => {
    it('code + long prose → code-split compressed', () => {
      const longProse = 'This is a detailed explanation of how the authentication system works and integrates with the session manager. '.repeat(3);
      const content = `${longProse}\n\n\`\`\`typescript\nconst token = await auth.getToken();\nconst session = createSession(token);\n\`\`\`\n\nAfter running this code the session is established and ready to use.`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.compression.messages_compressed).toBe(1);
      const output = result.messages[0].content!;
      // Code preserved, prose summarized
      expect(output).toContain('```typescript');
      expect(output).toContain('auth.getToken()');
      expect(output).toMatch(/^\[summary:/);
    });

    it('code fences preserved verbatim', () => {
      const fence = '```js\nfunction add(a, b) {\n  return a + b;\n}\n```';
      const prose = 'Here is an explanation of the addition function that takes two parameters and returns their sum. '.repeat(3);
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toContain(fence);
    });

    it('prose around code is summarized with entities', () => {
      const prose = 'The getUserProfile function in the Express middleware needs refactoring to support WebSocket connections. '.repeat(3);
      const fence = '```ts\nconst profile = getUserProfile(req);\n```';
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toMatch(/\[summary:.*\|.*entities:/);
      expect(output).toContain('getUserProfile');
    });

    it('code + short prose (< 200 chars) → fully preserved', () => {
      const content = 'Here is the code:\n\n```ts\nconst x = 1;\n```\n\nDone.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.compression.messages_preserved).toBe(1);
      expect(result.messages[0].content).toBe(content);
    });

    it('code-split skipped when output would be larger', () => {
      // ~210 chars of prose — just above threshold but summary + entities + bracket overhead exceeds original
      const prose = 'The authentication middleware validates each incoming request token. '.repeat(3);
      const fence = '```ts\nconst ok = validate(token);\n```';
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      // Output must never exceed the original length
      expect(output.length).toBeLessThanOrEqual(content.length);
    });

    it('code-split with substantial prose achieves positive savings', () => {
      const prose = 'The authentication system validates incoming request tokens against the session store and checks expiration timestamps before allowing access to protected resources. '.repeat(4);
      const fence = '```ts\nconst session = await store.get(token);\nif (!session || session.expired) throw new AuthError();\n```';
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output.length).toBeLessThan(content.length);
      expect(output).toContain('```ts');
      expect(output).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });

    it('_uc_original metadata present on code-split messages', () => {
      const prose = 'This is a detailed explanation of how the system handles authentication tokens and session management. '.repeat(3);
      const content = `${prose}\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
      const messages: Message[] = [
        msg({ id: 'cs1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const meta = result.messages[0].metadata?._uc_original as { ids: string[]; version: number };
      expect(meta).toBeDefined();
      expect(meta.ids).toEqual(['cs1']);
      expect(meta.version).toBe(0);
    });

    it('multiple fences in one message — all preserved', () => {
      const fence1 = '```python\ndef hello():\n    print("hi")\n```';
      const fence2 = '```bash\nnpm install express\n```';
      const prose = 'First we define the Python function for our greeting handler, then install the Express dependency for the server. '.repeat(2);
      const content = `${prose}\n\n${fence1}\n\nThen run the install:\n\n${fence2}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toContain(fence1);
      expect(output).toContain(fence2);
      expect(output).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });
  });

  describe('_uc_original normalization', () => {
    it('all compression paths use ids array shape', () => {
      const largeProse = 'First sentence here. ' + 'More text follows here. '.repeat(50);
      const mediumProse = 'This talks about general topics without any special formatting or patterns. '.repeat(3);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: largeProse }),  // >800 char path
        msg({ id: '2', index: 1, role: 'assistant', content: mediumProse }),  // <800 single merge path
      ];
      const result = compressMessages(messages, { preserve: [], recencyWindow: 0 });

      for (const m of result.messages) {
        const meta = m.metadata?._uc_original as Record<string, unknown>;
        expect(meta).toBeDefined();
        expect(meta).toHaveProperty('ids');
        expect(meta).not.toHaveProperty('id');
        expect(Array.isArray(meta.ids)).toBe(true);
      }
    });
  });
});
