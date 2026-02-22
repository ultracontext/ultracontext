import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import { analyzeDuplicates, analyzeFuzzyDuplicates } from '../src/dedup.js';
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

// ---------------------------------------------------------------------------
// Fuzzy dedup tests
// ---------------------------------------------------------------------------

// Multi-line content for fuzzy dedup (needs lines for fingerprint bucketing + Jaccard)
const MULTILINE_FILE = [
  'import jwt from "jsonwebtoken";',
  'import { Request, Response } from "express";',
  '',
  'interface JWTPayload {',
  '  sub: string;',
  '  email: string;',
  '  roles: string[];',
  '  iat: number;',
  '  exp: number;',
  '}',
  '',
  'export class AuthService {',
  '  private readonly secret: string;',
  '',
  '  constructor(secret: string) {',
  '    this.secret = secret;',
  '  }',
  '',
  '  verify(token: string): JWTPayload {',
  '    return jwt.verify(token, this.secret) as JWTPayload;',
  '  }',
  '',
  '  sign(payload: Omit<JWTPayload, "iat" | "exp">): string {',
  '    return jwt.sign(payload, this.secret, { expiresIn: "15m" });',
  '  }',
  '}',
].join('\n');

// ~90% similar: 2 lines changed (method renamed, comment added)
const MULTILINE_FILE_V2 = [
  'import jwt from "jsonwebtoken";',
  'import { Request, Response } from "express";',
  '',
  'interface JWTPayload {',
  '  sub: string;',
  '  email: string;',
  '  roles: string[];',
  '  iat: number;',
  '  exp: number;',
  '}',
  '',
  'export class AuthService {',
  '  private readonly secret: string;',
  '',
  '  constructor(secret: string) {',
  '    this.secret = secret;',
  '  }',
  '',
  '  // Validates a JWT token and returns the decoded payload',
  '  validateToken(token: string): JWTPayload {',
  '    return jwt.verify(token, this.secret) as JWTPayload;',
  '  }',
  '',
  '  sign(payload: Omit<JWTPayload, "iat" | "exp">): string {',
  '    return jwt.sign(payload, this.secret, { expiresIn: "15m" });',
  '  }',
  '}',
].join('\n');

// ~55% Jaccard with MULTILINE_FILE: shares first 4 lines for bucketing
// but has significant body changes (6-7 lines changed out of ~21)
const MULTILINE_FILE_MODERATE = [
  'import jwt from "jsonwebtoken";',
  'import { Request, Response } from "express";',
  '',
  'interface JWTPayload {',
  '  sub: string;',
  '  email: string;',
  '  roles: string[];',
  '  iat: number;',
  '  exp: number;',
  '}',
  '',
  'export class AuthService {',
  '  private readonly secret: string;',
  '  private readonly tokenStore: Map<string, boolean>;',
  '',
  '  constructor(secret: string, tokenStore: Map<string, boolean>) {',
  '    this.secret = secret;',
  '    this.tokenStore = tokenStore;',
  '  }',
  '',
  '  validateAndDecode(token: string): JWTPayload {',
  '    if (this.tokenStore.has(token)) throw new Error("Token revoked");',
  '    return jwt.verify(token, this.secret) as JWTPayload;',
  '  }',
  '',
  '  issueToken(payload: Omit<JWTPayload, "iat" | "exp">): string {',
  '    return jwt.sign(payload, this.secret, { expiresIn: "30m" });',
  '  }',
  '}',
].join('\n');

// Truly different file — shares fewer than 3 of first 5 lines, won't be bucketed together
const MULTILINE_FILE_DIFFERENT = [
  'import crypto from "node:crypto";',
  'import { EventEmitter } from "node:events";',
  '',
  'interface SessionData {',
  '  userId: string;',
  '  permissions: string[];',
  '  createdAt: number;',
  '  expiresAt: number;',
  '}',
  '',
  'export class SessionManager {',
  '  private readonly store: Map<string, SessionData>;',
  '',
  '  constructor() {',
  '    this.store = new Map();',
  '  }',
  '',
  '  createSession(userId: string, permissions: string[]): string {',
  '    const id = crypto.randomUUID();',
  '    this.store.set(id, { userId, permissions, createdAt: Date.now(), expiresAt: Date.now() + 3600000 });',
  '    return id;',
  '  }',
  '',
  '  getSession(id: string): SessionData | undefined {',
  '    return this.store.get(id);',
  '  }',
  '}',
].join('\n');

