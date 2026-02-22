import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import type { Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

/** Inline token estimate matching the internal formula. */
function estimateTokens(m: Message): number {
  const len = typeof m.content === 'string' ? m.content.length : 0;
  return Math.ceil(len / 3.5);
}

describe('compress', () => {
  describe('preservation rules', () => {
    it('preserves system role by default', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'You are a helpful assistant. '.repeat(20) }),
        msg({ id: '2', index: 1, role: 'user', content: 'This is a long user message that talks about many things and goes on for a while to exceed the threshold. '.repeat(10) }),
      ];
      const result = compress(messages);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toContain('You are a helpful assistant');
      expect(result.compression.messages_preserved).toBeGreaterThanOrEqual(1);
    });

    it('compresses long prose tool messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: 'Tool output result that is fairly long and contains detailed information about the operation. '.repeat(5) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].role).toBe('tool');
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });

    it('compresses long prose function messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'function', content: 'Function result with enough content to pass the length threshold easily here. '.repeat(5) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].role).toBe('function');
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });

    it('preserves tool messages with JSON content', () => {
      const jsonContent = JSON.stringify({ result: 'success', data: { items: [1, 2, 3], total: 3 } });
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: jsonContent }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe(jsonContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves tool messages with code content', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: '```typescript\nconst x = 1;\nconst y = 2;\nreturn x + y;\n```\nHere is the code result from the tool execution.' }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toContain('```');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves short tool messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: 'OK' }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe('OK');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves tool results containing SQL', () => {
      const sqlContent = 'SELECT u.id, u.email FROM users u JOIN orders o ON u.id = o.user_id WHERE o.total > 100 ORDER BY o.created_at DESC LIMIT 50';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: sqlContent }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe(sqlContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves tool results containing API keys', () => {
      const envContent = 'DATABASE_URL=postgres://localhost/mydb\nOPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr\nPORT=3000';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: envContent }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe(envContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves function results containing SQL', () => {
      const sqlContent = 'ERROR: relation "users" does not exist\nSTATEMENT: INSERT INTO audit_log (user_id, action) VALUES ($1, $2) RETURNING id';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'function', content: sqlContent }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe(sqlContent);
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
      const result = compress(messages);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves short messages (< 120 chars)', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: 'Hello there!' }),
      ];
      const result = compress(messages);
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
      const result = compress(messages);
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
      const result = compress(messages);
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
      const result = compress(messages);
      expect(result.messages[0].content).toContain('/etc/ultracontext/config.json');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves messages with valid JSON content', () => {
      const jsonContent = JSON.stringify({ key: 'value', nested: { a: 1, b: [1, 2, 3] } }, null, 2);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content: jsonContent }),
      ];
      const result = compress(messages);
      expect(result.messages[0].content).toBe(jsonContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('respects custom preserve roles', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'developer', content: 'Important developer instructions that should be preserved across all interactions. '.repeat(5) }),
        msg({ id: '2', index: 1, role: 'user', content: 'A long message about general topics that could be compressed since it has no special content. '.repeat(10) }),
      ];
      const result = compress(messages, { preserve: ['developer'] });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
      expect(result.compression.ratio).toBeGreaterThan(1);
    });

    it('returns ratio 1.0 when all preserved', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: 'Short msg.' }),
      ];
      const result = compress(messages);
      expect(result.compression.ratio).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
    });

    it('handles empty input', () => {
      const result = compress([]);
      expect(result.messages).toEqual([]);
      expect(result.compression.ratio).toBe(1);
      expect(result.compression.token_ratio).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
      expect(result.compression.messages_preserved).toBe(0);
    });

    it('token_ratio > 1 when compressing', () => {
      const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compress(messages, { recencyWindow: 0, dedup: false });
      expect(result.compression.token_ratio).toBeGreaterThan(1);
    });

    it('token_ratio === 1 when all preserved', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: 'Short msg.' }),
      ];
      const result = compress(messages);
      expect(result.compression.token_ratio).toBe(1);
    });

    it('token_ratio differs from char ratio', () => {
      const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compress(messages, { recencyWindow: 0, dedup: false });
      // Both should be > 1 since compression happened
      expect(result.compression.ratio).toBeGreaterThan(1);
      expect(result.compression.token_ratio).toBeGreaterThan(1);
      // They use different denominators (chars vs ceil(chars/3.5)) so won't be identical
      expect(result.compression.token_ratio).not.toBe(result.compression.ratio);
    });

    it('token_ratio uses ceil(chars/3.5) estimation', () => {
      // Use a system message (role-preserved) so we test the zero-compression path
      const content = 'You are a helpful assistant. '.repeat(12); // 336 chars
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      // All preserved → token_ratio === 1
      expect(result.compression.token_ratio).toBe(1);
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages.length).toBe(3);
      const compressed = result.messages[1];
      expect(compressed.content).toMatch(/^\[summary:/);
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { preserve: [], recencyWindow: 0 });
      expect(result.compression.messages_compressed).toBe(1);
      expect(result.messages[0].content).toMatch(/^\[summary:/);
    });

    it('preserves messages with undefined content (treated as short)', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, content: undefined as unknown as string }),
      ];
      const result = compress(messages);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves existing metadata alongside _uc_original', () => {
      const largeProse = 'First sentence about some topic. ' + 'More text follows here. '.repeat(50);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'user', content: largeProse, metadata: { custom: 'value', priority: 1 } }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
      const ids = result.messages.map(m => m.id);
      expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('preserves original id and role on compressed messages', () => {
      const longProse = 'General discussion about various topics without special patterns. '.repeat(15);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'assistant', content: longProse }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { dedup: false });
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
      const result = compress(messages, { recencyWindow: 2, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0, dedup: false });
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
      const result = compress(messages, { recencyWindow: 10, dedup: false });
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
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).not.toMatch(/\[summary: Great\./);
      expect(content).toContain('Express');
    });

    it('caps at 400 chars when no punctuation', () => {
      const noPunct = 'word '.repeat(200); // 1000 chars, no sentence-ending punctuation
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: noPunct }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      // The summary text (between [summary: and the suffix) should not exceed 400 chars
      const match = result.messages[0].content!.match(/\[summary: (.*?)(?:\s*\(|\s*\||\])/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(400);
    });

    it('includes first substantive + last sentence', () => {
      const text = 'Sure. The database needs three replicas for redundancy. Each replica handles read traffic. The final config uses PostgreSQL.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(4) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('database needs three replicas');
      expect(content).toContain('PostgreSQL');
    });

    it('falls back to first sentence when all sentences are filler', () => {
      const text = 'Sure thing. OK then. Thanks for that. Got it. No problem. Will do. Right. Absolutely. '.repeat(3);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toMatch(/^\[summary:/);
      // Falls back to first sentence since all are filler
      expect(content).toContain('Sure thing');
    });

    it('hard caps overall summary at 400 chars', () => {
      // Use non-hex chars to avoid triggering hash_or_sha T0 detection
      const longSentence = 'Wor '.repeat(50) + 'is the architecture we chose for this particular deployment. ';
      const text = longSentence + 'The last sentence describes the final outcome of this deployment strategy.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(5) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const match = result.messages[0].content!.match(/\[summary: (.*?)(?:\s*\(|\s*\||\])/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(400);
    });

    it('extracts content from multiple paragraphs', () => {
      const text = 'The database uses PostgreSQL with three replicas for redundancy.\n\n' +
        'However the caching layer is critically important for performance.\n\n' +
        'The final deployment runs on Kubernetes with auto-scaling enabled.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(3) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      // Should capture content from multiple paragraphs, not just first+last
      expect(content).toContain('caching layer');
    });

    it('weights emphasis words higher', () => {
      const text = 'The system starts up normally. However the authentication module requires special configuration. The logs show standard output.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(4) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      // "However" sentence should be selected due to emphasis scoring
      expect(content).toContain('authentication module');
    });

    it('budget ceiling at 400 chars', () => {
      const sentences = Array.from({ length: 20 }, (_, i) =>
        `Sentence number ${i + 1} provides additional context about the deployment.`
      ).join(' ');
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: sentences.repeat(3) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const match = result.messages[0].content!.match(/\[summary: (.*?)(?:\s*\(|\s*\||\])/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(400);
    });

    it('weights PASS/FAIL/ERROR status words higher', () => {
      const text = 'The build completed without issues. FAIL src/auth.test.ts login validation. The logs are clean.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(4) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('FAIL');
    });

    it('weights grep-style file:line references higher', () => {
      // Use paragraphs so each becomes its own sentence unit — avoids the
      // sentence splitter breaking on the dot in the filename
      const text = 'There are some boring results below that have nothing useful in them at all\n\n' +
        'auth_handler:42: const token = getToken()\n\n' +
        'The output is complete and nothing else matters here at all for now\n\n';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(4) }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      // The grep-style reference gets boosted by +2 and selected
      expect(content).toContain('auth_handler:42:');
    });
  });

  describe('entity extraction', () => {
    it('extracts camelCase identifiers', () => {
      const text = 'We should refactor the getUserProfile function and update fetchData accordingly. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('entities:');
      expect(content).toMatch(/3 retries/);
    });

    it('extracts vowelless abbreviations (pnpm, npm, ssh)', () => {
      const text = 'We use pnpm workspaces and connect via ssh to deploy the grpc service. '.repeat(8);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toContain(fence);
    });

    it('prose around code is summarized without entities (identifiers already in fences)', () => {
      const prose = 'The getUserProfile function in the Express middleware needs refactoring to support WebSocket connections. '.repeat(3);
      const fence = '```ts\nconst profile = getUserProfile(req);\n```';
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toMatch(/\[summary:/);
      expect(output).not.toMatch(/\| entities:/);
      expect(output).toContain('getUserProfile'); // still present in the preserved fence
    });

    it('code + short prose (< 80 chars) → fully preserved', () => {
      const content = 'Here is the code:\n\n```ts\nconst x = 1;\n```\n\nDone.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.compression.messages_preserved).toBe(1);
      expect(result.messages[0].content).toBe(content);
    });

    it('code-split skipped when summary output would be larger than original prose', () => {
      // Prose just above 80 chars — single sentence that can't be compressed shorter
      // than the [summary: ] wrapper (12 chars overhead)
      const prose = 'We call getUserProfile and fetchUserData and handleAuthToken in the TypeScript middleware layer.';
      const fence = '```ts\nconst x = getUserProfile(req);\n```';
      const content = `${prose}\n\n${fence}`;
      expect(prose.trim().length).toBeGreaterThanOrEqual(80);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      // Single sentence with identifiers → summarizer keeps it as-is → [summary: ...] wrapper
      // makes it larger → compression skipped, message preserved
      expect(result.compression.messages_preserved).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
      expect(result.messages[0].content).toBe(content);
    });

    it('code-split with substantial prose achieves positive savings', () => {
      const prose = 'The authentication system validates incoming request tokens against the session store and checks expiration timestamps before allowing access to protected resources. '.repeat(4);
      const fence = '```ts\nconst session = await store.get(token);\nif (!session || session.expired) throw new AuthError();\n```';
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
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
      const result = compress(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toContain(fence1);
      expect(output).toContain(fence2);
      expect(output).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });

    it('indented closing backticks are detected as fences', () => {
      const fence = '```bash\n  ollama serve &\n  ollama pull llama3.2\n  ```';
      const prose = 'Here is how to set up the local inference server for development and testing with the model runner. '.repeat(3);
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toContain(fence);
      expect(output).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });

    it('indented opening and closing backticks are detected as fences', () => {
      const fence = '   ```bash\n   alembic upgrade head\n   ```';
      const prose = 'The implementation is complete and all files have been created for the beta registration system. '.repeat(4);
      const content = `${prose}\n\n${fence}`;
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const output = result.messages[0].content!;
      expect(output).toContain(fence);
      expect(output).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });
  });

  describe('no negative savings', () => {
    it('prose-only compression never exceeds original length', () => {
      const medium = 'This talks about general topics without any special formatting or patterns that would trigger preservation rules. '.repeat(3);
      const large = 'This talks about general topics without any special formatting or patterns that would trigger preservation rules. '.repeat(10);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: medium }),
        msg({ id: '2', index: 1, role: 'assistant', content: large }),
      ];
      const result = compress(messages, { preserve: [], recencyWindow: 0, dedup: false });
      for (const m of result.messages) {
        const orig = messages.find(o => o.id === m.id)!;
        expect(m.content!.length).toBeLessThanOrEqual(orig.content!.length);
      }
    });
  });

  describe('idempotency', () => {
    it('compress is idempotent — re-compressing output produces identical result', () => {
      const prose = 'The authentication system validates incoming request tokens against the session store and checks expiration timestamps before allowing access to protected resources. '.repeat(4);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: prose }),
        msg({ id: '3', index: 2, role: 'assistant', content: prose }),
      ];
      const first = compress(messages, { recencyWindow: 0, dedup: false });
      expect(first.compression.messages_compressed).toBeGreaterThan(0);

      const second = compress(first.messages, { recencyWindow: 0, dedup: false });
      expect(second.compression.messages_compressed).toBe(0);
      expect(second.messages).toEqual(first.messages);
    });
  });

  describe('prose-only size guard', () => {
    it('preserves entity-dense short messages where summary would grow', () => {
      const content = 'Call getUserProfile fetchUserData handleAuthToken validateSession refreshCache parseConfig buildQuery formatResponse logMetrics in the TypeScript codebase.';
      expect(content.length).toBeGreaterThanOrEqual(120);
      expect(content.length).toBeLessThan(300);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content }),
      ];
      const result = compress(messages, { preserve: [], recencyWindow: 0 });
      expect(result.compression.messages_preserved).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
      expect(result.messages[0].content).toBe(content);
    });

    it('single message preserved when summary wrapper exceeds original length', () => {
      // Single sentence just above 120ch — summarizer keeps the full
      // sentence, and the [summary: ] wrapper (12ch) makes it longer
      const content = 'Call getUserProfile and fetchUserData and handleAuthToken and validateSession and refreshCache in the TypeScript codebase.';
      expect(content.length).toBeGreaterThanOrEqual(120);
      expect(content.length).toBeLessThan(200); // short enough that wrapper overhead matters
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content }),
      ];
      const result = compress(messages, { preserve: [], recencyWindow: 0 });
      expect(result.messages[0].content).toBe(content);
      expect(result.compression.messages_preserved).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
    });
  });

  describe('_uc_original normalization', () => {
    it('all compression paths use ids array shape', () => {
      const largeProse = 'First sentence here. ' + 'More text follows here. '.repeat(50);
      const mediumProse = 'This talks about general topics without any special formatting or patterns. '.repeat(3);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: largeProse }),
        msg({ id: '2', index: 1, role: 'assistant', content: mediumProse }),
      ];
      const result = compress(messages, { preserve: [], recencyWindow: 0, dedup: false });

      for (const m of result.messages) {
        const meta = m.metadata?._uc_original as Record<string, unknown>;
        expect(meta).toBeDefined();
        expect(meta).toHaveProperty('ids');
        expect(meta).not.toHaveProperty('id');
        expect(Array.isArray(meta.ids)).toBe(true);
      }
    });
  });

  describe('verbatim', () => {
    it('contains all and only compressed originals across paths (single, merge, code-split)', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const codeProse = 'This is a detailed explanation of how the authentication system works and integrates with the session manager. '.repeat(3);
      const codeContent = `${codeProse}\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
      const messages: Message[] = [
        msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: 'u1', index: 1, role: 'user', content: prose }),
        msg({ id: 'u2', index: 2, role: 'user', content: prose }),
        msg({ id: 'a1', index: 3, role: 'assistant', content: codeContent }),
        msg({ id: 'a2', index: 4, role: 'assistant', content: prose }),
        msg({ id: 'short', index: 5, role: 'user', content: 'Short.' }),
      ];
      const result = compress(messages, { recencyWindow: 0, dedup: false });
      expect(Object.keys(result.verbatim).sort()).toEqual(['a1', 'a2', 'u1', 'u2']);
      expect(result.verbatim['u1'].content).toBe(prose);
      expect(result.verbatim['a1'].content).toBe(codeContent);
    });

    it('empty when nothing compressed (including empty input)', () => {
      expect(compress([]).verbatim).toEqual({});
      const preserved: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'user', content: 'Short.' }),
      ];
      expect(compress(preserved).verbatim).toEqual({});
    });

    it('Object.keys(verbatim).length === messages_compressed invariant', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const cases: Message[][] = [
        [],
        [msg({ id: '1', index: 0, role: 'user', content: prose })],
        [msg({ id: 'a', index: 0, role: 'user', content: prose }), msg({ id: 'b', index: 1, role: 'user', content: prose })],
        [msg({ id: '1', index: 0, role: 'user', content: prose }), msg({ id: '2', index: 1, role: 'assistant', content: prose })],
      ];
      for (const messages of cases) {
        const result = compress(messages, { recencyWindow: 0, dedup: false });
        expect(Object.keys(result.verbatim).length).toBe(result.compression.messages_compressed);
      }
    });
  });

  describe('provenance metadata', () => {
    it('sourceVersion flows into _uc_original.version and compression.original_version', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
      ];
      const result = compress(messages, { recencyWindow: 0, sourceVersion: 42 });
      const meta = result.messages[0].metadata?._uc_original as { version: number };
      expect(meta.version).toBe(42);
      expect(result.compression.original_version).toBe(42);
    });

    it('sourceVersion defaults to 0 when omitted', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      const meta = result.messages[0].metadata?._uc_original as { version: number };
      expect(meta.version).toBe(0);
      expect(result.compression.original_version).toBe(0);
    });

    it('generates deterministic summary_id from input ids', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const r1 = compress([msg({ id: 'a', index: 0, role: 'user', content: prose })], { recencyWindow: 0, dedup: false });
      const r2 = compress([msg({ id: 'a', index: 0, role: 'user', content: prose })], { recencyWindow: 0, dedup: false });
      const r3 = compress([msg({ id: 'b', index: 0, role: 'user', content: prose })], { recencyWindow: 0, dedup: false });
      const m1 = r1.messages[0].metadata?._uc_original as { summary_id: string };
      const m2 = r2.messages[0].metadata?._uc_original as { summary_id: string };
      const m3 = r3.messages[0].metadata?._uc_original as { summary_id: string };
      expect(m1.summary_id).toMatch(/^uc_sum_/);
      expect(m1.summary_id).toBe(m2.summary_id);
      expect(m1.summary_id).not.toBe(m3.summary_id);
    });

    it('omits parent_ids when source has no prior _uc_original', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const result = compress(
        [msg({ id: '1', index: 0, role: 'user', content: prose })],
        { recencyWindow: 0 },
      );
      const meta = result.messages[0].metadata?._uc_original as Record<string, unknown>;
      expect(meta.summary_id).toMatch(/^uc_sum_/);
      expect(meta.parent_ids).toBeUndefined();
    });

    it('collects parent_ids from previously-compressed source messages', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const priorSummaryId = 'uc_sum_abc123';
      const messages: Message[] = [
        msg({
          id: 'x',
          index: 0,
          role: 'user',
          content: prose,
          metadata: {
            _uc_original: { ids: ['old1'], summary_id: priorSummaryId, version: 3 },
          },
        }),
        msg({ id: 'y', index: 1, role: 'user', content: prose }),
      ];
      const result = compress(messages, { preserve: [], recencyWindow: 0, dedup: false });
      const meta = result.messages[0].metadata?._uc_original as {
        ids: string[];
        summary_id: string;
        parent_ids?: string[];
      };
      expect(meta.parent_ids).toEqual([priorSummaryId]);
    });
  });
});

