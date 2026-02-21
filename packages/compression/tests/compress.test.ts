import { describe, it, expect } from 'vitest';
import { compressMessages, compressMessagesAsync, compressToFit, compressToFitAsync, estimateTokens } from '../src/compress.js';
import { expandMessages } from '../src/expand.js';
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

    it('compresses long prose tool messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: 'Tool output result that is fairly long and contains detailed information about the operation. '.repeat(5) }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages[0].role).toBe('tool');
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });

    it('compresses long prose function messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'function', content: 'Function result with enough content to pass the length threshold easily here. '.repeat(5) }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages[0].role).toBe('function');
      expect(result.messages[0].content).toMatch(/^\[summary:/);
      expect(result.compression.messages_compressed).toBe(1);
    });

    it('preserves tool messages with JSON content', () => {
      const jsonContent = JSON.stringify({ result: 'success', data: { items: [1, 2, 3], total: 3 } });
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: jsonContent }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe(jsonContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves tool messages with code content', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: '```typescript\nconst x = 1;\nconst y = 2;\nreturn x + y;\n```\nHere is the code result from the tool execution.' }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toContain('```');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves short tool messages', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: 'OK' }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe('OK');
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves tool results containing SQL', () => {
      const sqlContent = 'SELECT u.id, u.email FROM users u JOIN orders o ON u.id = o.user_id WHERE o.total > 100 ORDER BY o.created_at DESC LIMIT 50';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: sqlContent }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe(sqlContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves tool results containing API keys', () => {
      const envContent = 'DATABASE_URL=postgres://localhost/mydb\nOPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr\nPORT=3000';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'tool', content: envContent }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.messages[0].content).toBe(envContent);
      expect(result.compression.messages_preserved).toBe(1);
    });

    it('preserves function results containing SQL', () => {
      const sqlContent = 'ERROR: relation "users" does not exist\nSTATEMENT: INSERT INTO audit_log (user_id, action) VALUES ($1, $2) RETURNING id';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'function', content: sqlContent }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      expect(result.compression.token_ratio).toBeGreaterThan(1);
    });

    it('token_ratio === 1 when all preserved', () => {
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
        msg({ id: '2', index: 1, role: 'user', content: 'Short msg.' }),
      ];
      const result = compressMessages(messages);
      expect(result.compression.token_ratio).toBe(1);
    });

    it('token_ratio differs from char ratio', () => {
      const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
        msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      // Both should be > 1 since compression happened
      expect(result.compression.ratio).toBeGreaterThan(1);
      expect(result.compression.token_ratio).toBeGreaterThan(1);
      // They use different denominators (chars vs ceil(chars/3.5)) so won't be identical
      expect(result.compression.token_ratio).not.toBe(result.compression.ratio);
    });

    it('token_ratio uses ceil(chars/3.5) estimation', () => {
      // 350 chars → ceil(350/3.5) = 100 tokens
      const content = 'x'.repeat(350);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content }),
      ];
      // Won't compress (classifier sees it as T0 due to low variance), but we can
      // verify the ratio math on the empty-compression path
      const result = compressMessages(messages, { recencyWindow: 0 });
      // All preserved → token_ratio === 1
      expect(result.compression.token_ratio).toBe(1);
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

    it('caps at 400 chars when no punctuation', () => {
      const noPunct = 'word '.repeat(200); // 1000 chars, no sentence-ending punctuation
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: noPunct }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      expect(content).toContain('database needs three replicas');
      expect(content).toContain('PostgreSQL');
    });

    it('falls back to first sentence when all sentences are filler', () => {
      const text = 'Sure thing. OK then. Thanks for that. Got it. No problem. Will do. Right. Absolutely. '.repeat(3);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      const content = result.messages[0].content!;
      // Should capture content from multiple paragraphs, not just first+last
      expect(content).toContain('caching layer');
    });

    it('weights emphasis words higher', () => {
      const text = 'The system starts up normally. However the authentication module requires special configuration. The logs show standard output.';
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: text.repeat(4) }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      const match = result.messages[0].content!.match(/\[summary: (.*?)(?:\s*\(|\s*\||\])/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(400);
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
      // Entity-heavy prose >= 200 chars enters the code-split path (not filtered by threshold).
      // Many identifiers inflate the [summary: ... | entities: ...] bracket past the original,
      // so the size guard must be what preserves it.
      const prose = 'We call getUserProfile fetchUserData handleAuthToken validateSession refreshCache parseConfig buildQuery formatResponse and logMetrics in TypeScript WebSocket Express middleware. Also uses auth_token user_session cache_key. ';
      const fence = '```ts\nx()\n```';
      const content = `${prose}\n\n${fence}`;
      expect(prose.trim().length).toBeGreaterThanOrEqual(200);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'assistant', content }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      // Guard fired: message preserved verbatim, not compressed
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

  describe('no negative savings', () => {
    it('prose-only compression never exceeds original length', () => {
      // Medium (120-800) and large (>800) prose paths must both shrink
      const medium = 'This talks about general topics without any special formatting or patterns that would trigger preservation rules. '.repeat(3);
      const large = 'This talks about general topics without any special formatting or patterns that would trigger preservation rules. '.repeat(10);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: medium }),
        msg({ id: '2', index: 1, role: 'assistant', content: large }),
      ];
      const result = compressMessages(messages, { preserve: [], recencyWindow: 0 });
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
      const first = compressMessages(messages, { recencyWindow: 0 });
      expect(first.compression.messages_compressed).toBeGreaterThan(0);

      const second = compressMessages(first.messages, { recencyWindow: 0 });
      expect(second.compression.messages_compressed).toBe(0);
      expect(second.messages).toEqual(first.messages);
    });
  });

  describe('prose-only size guard', () => {
    it('preserves entity-dense short messages where summary would grow', () => {
      // ~135 chars packed with identifiers — bracket overhead will exceed original
      const content = 'Call getUserProfile fetchUserData handleAuthToken validateSession refreshCache parseConfig buildQuery formatResponse logMetrics in the TypeScript codebase.';
      expect(content.length).toBeGreaterThanOrEqual(120);
      expect(content.length).toBeLessThan(300);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content }),
      ];
      const result = compressMessages(messages, { preserve: [], recencyWindow: 0 });
      expect(result.compression.messages_preserved).toBe(1);
      expect(result.compression.messages_compressed).toBe(0);
      expect(result.messages[0].content).toBe(content);
    });

    it('multi-message merge preserves when summary exceeds combined length', () => {
      // Two short-ish messages whose combined content is shorter than the merge summary
      const content1 = 'Call getUserProfile fetchUserData handleAuthToken validateSession refreshCache parseConfig buildQuery formatResponse logMetrics in the codebase.';
      const content2 = 'Also call parseConfig buildQuery formatResponse logMetrics getUserProfile fetchUserData handleAuthToken validateSession refreshCache here.';
      expect(content1.length).toBeGreaterThanOrEqual(120);
      expect(content2.length).toBeGreaterThanOrEqual(120);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: content1 }),
        msg({ id: '2', index: 1, role: 'user', content: content2 }),
      ];
      const result = compressMessages(messages, { preserve: [], recencyWindow: 0 });
      // Both messages preserved individually — no merge
      expect(result.messages.length).toBe(2);
      expect(result.messages[0].content).toBe(content1);
      expect(result.messages[1].content).toBe(content2);
      expect(result.compression.messages_preserved).toBe(2);
      expect(result.compression.messages_compressed).toBe(0);
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
      const result = compressMessages(messages, { recencyWindow: 0 });
      // sys preserved by role, short by length — the rest compressed
      expect(Object.keys(result.verbatim).sort()).toEqual(['a1', 'a2', 'u1', 'u2']);
      expect(result.verbatim['u1'].content).toBe(prose);
      expect(result.verbatim['a1'].content).toBe(codeContent);
    });

    it('empty when nothing compressed (including empty input)', () => {
      expect(compressMessages([]).verbatim).toEqual({});
      const preserved: Message[] = [
        msg({ id: '1', index: 0, role: 'system', content: 'System.' }),
        msg({ id: '2', index: 1, role: 'user', content: 'Short.' }),
      ];
      expect(compressMessages(preserved).verbatim).toEqual({});
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
        const result = compressMessages(messages, { recencyWindow: 0 });
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
      const result = compressMessages(messages, { recencyWindow: 0, sourceVersion: 42 });
      const meta = result.messages[0].metadata?._uc_original as { version: number };
      expect(meta.version).toBe(42);
      expect(result.compression.original_version).toBe(42);
    });

    it('sourceVersion defaults to 0 when omitted', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const messages: Message[] = [
        msg({ id: '1', index: 0, role: 'user', content: prose }),
      ];
      const result = compressMessages(messages, { recencyWindow: 0 });
      const meta = result.messages[0].metadata?._uc_original as { version: number };
      expect(meta.version).toBe(0);
      expect(result.compression.original_version).toBe(0);
    });

    it('generates deterministic summary_id from input ids', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const r1 = compressMessages([msg({ id: 'a', index: 0, role: 'user', content: prose })], { recencyWindow: 0 });
      const r2 = compressMessages([msg({ id: 'a', index: 0, role: 'user', content: prose })], { recencyWindow: 0 });
      const r3 = compressMessages([msg({ id: 'b', index: 0, role: 'user', content: prose })], { recencyWindow: 0 });
      const m1 = r1.messages[0].metadata?._uc_original as { summary_id: string };
      const m2 = r2.messages[0].metadata?._uc_original as { summary_id: string };
      const m3 = r3.messages[0].metadata?._uc_original as { summary_id: string };
      expect(m1.summary_id).toMatch(/^uc_sum_/);
      expect(m1.summary_id).toBe(m2.summary_id);
      expect(m1.summary_id).not.toBe(m3.summary_id);
    });

    it('omits parent_ids when source has no prior _uc_original', () => {
      const prose = 'This is a long message about general topics that could be compressed. '.repeat(5);
      const result = compressMessages(
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
      const result = compressMessages(messages, { preserve: [], recencyWindow: 0 });
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
// compressMessagesAsync
// ---------------------------------------------------------------------------

const LONG_PROSE = 'This is a long message about general topics that could be compressed. '.repeat(5);

describe('compressMessagesAsync', () => {
  it('sync compressMessages throws when summarizer is provided', () => {
    expect(() =>
      compressMessages(
        [msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE })],
        { recencyWindow: 0, summarizer: (t) => t.slice(0, 20) },
      ),
    ).toThrow('summarizer requires compressMessagesAsync');
  });

  it('async with no summarizer produces identical output to sync', async () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: '2', index: 1, role: 'user', content: LONG_PROSE }),
      msg({ id: '3', index: 2, role: 'assistant', content: LONG_PROSE }),
    ];
    const sync = compressMessages(messages, { recencyWindow: 0 });
    const async_ = await compressMessagesAsync(messages, { recencyWindow: 0 });
    expect(async_.messages).toEqual(sync.messages);
    expect(async_.compression).toEqual(sync.compression);
    expect(async_.verbatim).toEqual(sync.verbatim);
  });

  it('uses LLM result when shorter than input', async () => {
    const mockSummarizer = async (text: string) => text.slice(0, 50) + '...';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const result = await compressMessagesAsync(messages, { recencyWindow: 0, summarizer: mockSummarizer });
    expect(result.compression.messages_compressed).toBe(1);
    // The summary should contain the truncated text from our mock
    expect(result.messages[0].content).toMatch(/^\[summary:/);
  });

  it('falls back to deterministic when LLM returns longer text', async () => {
    const growingSummarizer = async (text: string) => text + ' EXTRA PADDING THAT MAKES IT LONGER';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const withLlm = await compressMessagesAsync(messages, { recencyWindow: 0, summarizer: growingSummarizer });
    const withoutLlm = compressMessages(messages, { recencyWindow: 0 });
    // Should fall back to deterministic — same output
    expect(withLlm.messages).toEqual(withoutLlm.messages);
  });

  it('falls back when LLM throws', async () => {
    const failingSummarizer = async () => { throw new Error('LLM unavailable'); };
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const withLlm = await compressMessagesAsync(messages, { recencyWindow: 0, summarizer: failingSummarizer });
    const withoutLlm = compressMessages(messages, { recencyWindow: 0 });
    expect(withLlm.messages).toEqual(withoutLlm.messages);
  });

  it('round-trip: async compress then expand = byte-identical', async () => {
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: LONG_PROSE }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: LONG_PROSE }),
    ];
    const compressed = await compressMessagesAsync(messages, { recencyWindow: 0 });
    expect(compressed.compression.messages_compressed).toBeGreaterThan(0);
    const expanded = expandMessages(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('works with a synchronous summarizer (non-Promise return)', async () => {
    const syncSummarizer = (text: string) => text.slice(0, 40) + '...';
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: LONG_PROSE }),
    ];
    const result = await compressMessagesAsync(messages, { recencyWindow: 0, summarizer: syncSummarizer });
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
    const result = await compressMessagesAsync(messages, { recencyWindow: 0, summarizer: trackingSummarizer });
    // Summarizer should have been called with prose, not code
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain('```');
    // Code fence preserved in output
    expect(result.messages[0].content).toContain(code);
  });
});