describe('analyzeFuzzyDuplicates', () => {
  it('near-duplicate detected (90% overlap)', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: 'something else entirely that is different from the file content.' }),
      msg({ id: '3', index: 2, content: MULTILINE_FILE_V2 }),
    ];
    const result = analyzeFuzzyDuplicates(messages, messages.length, new Set(['system']), new Map(), 0.85);
    expect(result.size).toBe(1);
    expect(result.has(0)).toBe(true);
    expect(result.get(0)!.duplicateOfIndex).toBe(2);
    expect(result.get(0)!.similarity).toBeGreaterThanOrEqual(0.85);
    expect(result.get(0)!.similarity).toBeLessThan(1);
  });

  it('below threshold not deduped (70% overlap)', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: MULTILINE_FILE_DIFFERENT }),
    ];
    const result = analyzeFuzzyDuplicates(messages, messages.length, new Set(['system']), new Map(), 0.85);
    expect(result.size).toBe(0);
  });

  it('exact match still uses exact dedup (skipped by fuzzy)', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: MULTILINE_FILE }),
    ];
    // Simulate that index 0 is already in exactAnnotations
    const exactAnnotations = new Map<number, { duplicateOfIndex: number; contentLength: number }>();
    exactAnnotations.set(0, { duplicateOfIndex: 1, contentLength: MULTILINE_FILE.length });
    const result = analyzeFuzzyDuplicates(messages, messages.length, new Set(['system']), exactAnnotations, 0.85);
    // Index 0 is already exact-deduped, index 1 is the only remaining eligible → no pair
    expect(result.size).toBe(0);
  });

  it('short messages skipped (<200 chars)', () => {
    const shortA = 'line one\nline two\nline three\nline four\nline five\nline six';
    const shortB = 'line one\nline two\nline three\nline four\nline five\nline seven';
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: shortA }),
      msg({ id: '2', index: 1, content: shortB }),
    ];
    const result = analyzeFuzzyDuplicates(messages, messages.length, new Set(['system']), new Map(), 0.85);
    expect(result.size).toBe(0);
  });

  it('custom threshold catches looser matches', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: MULTILINE_FILE_MODERATE }),
    ];
    // Default 0.85 won't match these (~50% similar), but 0.4 will
    const noMatch = analyzeFuzzyDuplicates(messages, messages.length, new Set(['system']), new Map(), 0.85);
    expect(noMatch.size).toBe(0);
    const match = analyzeFuzzyDuplicates(messages, messages.length, new Set(['system']), new Map(), 0.4);
    expect(match.size).toBe(1);
  });
});

// Content for transitive fuzzy similarity test
// A~B shares ~90% lines, B~C shares ~90% lines, but A~C is lower (~70%)
// This tests that transitive grouping computes real Jaccard, not threshold fallback
const TRANSITIVE_A = [
  'import jwt from "jsonwebtoken";',
  'import { Request, Response } from "express";',
  '',
  'interface AuthPayload {',
  '  sub: string;',
  '  email: string;',
  '  roles: string[];',
  '  iat: number;',
  '  exp: number;',
  '}',
  '',
  'export class AuthService {',
  '  private readonly secret: string;',
  '',
  '  constructor(secret: string) {',
  '    this.secret = secret;',
  '  }',
  '',
  '  verify(token: string): AuthPayload {',
  '    return jwt.verify(token, this.secret) as AuthPayload;',
  '  }',
  '',
  '  sign(payload: Omit<AuthPayload, "iat" | "exp">): string {',
  '    return jwt.sign(payload, this.secret, { expiresIn: "15m" });',
  '  }',
  '}',
].join('\n');

// B shares ~90% with A: two lines changed (comment + renamed method)
const TRANSITIVE_B = [
  'import jwt from "jsonwebtoken";',
  'import { Request, Response } from "express";',
  '',
  'interface AuthPayload {',
  '  sub: string;',
  '  email: string;',
  '  roles: string[];',
  '  iat: number;',
  '  exp: number;',
  '}',
  '',
  'export class AuthService {',
  '  private readonly secret: string;',
  '',
  '  constructor(secret: string) {',
  '    this.secret = secret;',
  '  }',
  '',
  '  // Validates a JWT token',
  '  validateToken(token: string): AuthPayload {',
  '    return jwt.verify(token, this.secret) as AuthPayload;',
  '  }',
  '',
  '  sign(payload: Omit<AuthPayload, "iat" | "exp">): string {',
  '    return jwt.sign(payload, this.secret, { expiresIn: "15m" });',
  '  }',
  '}',
].join('\n');

// C shares ~91% with B (1 line changed: sign→issueToken) but only ~79% with A
// (3 lines differ: verify→validateToken+comment from A→B, sign→issueToken from B→C)
const TRANSITIVE_C = [
  'import jwt from "jsonwebtoken";',
  'import { Request, Response } from "express";',
  '',
  'interface AuthPayload {',
  '  sub: string;',
  '  email: string;',
  '  roles: string[];',
  '  iat: number;',
  '  exp: number;',
  '}',
  '',
  'export class AuthService {',
  '  private readonly secret: string;',
  '',
  '  constructor(secret: string) {',
  '    this.secret = secret;',
  '  }',
  '',
  '  // Validates a JWT token',
  '  validateToken(token: string): AuthPayload {',
  '    return jwt.verify(token, this.secret) as AuthPayload;',
  '  }',
  '',
  '  issueToken(payload: Omit<AuthPayload, "iat" | "exp">): string {',
  '    return jwt.sign(payload, this.secret, { expiresIn: "15m" });',
  '  }',
  '}',
].join('\n');

