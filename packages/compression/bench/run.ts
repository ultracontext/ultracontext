import { compressMessages } from '../src/compress.js';
import { expandMessages } from '../src/expand.js';
import type { Message } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;
function msg(
  role: string,
  content: string,
  extra?: Partial<Message>,
): Message {
  const id = String(nextId++);
  return { id, index: nextId - 1, role, content, metadata: {}, ...extra };
}

function chars(messages: Message[]): number {
  return messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Scenario = { name: string; messages: Message[] };

function buildScenarios(): Scenario[] {
  nextId = 1;

  return [
    codingAssistant(),
    longQA(),
    toolHeavy(),
    shortConversation(),
    deepConversation(),
  ];
}

function codingAssistant(): Scenario {
  const prose =
    'The authentication middleware validates incoming JWT tokens against the session store, checks expiration timestamps, and refreshes tokens when they are within the renewal window. ';
  return {
    name: 'Coding assistant',
    messages: [
      msg('system', 'You are a senior TypeScript developer.'),
      msg('user', 'How do I set up Express middleware for JWT auth?'),
      msg(
        'assistant',
        `${prose.repeat(3)}\n\n\`\`\`typescript\nimport jwt from 'jsonwebtoken';\n\nexport function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'No token' });\n  try {\n    req.user = jwt.verify(token, process.env.JWT_SECRET);\n    next();\n  } catch {\n    res.status(401).json({ error: 'Invalid token' });\n  }\n}\n\`\`\``,
      ),
      msg('user', 'Can you add refresh token rotation?'),
      msg(
        'assistant',
        `${prose.repeat(4)}\n\n\`\`\`typescript\nasync function rotateRefreshToken(oldToken: string) {\n  const payload = jwt.verify(oldToken, REFRESH_SECRET);\n  await revokeToken(oldToken);\n  return {\n    access: jwt.sign({ sub: payload.sub }, ACCESS_SECRET, { expiresIn: '15m' }),\n    refresh: jwt.sign({ sub: payload.sub }, REFRESH_SECRET, { expiresIn: '7d' }),\n  };\n}\n\`\`\``,
      ),
      msg('user', 'What about rate limiting?'),
      msg(
        'assistant',
        `Rate limiting prevents abuse by capping the number of requests a client can make in a time window. ${prose.repeat(3)}\n\n\`\`\`typescript\nimport rateLimit from 'express-rate-limit';\n\nconst limiter = rateLimit({\n  windowMs: 15 * 60 * 1000,\n  max: 100,\n  standardHeaders: true,\n});\napp.use('/api/', limiter);\n\`\`\``,
      ),
      msg('user', 'How do I test this?'),
      msg(
        'assistant',
        `Testing middleware requires mocking the request and response objects. ${prose.repeat(2)}\n\n\`\`\`typescript\nimport { describe, it, expect, vi } from 'vitest';\nimport { authMiddleware } from './auth';\n\ndescribe('authMiddleware', () => {\n  it('rejects missing token', () => {\n    const req = { headers: {} } as any;\n    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;\n    authMiddleware(req, res, vi.fn());\n    expect(res.status).toHaveBeenCalledWith(401);\n  });\n});\n\`\`\``,
      ),
      msg('user', 'Thanks, this is very helpful.'),
      msg('assistant', 'Happy to help. Let me know if you need anything else.'),
      msg('user', 'One more thing — should I store refresh tokens in Redis?'),
      msg(
        'assistant',
        `Redis is an excellent choice for refresh token storage because of its built-in TTL support and atomic operations. ${prose.repeat(3)} You can use the ioredis library for a robust connection pool.`,
      ),
    ],
  };
}

function longQA(): Scenario {
  const longAnswer =
    'The architecture of modern distributed systems relies on several foundational principles including service isolation, eventual consistency, and fault tolerance. Each service maintains its own data store, communicating through asynchronous message queues or synchronous RPC calls depending on latency requirements. Circuit breakers prevent cascading failures by monitoring error rates and temporarily halting requests to degraded downstream services. ';
  return {
    name: 'Long Q&A',
    messages: [
      msg('system', 'You are a software architecture consultant.'),
      msg('user', 'What is event sourcing?'),
      msg('assistant', longAnswer.repeat(4)),
      msg('user', 'How does CQRS relate to it?'),
      msg('assistant', longAnswer.repeat(5)),
      msg('user', 'What about saga patterns?'),
      msg('assistant', longAnswer.repeat(4)),
      msg('user', 'Can you compare choreography vs orchestration?'),
      msg('assistant', longAnswer.repeat(6)),
      msg('user', 'Which one should I use for payments?'),
      msg('assistant', longAnswer.repeat(3)),
    ],
  };
}

function toolHeavy(): Scenario {
  return {
    name: 'Tool-heavy',
    messages: [
      msg('system', 'You are a coding assistant with tool access.'),
      msg('user', 'Find all TypeScript files with auth in the name'),
      msg(
        'assistant',
        'I will search for those files now.',
        { tool_calls: [{ id: 'tc1', function: { name: 'glob', arguments: '{"pattern":"**/*auth*.ts"}' } }] },
      ),
      msg('tool', '["src/auth.ts","src/middleware/auth.ts","tests/auth.test.ts"]'),
      msg('assistant', 'Found 3 files. Let me read the main auth module.', {
        tool_calls: [{ id: 'tc2', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }],
      }),
      msg(
        'tool',
        'import jwt from "jsonwebtoken";\n\nexport function verify(token: string) {\n  return jwt.verify(token, process.env.SECRET!);\n}\n\nexport function sign(payload: object) {\n  return jwt.sign(payload, process.env.SECRET!, { expiresIn: "1h" });\n}',
      ),
      msg('assistant', 'The auth module exports verify and sign functions. Let me check the middleware.', {
        tool_calls: [{ id: 'tc3', function: { name: 'read', arguments: '{"path":"src/middleware/auth.ts"}' } }],
      }),
      msg(
        'tool',
        'import { verify } from "../auth";\n\nexport function requireAuth(req, res, next) {\n  try {\n    req.user = verify(req.headers.authorization);\n    next();\n  } catch {\n    res.status(401).end();\n  }\n}',
      ),
      msg('assistant', 'The middleware calls verify from the auth module. Now checking the test.', {
        tool_calls: [{ id: 'tc4', function: { name: 'read', arguments: '{"path":"tests/auth.test.ts"}' } }],
      }),
      msg(
        'tool',
        'import { describe, it, expect } from "vitest";\nimport { verify, sign } from "../src/auth";\n\ndescribe("auth", () => {\n  it("round-trips", () => {\n    const token = sign({ sub: "user1" });\n    expect(verify(token).sub).toBe("user1");\n  });\n});',
      ),
      msg('user', 'Can you add a test for expired tokens?'),
      msg('assistant', 'I will add an expiration test.', {
        tool_calls: [{ id: 'tc5', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } }],
      }),
      msg('tool', 'File updated successfully.'),
      msg('user', 'Great, looks good.'),
    ],
  };
}