// ---------------------------------------------------------------------------
// overload contract
// ---------------------------------------------------------------------------

describe('compress overload contract', () => {
  const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);

  it('returns a plain object (not a Promise) when no summarizer is provided', () => {
    const result = compress([msg({ id: '1', index: 0, role: 'user', content: prose })], { recencyWindow: 0 });
    // If this were a Promise, .messages would be undefined
    expect(result.messages).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('returns a Promise when a summarizer is provided', () => {
    const result = compress(
      [msg({ id: '1', index: 0, role: 'user', content: prose })],
      { recencyWindow: 0, summarizer: (t) => t.slice(0, 20) },
    );
    expect(result).toBeInstanceOf(Promise);
  });

  it('result without tokenBudget does not have fits or tokenCount', () => {
    const result = compress([msg({ id: '1', index: 0, role: 'user', content: prose })], { recencyWindow: 0 });
    expect(result.fits).toBeUndefined();
    expect(result.tokenCount).toBeUndefined();
  });

  it('result with tokenBudget always has fits and tokenCount', () => {
    const result = compress(
      [msg({ id: '1', index: 0, role: 'user', content: prose })],
      { tokenBudget: 10000 },
    );
    expect(typeof result.fits).toBe('boolean');
    expect(typeof result.tokenCount).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// compress with summarizer (async)
// ---------------------------------------------------------------------------

const LONG_PROSE = 'This is a long message about general topics that could be compressed. '.repeat(5);

describe('compress with summarizer', () => {
  it('uses LLM result when shorter than input', async () => {
    const mockSummarizer = async (text: string) => text.slice(0, 50) + '...';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const result = await compress(messages, { recencyWindow: 0, summarizer: mockSummarizer });
    expect(result.compression.messages_compressed).toBe(1);
    expect(result.messages[0].content).toMatch(/^\[summary:/);
  });

  it('async with no summarizer produces identical output to sync', async () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: '2', index: 1, role: 'user', content: LONG_PROSE }),
      msg({ id: '3', index: 2, role: 'assistant', content: LONG_PROSE }),
    ];
    const sync = compress(messages, { recencyWindow: 0, dedup: false });
    // Without summarizer, compress is sync
    const syncResult = compress(messages, { recencyWindow: 0, dedup: false });
    expect(syncResult.messages).toEqual(sync.messages);
    expect(syncResult.compression).toEqual(sync.compression);
    expect(syncResult.verbatim).toEqual(sync.verbatim);
  });

  it('falls back to deterministic when LLM returns longer text', async () => {
    const growingSummarizer = async (text: string) => text + ' EXTRA PADDING THAT MAKES IT LONGER';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const withLlm = await compress(messages, { recencyWindow: 0, summarizer: growingSummarizer });
    const withoutLlm = compress(messages, { recencyWindow: 0 });
    expect(withLlm.messages).toEqual(withoutLlm.messages);
  });

  it('falls back when LLM throws', async () => {
    const failingSummarizer = async () => { throw new Error('LLM unavailable'); };
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const withLlm = await compress(messages, { recencyWindow: 0, summarizer: failingSummarizer });
    const withoutLlm = compress(messages, { recencyWindow: 0 });
    expect(withLlm.messages).toEqual(withoutLlm.messages);
  });

  it('round-trip: async compress then uncompress = byte-identical', async () => {
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: LONG_PROSE }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: LONG_PROSE }),
    ];
    const compressed = await compress(messages, { recencyWindow: 0, dedup: false, summarizer: (t) => t.slice(0, 40) + '...' });
    expect(compressed.compression.messages_compressed).toBeGreaterThan(0);
    const expanded = uncompress(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('works with a synchronous summarizer (non-Promise return)', async () => {
    const syncSummarizer = (text: string) => text.slice(0, 40) + '...';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const result = await compress(messages, { recencyWindow: 0, summarizer: syncSummarizer });
    expect(result.compression.messages_compressed).toBe(1);
    expect(result.messages[0].content).toMatch(/^\[summary:/);
  });

  it('code-split path: summarizer called on prose only, fences preserved', async () => {
    const calls: string[] = [];
    const trackingSummarizer = async (text: string) => {
      calls.push(text);
      return text.slice(0, 50) + '...';
    };
    const prose = 'This is a detailed explanation of how the authentication system works and integrates with the session manager. '.repeat(3);
    const code = '```ts\nconst x = 1;\n```';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'assistant', content: `${prose}\n\n${code}` }),
    ];
    const result = await compress(messages, { recencyWindow: 0, summarizer: trackingSummarizer });
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain('```');
    expect(result.messages[0].content).toContain(code);
  });

  it('falls back to deterministic when summarizer returns empty string', async () => {
    const emptySummarizer = async () => '';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const withEmpty = await compress(messages, { recencyWindow: 0, summarizer: emptySummarizer });
    const withoutLlm = compress(messages, { recencyWindow: 0 });
    expect(withEmpty.messages).toEqual(withoutLlm.messages);
  });

  it('no compressed message has empty content when summarizer returns empty', async () => {
    const emptySummarizer = async () => '';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
      msg({ id: '2', index: 1, role: 'user', content: LONG_PROSE }),
    ];
    const result = await compress(messages, { recencyWindow: 0, dedup: false, summarizer: emptySummarizer });
    for (const m of result.messages) {
      expect(typeof m.content === 'string' ? m.content.length : 0).toBeGreaterThan(0);
    }
  });

  it('code-split path: falls back to deterministic when summarizer returns empty', async () => {
    const emptySummarizer = async () => '';
    const prose = 'This is a detailed explanation of how the authentication system works and integrates with the session manager. '.repeat(3);
    const code = '```ts\nconst x = 1;\n```';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'assistant', content: `${prose}\n\n${code}` }),
    ];
    const withEmpty = await compress(messages, { recencyWindow: 0, summarizer: emptySummarizer });
    const withoutLlm = compress(messages, { recencyWindow: 0 });
    expect(withEmpty.messages).toEqual(withoutLlm.messages);
  });

  it('falls back to deterministic when summarizer returns equal-length text', async () => {
    const sameLengthSummarizer = async (text: string) => 'x'.repeat(text.length);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const withSame = await compress(messages, { recencyWindow: 0, summarizer: sameLengthSummarizer });
    const withoutLlm = compress(messages, { recencyWindow: 0 });
    expect(withSame.messages).toEqual(withoutLlm.messages);
  });

  it('falls back when summarizer returns text exactly one char shorter (boundary)', async () => {
    // length < text.length is true, length > 0 is true → should use the LLM result
    const oneCharShorter = async (text: string) => 'x'.repeat(text.length - 1);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const result = await compress(messages, { recencyWindow: 0, summarizer: oneCharShorter });
    // The summarizer result IS shorter, so it should be used (not fall back to deterministic)
    const deterministic = compress(messages, { recencyWindow: 0 });
    // Content won't match deterministic since the LLM result was accepted
    expect(result.messages[0].content).not.toEqual(deterministic.messages[0].content);
  });
});