describe('transitive fuzzy similarity reports real Jaccard', () => {
  it('annotation for A~C uses computed similarity, not threshold fallback', () => {
    // A~B ~= 0.87 (2 lines differ in 21→22), B~C ~= 0.91 (1 line differ in 22)
    // A~C ~= 0.79 (3 lines differ: verify→comment+validateToken, sign→issueToken)
    // Union-find groups all three; C is kept (latest); A's annotation should
    // report real A~C Jaccard, NOT the threshold value.
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: TRANSITIVE_A }),
      msg({ id: '2', index: 1, content: TRANSITIVE_B }),
      msg({ id: '3', index: 2, content: TRANSITIVE_C }),
    ];
    const result = analyzeFuzzyDuplicates(messages, messages.length, new Set(['system']), new Map(), 0.85);
    // Both A and B should be annotated; C is the keep target
    expect(result.size).toBe(2);

    // A's annotation: similarity should be the real A~C Jaccard (~0.79),
    // NOT the threshold (0.85)
    const annotationA = result.get(0)!;
    expect(annotationA).toBeDefined();
    expect(annotationA.similarity).toBeDefined();
    expect(annotationA.similarity!).toBeLessThan(0.85);
    expect(annotationA.similarity!).toBeGreaterThan(0.5);

    // B's annotation: direct match with C (~0.91), should be >= 0.85
    const annotationB = result.get(1)!;
    expect(annotationB).toBeDefined();
    expect(annotationB.similarity!).toBeGreaterThanOrEqual(0.85);
  });
});

describe('compress with fuzzy dedup', () => {
  it('near-duplicate → earlier replaced with [uc:near-dup ...]', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: 'something different in between that has enough length to avoid the short message threshold check.  Extra padding here.' }),
      msg({ id: '3', index: 2, content: MULTILINE_FILE_V2 }),
    ];
    const result = compress(messages, { recencyWindow: 0, fuzzyDedup: true });
    expect(result.messages[0].content).toMatch(/^\[uc:near-dup/);
    expect(result.messages[0].content).toContain('% match');
    expect(result.compression.messages_fuzzy_deduped).toBe(1);
    // Exact dedup count should be 0 (these aren't identical)
    expect(result.compression.messages_deduped).toBeUndefined();
  });

  it('fuzzy dedup off by default', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: 'filler message with enough length to pass the threshold check that is required for dedup eligibility in the system. Extra padding here.' }),
      msg({ id: '3', index: 2, content: MULTILINE_FILE_V2 }),
    ];
    const result = compress(messages, { recencyWindow: 0 });
    // Without fuzzyDedup: true, near-duplicates should NOT be caught
    expect(result.messages[0].content).not.toMatch(/^\[uc:near-dup/);
    expect(result.compression.messages_fuzzy_deduped).toBeUndefined();
  });

  it('exact match still uses [uc:dup], not [uc:near-dup]', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: MULTILINE_FILE }),
    ];
    const result = compress(messages, { recencyWindow: 0, fuzzyDedup: true });
    expect(result.messages[0].content).toMatch(/^\[uc:dup/);
    expect(result.messages[0].content).not.toMatch(/^\[uc:near-dup/);
    expect(result.compression.messages_deduped).toBe(1);
  });

  it('custom fuzzyThreshold catches looser matches', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: MULTILINE_FILE_MODERATE }),
    ];
    // Default 0.85 won't catch these, but 0.4 will
    const noMatch = compress(messages, { recencyWindow: 0, fuzzyDedup: true });
    expect(noMatch.messages[0].content).not.toMatch(/^\[uc:near-dup/);
    const match = compress(messages, { recencyWindow: 0, fuzzyDedup: true, fuzzyThreshold: 0.4 });
    expect(match.messages[0].content).toMatch(/^\[uc:near-dup/);
    expect(match.compression.messages_fuzzy_deduped).toBe(1);
  });

  it('recency window respected — near-dup in window kept, earlier replaced', () => {
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: MULTILINE_FILE }),
      msg({ id: '2', index: 1, content: 'filler message that passes the threshold.' }),
      msg({ id: '3', index: 2, content: MULTILINE_FILE_V2 }),
    ];
    // recencyWindow: 1 → only last message preserved by recency
    const result = compress(messages, { recencyWindow: 1, fuzzyDedup: true });
    // Earlier occurrence should be fuzzy-deduped
    expect(result.messages[0].content).toMatch(/^\[uc:near-dup/);
    // Last message (in recency window) preserved
    expect(result.messages[2].content).toBe(MULTILINE_FILE_V2);
  });

  it('round-trip: compress(fuzzyDedup) → uncompress → original content restored', () => {
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, content: MULTILINE_FILE }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: 'Short reply.' }),
      msg({ id: 'u2', index: 3, content: MULTILINE_FILE_V2 }),
    ];
    const compressed = compress(messages, { recencyWindow: 0, fuzzyDedup: true });
    expect(compressed.compression.messages_fuzzy_deduped).toBeGreaterThanOrEqual(1);
    const expanded = uncompress(compressed.messages, compressed.verbatim);
    expect(expanded.messages).toEqual(messages);
    expect(expanded.missing_ids).toEqual([]);
  });
});