function shortConversation(): Scenario {
  return {
    name: 'Short conversation',
    messages: [
      msg('system', 'You are a helpful assistant.'),
      msg('user', 'What is 2+2?'),
      msg('assistant', '4'),
      msg('user', 'And 3+3?'),
      msg('assistant', '6'),
      msg('user', 'Thanks'),
      msg('assistant', 'You are welcome!'),
    ],
  };
}

function deepConversation(): Scenario {
  const topics = [
    'database schema design',
    'API endpoint structure',
    'authentication flow',
    'error handling strategy',
    'caching layer',
    'deployment pipeline',
    'monitoring setup',
    'testing approach',
    'code review process',
    'documentation standards',
  ];

  const messages: Message[] = [
    msg('system', 'You are a senior software architect helping plan a new microservice.'),
  ];

  for (let i = 0; i < 25; i++) {
    const topic = topics[i % topics.length];
    messages.push(
      msg(
        'user',
        `Let's discuss the ${topic}. What patterns do you recommend for a high-traffic production service handling thousands of concurrent requests? ` +
          `We need to consider scalability, maintainability, and operational overhead. `.repeat(2),
      ),
    );
    messages.push(
      msg(
        'assistant',
        `For ${topic}, I recommend the following approach based on industry best practices and patterns I have seen succeed at scale. ` +
          `The key consideration is balancing complexity against the actual traffic patterns your service will encounter. ` +
          `You should start with a simpler architecture and evolve it as your requirements become clearer through production usage. `.repeat(4) +
          ` This approach has proven effective across multiple production deployments.`,
      ),
    );
  }

  return { name: 'Deep conversation', messages };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Result {
  name: string;
  msgCount: number;
  originalChars: number;
  compressedChars: number;
  ratio: string;
  compressed: number;
  preserved: number;
  roundTrip: 'PASS' | 'FAIL';
  timeMs: string;
}

function run(): void {
  const scenarios = buildScenarios();
  const results: Result[] = [];

  for (const scenario of scenarios) {
    const t0 = performance.now();

    const cr = compressMessages(scenario.messages, { recencyWindow: 0 });

    const er = expandMessages(cr.messages, cr.verbatim);

    const t1 = performance.now();

    // Round-trip check: expanded messages should match originals
    const originalJson = JSON.stringify(scenario.messages);
    const expandedJson = JSON.stringify(er.messages);
    const roundTrip =
      originalJson === expandedJson && er.missing_ids.length === 0
        ? 'PASS'
        : 'FAIL';

    results.push({
      name: scenario.name,
      msgCount: scenario.messages.length,
      originalChars: chars(scenario.messages),
      compressedChars: chars(cr.messages),
      ratio: cr.compression.ratio.toFixed(2),
      compressed: cr.compression.messages_compressed,
      preserved: cr.compression.messages_preserved,
      roundTrip,
      timeMs: (t1 - t0).toFixed(2),
    });
  }

  // Print table
  const cols = {
    name: 20,
    msgs: 5,
    original: 9,
    compressed: 11,
    ratio: 6,
    comp: 5,
    pres: 5,
    rt: 5,
    time: 8,
  };

  const header = [
    'Scenario'.padEnd(cols.name),
    'Msgs'.padStart(cols.msgs),
    'Orig'.padStart(cols.original),
    'Compressed'.padStart(cols.compressed),
    'Ratio'.padStart(cols.ratio),
    'Comp'.padStart(cols.comp),
    'Pres'.padStart(cols.pres),
    'R/T'.padStart(cols.rt),
    'Time'.padStart(cols.time),
  ].join('  ');

  const sep = '-'.repeat(header.length);

  console.log();
  console.log('Compression Benchmark');
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const r of results) {
    console.log(
      [
        r.name.padEnd(cols.name),
        String(r.msgCount).padStart(cols.msgs),
        String(r.originalChars).padStart(cols.original),
        String(r.compressedChars).padStart(cols.compressed),
        r.ratio.padStart(cols.ratio),
        String(r.compressed).padStart(cols.comp),
        String(r.preserved).padStart(cols.pres),
        r.roundTrip.padStart(cols.rt),
        (r.timeMs + 'ms').padStart(cols.time),
      ].join('  '),
    );
  }

  console.log(sep);
  console.log();

  const failures = results.filter((r) => r.roundTrip === 'FAIL');
  if (failures.length > 0) {
    console.error(
      `FAIL: ${failures.length} scenario(s) failed round-trip: ${failures.map((f) => f.name).join(', ')}`,
    );
    process.exit(1);
  }

  console.log('All scenarios passed round-trip verification.');
}

run();