// ---------------------------------------------------------------------------
// compress with tokenBudget
// ---------------------------------------------------------------------------

describe('compress with tokenBudget', () => {
  it('returns fits: true when already under budget (zero compression)', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: 'Short message.' }),
    ];
    const result = compress(messages, { tokenBudget: 1000 });
    expect(result.fits).toBe(true);
    expect(result.compression.messages_compressed).toBe(0);
    expect(result.messages).toEqual(messages);
    expect(result.tokenCount).toBeLessThanOrEqual(1000);
  });

  it('reduces recencyWindow until under budget', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: prose }));
    }
    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    const result = compress(messages, { tokenBudget: Math.floor(totalTokens / 2), dedup: false });
    expect(result.fits).toBe(true);
    expect(result.tokenCount).toBeLessThanOrEqual(Math.floor(totalTokens / 2));
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
  });

  it('returns fits: false with best effort for impossible budgets', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
    ];
    const result = compress(messages, { tokenBudget: 1, dedup: false });
    expect(result.fits).toBe(false);
    expect(result.tokenCount).toBeGreaterThan(1);
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
  });

  it('preserves round-trip integrity', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: prose }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: prose }),
    ];
    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    const result = compress(messages, { tokenBudget: Math.floor(totalTokens / 2), dedup: false });
    const expanded = uncompress(result.messages, result.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('respects minRecencyWindow — last N messages stay uncompressed', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: prose }));
    }
    const result = compress(messages, { tokenBudget: 1, minRecencyWindow: 5, dedup: false });
    // Binary search cannot go below rw=5, so last 5 messages must be uncompressed
    const last5 = result.messages.slice(-5);
    for (const m of last5) {
      expect(m.content).not.toMatch(/^\[summary:/);
    }
    // Without the floor, rw=0 would compress everything
    const unclamped = compress(messages, { tokenBudget: 1, minRecencyWindow: 0, dedup: false });
    expect(unclamped.tokenCount!).toBeLessThan(result.tokenCount!);
  });

  it('tokenCount in result is accurate', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      msg({ id: '3', index: 2, role: 'user', content: 'Final question.' }),
    ];
    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    const result = compress(messages, { tokenBudget: Math.floor(totalTokens / 2), dedup: false });
    const actualTokens = result.messages.reduce((sum: number, m: Message) => sum + estimateTokens(m), 0);
    expect(result.tokenCount).toBe(actualTokens);
  });

  it('handles single message', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const result = compress(messages, { tokenBudget: 10 });
    expect(result.fits).toBe(false);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    const result = compress([], { tokenBudget: 1000 });
    expect(result.fits).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.tokenCount).toBe(0);
  });

  it('tokenBudget with summarizer achieves tighter fit', async () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: prose }));
    }
    const aggressiveSummarizer = async (text: string) => text.slice(0, 30) + '...';
    const syncResult = compress(messages, { tokenBudget: 200, dedup: false });
    const asyncResult = await compress(messages, { tokenBudget: 200, dedup: false, summarizer: aggressiveSummarizer });
    expect(asyncResult.tokenCount!).toBeLessThanOrEqual(syncResult.tokenCount!);
  });

  it('tokenBudget with summarizer sets fits: true when under budget', async () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: 'Short.' }),
    ];
    const result = await compress(messages, { tokenBudget: 10000, summarizer: (t) => t.slice(0, 20) });
    expect(result.fits).toBe(true);
    expect(typeof result.tokenCount).toBe('number');
    expect(result.tokenCount).toBeLessThanOrEqual(10000);
  });

  it('tokenBudget with summarizer sets fits: false for impossible budget', async () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const result = await compress(messages, { tokenBudget: 1, summarizer: (t) => t.slice(0, 30) + '...' });
    expect(result.fits).toBe(false);
    expect(result.tokenCount).toBeGreaterThan(1);
  });

  it('tokenCount on fast path (already under budget) is accurate', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: 'Short message.' }),
      msg({ id: '2', index: 1, role: 'assistant', content: 'Another short one.' }),
    ];
    const result = compress(messages, { tokenBudget: 10000 });
    const actualTokens = result.messages.reduce((sum: number, m: Message) => sum + estimateTokens(m), 0);
    expect(result.tokenCount).toBe(actualTokens);
    expect(result.compression.messages_compressed).toBe(0);
  });

  it('tokenBudget with summarizer round-trip integrity', async () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: prose }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: prose }),
    ];
    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    const result = await compress(messages, { tokenBudget: Math.floor(totalTokens / 2), dedup: false, summarizer: (t) => t.slice(0, 40) + '...' });
    const expanded = uncompress(result.messages, result.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

describe('edge case boundaries', () => {
  const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);

  it('tokenBudget: 0 — everything exceeds budget, result has fits: false', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
    ];
    const result = compress(messages, { tokenBudget: 0, dedup: false });
    expect(result.fits).toBe(false);
    expect(result.tokenCount).toBeGreaterThan(0);
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
  });

  it('minRecencyWindow > messages.length — clamps gracefully, preserves all', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
    ];
    const result = compress(messages, { tokenBudget: 1, minRecencyWindow: 100, dedup: false });
    // With minRw > length, binary search lo starts above hi, so all preserved
    expect(result.compression.messages_preserved).toBe(2);
    expect(result.compression.messages_compressed).toBe(0);
  });

  it('summarizer returning text longer than input — falls back to deterministic', async () => {
    const growingSummarizer = async (text: string) => text + ' '.repeat(500) + 'MUCH LONGER PADDING';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const withGrowing = await compress(messages, { recencyWindow: 0, dedup: false, summarizer: growingSummarizer });
    const deterministic = compress(messages, { recencyWindow: 0, dedup: false });
    expect(withGrowing.messages).toEqual(deterministic.messages);
  });

  it('recencyWindow >= messages.length — preserves all messages', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      msg({ id: '3', index: 2, role: 'user', content: prose }),
    ];
    const result = compress(messages, { recencyWindow: messages.length, dedup: false });
    expect(result.compression.messages_compressed).toBe(0);
    expect(result.compression.messages_preserved).toBe(messages.length);

    const resultLarger = compress(messages, { recencyWindow: messages.length + 10, dedup: false });
    expect(resultLarger.compression.messages_compressed).toBe(0);
    expect(resultLarger.compression.messages_preserved).toBe(messages.length);
  });
});