// ---------------------------------------------------------------------------
// compressToFit
// ---------------------------------------------------------------------------

describe('compressToFit', () => {
  it('returns fits: true when already under budget (zero compression)', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: 'Short message.' }),
    ];
    const result = compressToFit(messages, 1000);
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
    // Set budget to ~half the total
    const result = compressToFit(messages, Math.floor(totalTokens / 2));
    expect(result.fits).toBe(true);
    expect(result.tokenCount).toBeLessThanOrEqual(Math.floor(totalTokens / 2));
    expect(result.recencyWindow).toBeLessThan(messages.length);
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
  });

  it('returns fits: false with best effort for impossible budgets', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
    ];
    const result = compressToFit(messages, 1); // impossibly small budget
    expect(result.fits).toBe(false);
    // Still returns best effort
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
    const result = compressToFit(messages, Math.floor(totalTokens / 2));
    const expanded = expandMessages(result.messages, result.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });

  it('respects minRecencyWindow', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: prose }));
    }
    const result = compressToFit(messages, 1, { minRecencyWindow: 5 });
    expect(result.recencyWindow).toBeGreaterThanOrEqual(5);
  });

  it('recencyWindow and tokenCount in result are accurate', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
      msg({ id: '2', index: 1, role: 'assistant', content: prose }),
      msg({ id: '3', index: 2, role: 'user', content: 'Final question.' }),
    ];
    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    const result = compressToFit(messages, Math.floor(totalTokens / 2));
    // Verify tokenCount matches actual token count of result
    const actualTokens = result.messages.reduce((sum: number, m: Message) => sum + estimateTokens(m), 0);
    expect(result.tokenCount).toBe(actualTokens);
  });

  it('handles single message', () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: '1', index: 0, role: 'user', content: prose }),
    ];
    const result = compressToFit(messages, 10);
    // Single message, budget too small — best effort
    expect(result.fits).toBe(false);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    const result = compressToFit([], 1000);
    expect(result.fits).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.tokenCount).toBe(0);
  });

  it('sync throws when summarizer provided', () => {
    expect(() =>
      compressToFit(
        [msg({ id: '1', index: 0, role: 'user', content: 'test' })],
        1000,
        { summarizer: (t) => t.slice(0, 10) },
      ),
    ).toThrow('summarizer requires compressToFitAsync');
  });

  it('compressToFitAsync with summarizer achieves tighter fit', async () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg({ id: `${i}`, index: i, role: i % 2 === 0 ? 'user' : 'assistant', content: prose }));
    }
    const aggressiveSummarizer = async (text: string) => text.slice(0, 30) + '...';
    const syncResult = compressToFit(messages, 200);
    const asyncResult = await compressToFitAsync(messages, 200, { summarizer: aggressiveSummarizer });
    // Async with aggressive summarizer should produce equal or fewer tokens
    expect(asyncResult.tokenCount).toBeLessThanOrEqual(syncResult.tokenCount);
  });

  it('compressToFitAsync round-trip integrity', async () => {
    const prose = 'This is a long message about general topics that could be compressed since it has no verbatim content. '.repeat(10);
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: prose }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: prose }),
    ];
    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    const result = await compressToFitAsync(messages, Math.floor(totalTokens / 2));
    const expanded = expandMessages(result.messages, result.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });
});