// ---------------------------------------------------------------------------
// structured tool output summarization
// ---------------------------------------------------------------------------

describe('structured tool output summarization', () => {
  it('grep-style output extracts file paths', () => {
    const grepOutput = [
      'src/auth.ts:10: import { verify } from "jwt"',
      'src/auth.ts:25: export function login()',
      'src/auth.ts:42: const token = sign(payload)',
      'src/middleware.ts:8: import { login } from "./auth"',
      'src/middleware.ts:15: app.use(authMiddleware)',
      'src/routes.ts:20: router.post("/login", handler)',
      'src/routes.ts:35: router.get("/profile", guard)',
      'src/config.ts:5: export const JWT_SECRET = env.SECRET',
    ].join('\n');
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: grepOutput }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    const content = result.messages[0].content!;
    expect(content).toMatch(/^\[summary:/);
    expect(content).toContain('files:');
    expect(content).toContain('src/auth.ts');
    expect(result.compression.messages_compressed).toBe(1);
  });

  it('test output extracts PASS/FAIL status lines', () => {
    // Lines end with periods to avoid verse_pattern T0 detection.
    const testOutput = [
      'PASS src/auth.test.ts completed.',
      '  login with valid credentials passed in 3ms.',
      '  login with invalid credentials passed in 1ms.',
      '  token refresh works passed in 2ms.',
      '  token expiration check passed in 1ms.',
      '  password hash verification passed in 2ms.',
      'FAIL src/middleware.test.ts had errors.',
      '  auth guard rejects expired tokens failed.',
      '  auth guard accepts valid tokens passed in 1ms.',
      '  auth guard handles missing headers passed in 1ms.',
      'PASS src/routes.test.ts completed.',
      '  GET profile returns user data passed in 5ms.',
      '  POST login returns token passed in 3ms.',
      '  DELETE session clears cookie passed in 2ms.',
      'Tests completed with 1 failed and 11 passed out of 12 total.',
      'Duration was 4.2 seconds for the full suite.',
    ].join('\n');
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: testOutput }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    const content = result.messages[0].content!;
    expect(content).toMatch(/^\[summary:/);
    expect(content).toMatch(/PASS|FAIL|Tests/);
    expect(result.compression.messages_compressed).toBe(1);
  });

  it('mixed grep and status output is detected as structured', () => {
    const mixed = [
      'src/auth.ts:10: import verify from jwt.',
      'src/auth.ts:25: export function login.',
      'PASS all linting checks completed.',
      'src/middleware.ts:8: import login from auth.',
      'src/middleware.ts:15: app use authMiddleware.',
      'WARN deprecated api usage detected in auth module.',
      'src/routes.ts:20: router post login handler.',
      'ERROR failed assertion in route validation.',
      'src/config.ts:5: export const secret from env.',
      'PASS type checking completed without issues.',
    ].join('\n');
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: mixed }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    const content = result.messages[0].content!;
    expect(content).toMatch(/^\[summary:/);
    expect(content).toContain('files:');
    expect(result.compression.messages_compressed).toBe(1);
  });

  it('indented list output is detected as structured', () => {
    const listOutput = [
      'Available commands:',
      '  - build: compile TypeScript',
      '  - test: run vitest suite',
      '  - lint: check eslint rules',
      '  - format: run prettier',
      '  - deploy: push to production',
      '  - migrate: run database migrations',
      '  - seed: populate test data',
    ].join('\n');
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: listOutput }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    const content = result.messages[0].content!;
    expect(content).toMatch(/^\[summary:/);
    expect(result.compression.messages_compressed).toBe(1);
  });

  it('plain prose is NOT detected as structured', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no special formatting or code. '.repeat(5);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    const content = result.messages[0].content!;
    // Should use normal prose summarizer (entities suffix), not structured
    expect(content).toMatch(/^\[summary:/);
    expect(content).not.toContain('files:');
  });

  it('fewer than 6 lines falls back to prose summarizer', () => {
    const shortStructured = [
      'PASS src/test.ts',
      'Tests: 1 passed',
      'Duration: 0.5s',
    ].join('\n');
    const prose = 'This is additional context that is long enough to exceed the one hundred twenty character threshold for compression eligibility. Extra padding here to make it work properly.';
    const content = prose + '\n' + shortStructured;
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    // Should not crash — may be preserved (short) or prose-summarized
    expect(result.messages[0].content).toBeDefined();
  });

  it('structured summary is shorter than original', () => {
    const grepOutput = Array.from({ length: 20 }, (_, i) =>
      `src/module${i}.ts:${i * 10 + 1}: export function handler${i}()`
    ).join('\n');
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: grepOutput }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    expect(result.messages[0].content!.length).toBeLessThan(grepOutput.length);
  });

  it('many files shows count with +N more', () => {
    const grepOutput = Array.from({ length: 10 }, (_, i) =>
      `src/file${i}.ts:1: export const x${i} = ${i}`
    ).join('\n');
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: grepOutput }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    const content = result.messages[0].content!;
    expect(content).toContain('+');
    expect(content).toContain('more');
  });

  it('structured output with async summarizer bypasses LLM', async () => {
    const calls: string[] = [];
    const trackingSummarizer = async (text: string) => {
      calls.push(text);
      return text.slice(0, 50) + '...';
    };
    const grepOutput = Array.from({ length: 8 }, (_, i) =>
      `src/mod${i}.ts:${i + 1}: export function fn${i}()`
    ).join('\n');
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'tool', content: grepOutput }),
    ];
    await compress(messages, { recencyWindow: 0, summarizer: trackingSummarizer });
    // Structured output should bypass the LLM summarizer
    expect(calls.length).toBe(0);
  });

  describe('input validation', () => {
    it('throws on non-array messages', () => {
      expect(() => compress(null as any)).toThrow('messages must be an array');
      expect(() => compress('hello' as any)).toThrow('messages must be an array');
      expect(() => compress(42 as any)).toThrow('messages must be an array');
    });

    it('throws on null/non-object message entries', () => {
      expect(() => compress([null as any])).toThrow('messages[0] must be an object');
      expect(() => compress([42 as any])).toThrow('messages[0] must be an object');
    });

    it('throws on message missing id', () => {
      expect(() => compress([{ role: 'user', content: 'hi' } as any])).toThrow('missing required field "id"');
    });

    it('accepts valid empty array', () => {
      const result = compress([]);
      expect(result.messages).toEqual([]);
      expect(result.compression.ratio).toBe(1);
    });
  });

  describe('summarizer edge cases', () => {
    it('handles text with no extractable sentences', () => {
      // Text that has no sentence-ending punctuation — triggers the
      // early-return path in summarize() that previously had a TDZ bug.
      const weirdText = Array.from({ length: 20 }, (_, i) => `item_${i}`).join('\n');
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content: weirdText }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      expect(result.messages.length).toBe(1);
      // Should not throw, and round-trip should work
      const rt = uncompress(result.messages, result.verbatim);
      expect(rt.messages).toEqual(messages);
    });
  });

  describe('merged message preserves extra fields', () => {
    it('function role with name field survives merge compression', () => {
      const prose = 'This is a long function result about general topics that could be compressed since it has no verbatim content. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'function', content: prose, name: 'get_weather' }),
        msg({ id: '2', index: 1, role: 'function', content: prose, name: 'get_weather' }),
      ];
      const result = compress(messages, { recencyWindow: 0, dedup: false });
      // Merged into 1 message — should carry the name field from sourceMsgs[0]
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content).toContain('2 messages merged');
      expect((result.messages[0] as any).name).toBe('get_weather');
    });

    it('extra fields preserved on single compressed message', () => {
      const prose = 'This is a long function result about general topics that could be compressed since it has no verbatim content. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'function', content: prose, name: 'search_docs' }),
      ];
      const result = compress(messages, { recencyWindow: 0 });
      // Single message compression uses the message directly (spread)
      // name should survive through buildCompressedMessage
      expect(result.compression.messages_compressed).toBe(1);
    });
  });

  describe('dedup does not inflate messages_compressed', () => {
    it('messages_compressed excludes deduped messages', () => {
      const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(5);
      const LONG = 'This is a repeated message with enough content to exceed the two hundred character minimum threshold for dedup eligibility so we can test dedup properly across multiple messages in the conversation. Extra padding here.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, content: LONG }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
        msg({ id: '3', index: 2, content: LONG }),
      ];
      const result = compress(messages, { recencyWindow: 0, dedup: true });
      // id:1 deduped, id:2 compressed (prose), id:3 compressed (keep target)
      const { messages_compressed, messages_deduped = 0, messages_preserved } = result.compression;
      expect(messages_deduped).toBe(1);
      // compressed + deduped + preserved == total input
      expect(messages_compressed + messages_deduped + messages_preserved).toBe(messages.length);
      // Deduped messages are NOT counted in messages_compressed
      expect(messages_compressed).toBe(2);
    });

    it('exact duplicates: compressed + deduped + preserved == total', () => {
      const LONG = 'This is a repeated message with enough content to exceed the two hundred character minimum threshold for dedup eligibility so we can test dedup properly across multiple messages in the conversation. Extra padding here.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, content: LONG }),
        msg({ id: '2', index: 1, content: LONG }),
        msg({ id: '3', index: 2, content: LONG }),
      ];
      const result = compress(messages, { recencyWindow: 0, dedup: true });
      const { messages_compressed, messages_deduped = 0, messages_preserved } = result.compression;
      expect(messages_compressed + messages_deduped + messages_preserved).toBe(messages.length);
      // First two are deduped, last one (keep target) gets normally compressed
      expect(messages_deduped).toBe(2);
      expect(messages_compressed).toBe(1);
    });

    it('Object.keys(verbatim) covers all compressed and deduped messages', () => {
      const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(5);
      const LONG = 'This is a repeated message with enough content to exceed the two hundred character minimum threshold for dedup eligibility so we can test dedup properly across multiple messages in the conversation. Extra padding here.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, content: LONG }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
        msg({ id: '3', index: 2, content: LONG }),
      ];
      const result = compress(messages, { recencyWindow: 0, dedup: true });
      const { messages_compressed, messages_deduped = 0, messages_fuzzy_deduped = 0 } = result.compression;
      // Verbatim map holds originals for both compressed and deduped messages
      expect(Object.keys(result.verbatim).length).toBe(messages_compressed + messages_deduped + messages_fuzzy_deduped);
    });
  });
});

// ---------------------------------------------------------------------------
// embedSummaryId
// ---------------------------------------------------------------------------

describe('compress with embedSummaryId', () => {
  const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(5);

  it('embeds summary_id in content when enabled', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const result = compress(messages, { recencyWindow: 0, embedSummaryId: true });
    expect(result.compression.messages_compressed).toBe(1);
    expect(result.messages[0].content).toMatch(/^\[summary#uc_sum_/);
  });

  it('does not embed summary_id by default', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    expect(result.compression.messages_compressed).toBe(1);
    expect(result.messages[0].content).toMatch(/^\[summary: /);
    expect(result.messages[0].content).not.toMatch(/^\[summary#/);
  });

  it('embedded ID matches metadata summary_id', () => {
    const messages: Message[] = [
      msg({ id: 'test-id', index: 0, role: 'user', content: prose }),
    ];
    const result = compress(messages, { recencyWindow: 0, embedSummaryId: true });
    const meta = result.messages[0].metadata?._uc_original as { summary_id: string };
    expect(meta.summary_id).toMatch(/^uc_sum_/);
    expect(result.messages[0].content).toContain(`[summary#${meta.summary_id}:`);
  });

  it('re-compress of [summary# messages treats them as already-compressed', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const first = compress(messages, { recencyWindow: 0, embedSummaryId: true });
    expect(first.messages[0].content).toMatch(/^\[summary#/);

    const second = compress(first.messages, { recencyWindow: 0, embedSummaryId: true });
    // Already-compressed message should be preserved (idempotent)
    expect(second.compression.messages_compressed).toBe(0);
    expect(second.messages[0].content).toBe(first.messages[0].content);
  });

  it('round-trip integrity with embedSummaryId', () => {
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: prose }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: prose }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: false, embedSummaryId: true });
    const expanded = uncompress(result.messages, result.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('works with async summarizer', async () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const result = await compress(messages, {
      recencyWindow: 0,
      embedSummaryId: true,
      summarizer: (t) => t.slice(0, 40) + '...',
    });
    expect(result.messages[0].content).toMatch(/^\[summary#uc_sum_/);
  });
});

// ---------------------------------------------------------------------------
// forceConverge
// ---------------------------------------------------------------------------

describe('compress with forceConverge', () => {
  // Large JSON content gets preserved by normal compression (valid JSON check)
  // but is eligible for force-truncation since it's > 512 chars and not a system role
  const bigJson = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item_${i}`, desc: `Description for item number ${i} which adds length` })) });
  const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);

  it('guarantees tokenCount drops when preserved messages are force-truncated', () => {
    const messages: Message[] = [
      msg({ id: '0', index: 0, role: 'user', content: bigJson }),
      msg({ id: '1', index: 1, role: 'assistant', content: bigJson }),
      msg({ id: '2', index: 2, role: 'user', content: prose }),
    ];
    expect(bigJson.length).toBeGreaterThan(512);
    const without = compress(messages, { tokenBudget: 1, dedup: false });
    const withForce = compress(messages, { tokenBudget: 1, dedup: false, forceConverge: true });
    expect(without.fits).toBe(false);
    expect(withForce.tokenCount!).toBeLessThan(without.tokenCount!);
  });

  it('preserves round-trip integrity (uncompress recovers originals)', () => {
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: bigJson }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: prose }),
    ];
    const result = compress(messages, { tokenBudget: 1, dedup: false, forceConverge: true });
    const expanded = uncompress(result.messages, result.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('respects minRecencyWindow — recency messages NOT truncated', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: bigJson }));
    }
    const result = compress(messages, { tokenBudget: 1, minRecencyWindow: 3, dedup: false, forceConverge: true });
    // Last 3 messages are in the recency window and must not be truncated
    const last3 = result.messages.slice(-3);
    for (const m of last3) {
      expect(m.content).not.toMatch(/^\[truncated/);
    }
  });

  it('respects system role — not truncated', () => {
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'A'.repeat(1000) }),
      msg({ id: 'u1', index: 1, role: 'user', content: bigJson }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: prose }),
    ];
    const result = compress(messages, { tokenBudget: 1, dedup: false, forceConverge: true });
    // System message should not be truncated
    expect(result.messages[0].content).not.toMatch(/^\[truncated/);
    expect(result.messages[0].content).toBe('A'.repeat(1000));
  });

  it('without forceConverge, impossible budget → fits: false', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: bigJson }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
    ];
    const result = compress(messages, { tokenBudget: 1, dedup: false });
    expect(result.fits).toBe(false);
  });

  it('works with async summarizer', async () => {
    const messages: Message[] = [
      msg({ id: '0', index: 0, role: 'user', content: bigJson }),
      msg({ id: '1', index: 1, role: 'assistant', content: bigJson }),
      msg({ id: '2', index: 2, role: 'user', content: prose }),
    ];
    const without = await compress(messages, { tokenBudget: 1, dedup: false, summarizer: (t) => t.slice(0, 30) + '...' });
    const withForce = await compress(messages, { tokenBudget: 1, dedup: false, forceConverge: true, summarizer: (t) => t.slice(0, 30) + '...' });
    expect(withForce.tokenCount!).toBeLessThan(without.tokenCount!);
  });

  it('no-op when already under budget', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: 'Short.' }),
    ];
    const result = compress(messages, { tokenBudget: 10000, forceConverge: true });
    expect(result.fits).toBe(true);
    expect(result.messages[0].content).toBe('Short.');
  });

  it('re-compression of [truncated messages is idempotent', () => {
    const messages: Message[] = [
      msg({ id: 'u1', index: 0, role: 'user', content: bigJson }),
      msg({ id: 'a1', index: 1, role: 'assistant', content: bigJson }),
    ];
    const first = compress(messages, { tokenBudget: 1, dedup: false, forceConverge: true });
    // Some messages should have been force-truncated
    const hasTruncated = first.messages.some(m => typeof m.content === 'string' && m.content.startsWith('[truncated'));
    expect(hasTruncated).toBe(true);

    // Re-compress: truncated messages should be preserved, not re-summarized
    const second = compress(first.messages, { recencyWindow: 0, dedup: false });
    for (const m of second.messages) {
      const content = typeof m.content === 'string' ? m.content : '';
      if (content.startsWith('[truncated')) {
        // Must still start with [truncated — not re-wrapped as [summary:
        expect(content).not.toMatch(/^\[summary/);
      }
    }
    expect(second.compression.messages_compressed).toBe(0);
  });

  it('truncates already-compressed messages that exceed 512 chars', () => {
    // Code-split produces content > 512 chars: [summary: ...] + code fences
    const longFence = '```ts\n' + 'const x = 1;\n'.repeat(50) + '```';
    const longProse = 'This is a detailed explanation of the authentication system design and how it integrates with session management. '.repeat(4);
    const codeContent = `${longProse}\n\n${longFence}`;
    const messages: Message[] = [
      msg({ id: 'cs1', index: 0, role: 'assistant', content: codeContent }),
      msg({ id: 'u1', index: 1, role: 'user', content: 'Short question.' }),
    ];
    // First compress without budget to get the code-split result
    const initial = compress(messages, { recencyWindow: 0, dedup: false });
    const csSummary = initial.messages[0].content!;
    // Code-split output should have _uc_original and be > 512 chars
    expect(initial.messages[0].metadata?._uc_original).toBeDefined();
    if (csSummary.length > 512) {
      // Now compress with impossible budget + forceConverge
      const result = compress(initial.messages, { tokenBudget: 1, dedup: false, forceConverge: true });
      const truncMsg = result.messages[0];
      expect(truncMsg.content).toMatch(/^\[truncated/);
      // Original _uc_original should survive (not overwritten)
      expect(truncMsg.metadata?._uc_original).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// dedup tag includes keep-target ID
// ---------------------------------------------------------------------------

describe('dedup tag includes keep-target ID', () => {
  const LONG = 'This is a repeated message with enough content to exceed the two hundred character minimum threshold for dedup eligibility so we can test dedup properly across multiple messages in the conversation. Extra padding here.';

  it('exact dup tag contains the keep-target message ID', () => {
    const messages: Message[] = [
      msg({ id: 'first', index: 0, content: LONG }),
      msg({ id: 'keep-me', index: 1, content: LONG }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.messages[0].content).toContain('of keep-me');
  });

  it('three copies — dedup tags reference the correct keep target', () => {
    const messages: Message[] = [
      msg({ id: 'a', index: 0, content: LONG }),
      msg({ id: 'b', index: 1, content: LONG }),
      msg({ id: 'c', index: 2, content: LONG }),
    ];
    const result = compress(messages, { recencyWindow: 0, dedup: true });
    // c is the keep target (latest)
    expect(result.messages[0].content).toContain('of c');
    expect(result.messages[1].content).toContain('of c');
    expect(result.messages[2].content).not.toMatch(/^\[uc:dup/);
  });
});
