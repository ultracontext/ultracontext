import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import type { CompressResult, Message } from '../src/types.js';

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
    structuredContent(),
    agenticCodingSession(),
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
  // Long prose tool result: pure T3 prose, >120 chars, no code fences / SQL / API keys / URLs / JSON
  const longProse =
    'The authentication service handles all user identity verification across the platform. ' +
    'When a request arrives, the service first checks the session store for an active session, ' +
    'then validates the token signature against the current signing key. If the token has expired ' +
    'but falls within the renewal window, the service automatically issues a fresh token pair. ' +
    'The service maintains a blocklist of revoked tokens in memory, synchronized across instances ' +
    'through a pub-sub channel. Failed authentication attempts are tracked per account to enable ' +
    'progressive lockout after repeated failures. The service also provides hooks for downstream ' +
    'middleware to attach additional claims or enforce fine-grained access policies based on ' +
    'resource ownership.';

  return {
    name: 'Tool-heavy',
    messages: [
      msg('system', 'You are a coding assistant with tool access.'),
      msg('user', 'Find all TypeScript files with auth in the name'),
      // Tool call 1: glob → JSON array (preserved: short JSON)
      msg('assistant', 'I will search for those files now.', {
        tool_calls: [{ id: 'tc1', function: { name: 'glob', arguments: '{"pattern":"**/*auth*.ts"}' } }],
      }),
      msg('tool', '["src/auth.ts","src/middleware/auth.ts","tests/auth.test.ts","docs/auth-guide.md"]'),
      // Tool call 2: read docs → long prose (compressed: T3)
      msg('assistant', 'Found 4 files. Let me read the documentation first.', {
        tool_calls: [{ id: 'tc2', function: { name: 'read', arguments: '{"path":"docs/auth-guide.md"}' } }],
      }),
      msg('tool', longProse),
      // Tool call 3: read SQL → SQL query (preserved: T0 sql_content)
      msg('assistant', 'Now let me check the database schema.', {
        tool_calls: [{ id: 'tc3', function: { name: 'read', arguments: '{"path":"schema.sql"}' } }],
      }),
      msg(
        'tool',
        'SELECT u.id, u.email, u.created_at, r.name AS role_name\n' +
          'FROM users u\n' +
          'INNER JOIN user_roles ur ON ur.user_id = u.id\n' +
          'INNER JOIN roles r ON r.id = ur.role_id\n' +
          'WHERE u.active = true AND u.email_verified = true\n' +
          'ORDER BY u.created_at DESC',
      ),
      // Tool call 4: read env → API keys in plaintext config (preserved: T0 api_key + url)
      msg('assistant', 'Let me check the configuration.', {
        tool_calls: [{ id: 'tc4', function: { name: 'read', arguments: '{"path":".env.example"}' } }],
      }),
      msg(
        'tool',
        'STRIPE_SECRET_KEY=sk_live_abc123def456ghi789jkl012\n' +
          'GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqr678\n' +
          'DATABASE_URL=postgresql://admin:secret@db.example.com:5432/myapp\n' +
          'REDIS_URL=redis://cache.example.com:6379',
      ),
      // Tool call 5: read code → code snippet (preserved: T0 structural)
      msg('assistant', 'Let me read the main auth module.', {
        tool_calls: [{ id: 'tc5', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }],
      }),
      msg(
        'tool',
        'import jwt from "jsonwebtoken";\n\nexport function verify(token: string) {\n  return jwt.verify(token, process.env.SECRET!);\n}\n\nexport function sign(payload: object) {\n  return jwt.sign(payload, process.env.SECRET!, { expiresIn: "1h" });\n}',
      ),
      // Tool call 6: edit → short status (preserved: short)
      msg('user', 'Can you add a test for expired tokens?'),
      msg('assistant', 'I will add an expiration test.', {
        tool_calls: [{ id: 'tc6', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } }],
      }),
      msg('tool', 'File updated successfully.'),
      msg('assistant', 'Done. The test file now includes an expiration test case.'),
      msg('user', 'Great, looks good.'),
      msg('assistant', 'Happy to help! Let me know if you need anything else.'),
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
    'performance profiling',
    'logging strategy',
    'feature flags',
    'data migration',
    'API versioning',
    'circuit breakers',
    'message queuing',
    'secrets management',
    'load balancing',
    'container orchestration',
    'service discovery',
    'observability',
    'incident response',
    'capacity planning',
    'access control',
  ];

  const messages: Message[] = [
    msg('system', 'You are a senior software architect helping plan a new microservice.'),
  ];

  for (let i = 0; i < 25; i++) {
    const topic = topics[i];
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

function structuredContent(): Scenario {
  // Pure prose about auth (~1500 chars): no code, URLs, SQL, API keys, JSON, paths, etc.
  const authProse =
    'Setting up authentication for a production environment requires careful planning across ' +
    'several layers of the system. The first step is establishing a strong identity provider ' +
    'that supports modern protocols. You will want to implement token-based authentication ' +
    'with short-lived access tokens and longer-lived refresh tokens stored securely on the ' +
    'client side. The server should validate tokens on every request through middleware that ' +
    'sits early in the request pipeline.\n\n' +
    'Password hashing should use a modern algorithm with appropriate cost factors that balance ' +
    'security against response time. Each user account should have a unique salt generated at ' +
    'registration time. The system should enforce minimum password complexity requirements ' +
    'without being overly restrictive, as research shows that overly strict rules often lead ' +
    'to weaker passwords in practice.\n\n' +
    'Session management needs to handle concurrent logins gracefully. You should decide whether ' +
    'to allow multiple active sessions per user or enforce single-session access. Each session ' +
    'should track the originating device and location to help users audit their account activity. ' +
    'Inactive sessions should expire automatically after a configurable timeout period.\n\n' +
    'Rate limiting on authentication endpoints is essential to prevent brute force attacks. ' +
    'Implement progressive delays after failed attempts, starting with short pauses and increasing ' +
    'exponentially. After a threshold of failures, temporarily lock the account and notify the ' +
    'user through an out-of-band channel. Keep detailed logs of all authentication events for ' +
    'security auditing and incident response.';

  // Pure prose about monitoring (~1200 chars): same constraints as above
  const monitoringProse =
    'Monitoring a production environment effectively means collecting metrics at every layer of ' +
    'the stack and correlating them to build a complete picture of system health. Start with ' +
    'infrastructure metrics like memory utilization, disk throughput, and network latency across ' +
    'all nodes in the cluster. These baseline metrics help you understand normal operating ' +
    'patterns so you can detect anomalies quickly.\n\n' +
    'Application-level metrics should track request rates, error rates, and response time ' +
    'distributions. Percentile-based measurements give a much more accurate picture than simple ' +
    'averages, which can mask problems affecting a subset of users. Track these metrics per ' +
    'endpoint to identify which parts of the system are under strain.\n\n' +
    'Log aggregation brings all service output into a single searchable store that lets you ' +
    'trace requests across service boundaries. Each log entry should carry a correlation ' +
    'identifier that follows the request starting at ingress through to the final response. ' +
    'This makes debugging distributed failures dramatically easier than searching individual ' +
    'service logs.\n\n' +
    'Alerting rules should be tuned to minimize noise while catching real incidents. Start with ' +
    'broad thresholds and tighten them as you learn what normal looks like for your system. Every ' +
    'alert should have a clear runbook that describes what the responder should check first and ' +
    'what remediation steps to take.';

  return {
    name: 'Structured content',
    messages: [
      msg('system', 'You are a DevOps consultant helping set up a production environment.'),
      msg('user', 'Set up our production environment with all the credentials.'),
      // Env block with API keys in plaintext config (preserved: T0 api_key)
      msg(
        'assistant',
        'Here are the environment variables you need to configure:\n\n' +
          'STRIPE_SECRET_KEY=sk_live_Rz4x8Kp2Qm7Yn3Wv9Bt6Jh0L\n' +
          'GITHUB_TOKEN=ghp_Mn3Kx8Rz4Qp7Yv2Wt9Bj6Lh0Ds5Fa1Gc8Eu4Iw\n' +
          'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n' +
          'SENDGRID_API_KEY=SG.xY7kZmN2pQ9rS4tU6vW8aB.cD3eF5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7f',
      ),
      msg('user', 'What about the database schema?'),
      // SQL DDL (preserved: T0 sql_content)
      msg(
        'assistant',
        'Here is the initial schema for the audit log:\n\n' +
          'CREATE TABLE audit_logs (\n' +
          '  id SERIAL PRIMARY KEY,\n' +
          '  user_id INTEGER NOT NULL,\n' +
          '  action VARCHAR(100) NOT NULL,\n' +
          '  resource_type VARCHAR(50),\n' +
          '  resource_id INTEGER,\n' +
          '  details TEXT,\n' +
          '  created_at TIMESTAMP DEFAULT NOW(),\n' +
          '  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE\n' +
          ');',
      ),
      msg('user', 'How should we handle authentication?'),
      // Long prose about auth (compressed: T3)
      msg('assistant', authProse),
      msg('user', 'What about monitoring?'),
      // Long prose about monitoring (compressed: T3)
      msg('assistant', monitoringProse),
      msg('user', 'Show me a dashboard configuration.'),
      // JSON in code fence (preserved: T0 code_fence)
      msg(
        'assistant',
        'Here is a starter dashboard configuration:\n\n' +
          '```json\n' +
          '{\n' +
          '  "dashboard": "production-overview",\n' +
          '  "refresh_interval": 30,\n' +
          '  "panels": [\n' +
          '    { "title": "Request Rate", "type": "graph", "metric": "http_requests_total" },\n' +
          '    { "title": "Error Rate", "type": "graph", "metric": "http_errors_total" },\n' +
          '    { "title": "P99 Latency", "type": "gauge", "metric": "http_duration_p99" }\n' +
          '  ]\n' +
          '}\n' +
          '```',
      ),
      msg('user', 'Thanks, this is exactly what I needed.'),
    ],
  };
}

function agenticCodingSession(): Scenario {
  // Simulates a realistic agentic coding session with repeated file reads,
  // grep results, test output, and linter output across edit-test-fix cycles.

  const authModule =
    'import jwt from "jsonwebtoken";\nimport { Request, Response, NextFunction } from "express";\n\n' +
    'interface JWTPayload {\n  sub: string;\n  email: string;\n  roles: string[];\n  iat: number;\n  exp: number;\n}\n\n' +
    'export class AuthService {\n  private readonly secret: string;\n  private readonly refreshSecret: string;\n\n' +
    '  constructor(secret: string, refreshSecret: string) {\n    this.secret = secret;\n    this.refreshSecret = refreshSecret;\n  }\n\n' +
    '  verify(token: string): JWTPayload {\n    return jwt.verify(token, this.secret) as JWTPayload;\n  }\n\n' +
    '  sign(payload: Omit<JWTPayload, "iat" | "exp">): string {\n    return jwt.sign(payload, this.secret, { expiresIn: "15m" });\n  }\n\n' +
    '  signRefresh(payload: { sub: string }): string {\n    return jwt.sign(payload, this.refreshSecret, { expiresIn: "7d" });\n  }\n\n' +
    '  middleware(req: Request, res: Response, next: NextFunction): void {\n    const header = req.headers.authorization;\n' +
    '    if (!header?.startsWith("Bearer ")) {\n      res.status(401).json({ error: "Missing token" });\n      return;\n    }\n' +
    '    try {\n      (req as any).user = this.verify(header.slice(7));\n      next();\n    } catch {\n' +
    '      res.status(401).json({ error: "Invalid token" });\n    }\n  }\n}\n';

  const grepResults =
    'src/auth.ts:18:  verify(token: string): JWTPayload {\n' +
    'src/auth.ts:22:    return jwt.verify(token, this.secret) as JWTPayload;\n' +
    'src/middleware/validate.ts:7:  const decoded = authService.verify(req.headers.authorization!);\n' +
    'src/middleware/validate.ts:12:  if (!decoded) throw new UnauthorizedError("Token verification failed");\n' +
    'src/routes/admin.ts:34:    const user = auth.verify(token);\n' +
    'src/routes/admin.ts:35:    if (!user.roles.includes("admin")) return res.status(403).json({ error: "Forbidden" });\n' +
    'tests/auth.test.ts:14:      const payload = service.verify(token);\n' +
    'tests/auth.test.ts:22:      expect(() => service.verify(expired)).toThrow();\n' +
    'tests/integration/auth.integration.ts:45:    const result = authService.verify(response.body.token);\n';

  const testOutput =
    ' RUN  v1.6.0 /project\n\n' +
    ' ✓ tests/auth.test.ts (5 tests) 42ms\n' +
    '   ✓ AuthService > sign and verify > produces a valid JWT\n' +
    '   ✓ AuthService > sign and verify > rejects expired tokens\n' +
    '   ✓ AuthService > middleware > rejects missing auth header\n' +
    '   ✓ AuthService > middleware > attaches user to request on valid token\n' +
    '   ✗ AuthService > refresh > rotates token correctly\n' +
    '     → expected "user1" but got undefined\n' +
    '     at tests/auth.test.ts:48:22\n\n' +
    ' Test Files  1 passed | 0 failed\n' +
    ' Tests  4 passed | 1 failed\n' +
    ' Duration  1.34s\n';

  const lintOutput =
    'src/auth.ts\n' +
    '  18:3  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n' +
    '  31:7  warning  Missing return type on function            @typescript-eslint/explicit-function-return-type\n' +
    '  42:5  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n\n' +
    'tests/auth.test.ts\n' +
    '  8:24  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n' +
    '  9:24  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n\n' +
    '✖ 5 problems (0 errors, 5 warnings)\n';

  return {
    name: 'Agentic coding session',
    messages: [
      msg('system', 'You are a senior TypeScript developer.'),

      // --- Phase 1: Initial exploration (file reads) ---
      msg('user', 'Read the auth module and tell me what it does.'),
      msg('assistant', 'Let me read that file.', {
        tool_calls: [{ id: 'tc1', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }],
      }),
      msg('tool', authModule),  // 1st read of auth.ts
      msg('assistant', 'This is an AuthService class that handles JWT authentication with access and refresh tokens, plus Express middleware.'),

      // --- Phase 2: Grep for usages ---
      msg('user', 'Search the codebase for all usages of validateToken.'),
      msg('assistant', 'Searching for validateToken references.', {
        tool_calls: [{ id: 'tc2', function: { name: 'grep', arguments: '{"pattern":"validateToken|verify.*token","path":"src/"}' } }],
      }),
      msg('tool', grepResults),  // 1st grep
      msg('assistant', 'Found 9 references across auth.ts, validate.ts middleware, admin routes, and tests.'),

      // --- Phase 3: Edit and test (first cycle) ---
      msg('user', 'Add a test for refresh token rotation.'),
      msg('assistant', 'Let me re-read the auth module to check the method signature.', {
        tool_calls: [{ id: 'tc3', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }],
      }),
      msg('tool', authModule),  // 2nd read of auth.ts — DUPLICATE
      msg('assistant', 'The signRefresh method takes { sub: string }. Adding the rotation test.', {
        tool_calls: [{ id: 'tc4', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } }],
      }),
      msg('tool', 'File updated successfully.'),  // short — stays below dedup threshold

      // --- Phase 4: Run tests (fail) ---
      msg('user', 'Run the tests.'),
      msg('assistant', 'Running the test suite.', {
        tool_calls: [{ id: 'tc5', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } }],
      }),
      msg('tool', testOutput),  // 1st test output — shows failure

      // --- Phase 5: Fix and re-test ---
      msg('assistant', 'The rotation test failed — decoded payload is undefined. Let me check the verify call in the test.', {
        tool_calls: [{ id: 'tc6', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }],
      }),
      msg('tool', authModule),  // 3rd read of auth.ts — DUPLICATE
      msg('assistant', 'Found it. The test was calling verify with the refresh token but using the access secret. Fixing.', {
        tool_calls: [{ id: 'tc7', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } }],
      }),
      msg('tool', 'Updated tests/auth.test.ts'),  // short

      // --- Phase 6: Lint check ---
      msg('user', 'Run the linter before we test again.'),
      msg('assistant', 'Running eslint.', {
        tool_calls: [{ id: 'tc8', function: { name: 'exec', arguments: '{"cmd":"npx eslint src/ tests/"}' } }],
      }),
      msg('tool', lintOutput),  // 1st lint output

      // --- Phase 7: Re-run tests (still failing differently) ---
      msg('assistant', 'There are 5 warnings but no errors. Running tests again.', {
        tool_calls: [{ id: 'tc9', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } }],
      }),
      msg('tool', testOutput),  // 2nd test output — DUPLICATE (same results)

      // --- Phase 8: Another grep to find related code ---
      msg('assistant', 'Still failing. Let me search for verify references again to check the middleware path.', {
        tool_calls: [{ id: 'tc10', function: { name: 'grep', arguments: '{"pattern":"validateToken|verify.*token","path":"src/"}' } }],
      }),
      msg('tool', grepResults),  // 2nd grep — DUPLICATE

      // --- Phase 9: Fix, lint, and final test ---
      msg('assistant', 'The issue is in the middleware — it also calls verify. Let me fix the test to use the correct secret.', {
        tool_calls: [{ id: 'tc11', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } }],
      }),
      msg('tool', 'File updated successfully.'),  // short
      msg('user', 'Lint and test again.'),
      msg('assistant', 'Running lint.', {
        tool_calls: [{ id: 'tc12', function: { name: 'exec', arguments: '{"cmd":"npx eslint src/ tests/"}' } }],
      }),
      msg('tool', lintOutput),  // 2nd lint output — DUPLICATE

      msg('assistant', 'Same warnings, no new issues. Running tests.', {
        tool_calls: [{ id: 'tc13', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } }],
      }),
      msg('tool', testOutput),  // 3rd test output — DUPLICATE
      msg('assistant', 'All 5 tests passing now. The rotation test verifies the new token contains the original subject claim.'),
      msg('user', 'Nice, looks good.'),
    ],
  };
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
  tokenRatio: string;
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

    const cr = compress(scenario.messages, { recencyWindow: 0 });

    const er = uncompress(cr.messages, cr.verbatim);

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
      tokenRatio: cr.compression.token_ratio.toFixed(2),
      compressed: cr.compression.messages_compressed,
      preserved: cr.compression.messages_preserved,
      roundTrip,
      timeMs: (t1 - t0).toFixed(2),
    });
  }

  // Print table
  const cols = {
    name: 24,
    msgs: 5,
    original: 9,
    compressed: 11,
    charRatio: 6,
    tokRatio: 6,
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
    'ChR'.padStart(cols.charRatio),
    'TkR'.padStart(cols.tokRatio),
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
        r.ratio.padStart(cols.charRatio),
        r.tokenRatio.padStart(cols.tokRatio),
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

  // ---------------------------------------------------------------------------
  // tokenBudget scenarios
  // ---------------------------------------------------------------------------

  const tokenBudget = 2000;
  const budgetScenarios: Scenario[] = [
    deepConversation(),
    agenticCodingSession(),
  ];

  console.log();
  console.log('tokenBudget Benchmark');

  const tbHeader = [
    'Scenario'.padEnd(cols.name),
    'Dedup'.padStart(6),
    'Msgs'.padStart(5),
    'Budget'.padStart(7),
    'Tokens'.padStart(7),
    'Fits'.padStart(5),
    'Rw'.padStart(4),
    'Comp'.padStart(5),
    'Pres'.padStart(5),
    'Ddup'.padStart(5),
    'R/T'.padStart(cols.rt),
    'Time'.padStart(cols.time),
  ].join('  ');
  const tbSep = '-'.repeat(tbHeader.length);

  console.log(tbSep);
  console.log(tbHeader);
  console.log(tbSep);

  let tbFails = 0;

  for (const scenario of budgetScenarios) {
    for (const dedup of [false, true]) {
      const t0 = performance.now();
      const cr: CompressResult = compress(scenario.messages, { tokenBudget, dedup });
      const t1 = performance.now();

      const er = uncompress(cr.messages, cr.verbatim);
      const rt =
        JSON.stringify(scenario.messages) === JSON.stringify(er.messages) && er.missing_ids.length === 0
          ? 'PASS'
          : 'FAIL';
      if (rt === 'FAIL') tbFails++;

      console.log(
        [
          scenario.name.padEnd(cols.name),
          (dedup ? 'yes' : 'no').padStart(6),
          String(scenario.messages.length).padStart(5),
          String(tokenBudget).padStart(7),
          String(cr.tokenCount).padStart(7),
          String(cr.fits).padStart(5),
          String(cr.recencyWindow ?? '-').padStart(4),
          String(cr.compression.messages_compressed).padStart(5),
          String(cr.compression.messages_preserved).padStart(5),
          String(cr.compression.messages_deduped ?? 0).padStart(5),
          rt.padStart(cols.rt),
          ((t1 - t0).toFixed(2) + 'ms').padStart(cols.time),
        ].join('  '),
      );
    }
  }

  console.log(tbSep);

  if (tbFails > 0) {
    console.error(`FAIL: ${tbFails} tokenBudget scenario(s) failed round-trip`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Dedup comparison (rw=0 and rw=4)
  // ---------------------------------------------------------------------------

  console.log();
  console.log('Dedup Comparison (dedup: true vs baseline)');

  const dedupHeader = [
    'Scenario'.padEnd(cols.name),
    'rw0 Base'.padStart(9),
    'rw0 Dup'.padStart(8),
    'rw4 Base'.padStart(9),
    'rw4 Dup'.padStart(8),
    'Deduped'.padStart(8),
    'R/T'.padStart(cols.rt),
  ].join('  ');
  const dedupSep = '-'.repeat(dedupHeader.length);

  console.log(dedupSep);
  console.log(dedupHeader);
  console.log(dedupSep);

  const dedupScenarios = buildScenarios();
  let dedupFails = 0;

  for (const scenario of dedupScenarios) {
    const baseRw0 = compress(scenario.messages, { recencyWindow: 0 });
    const dedupRw0 = compress(scenario.messages, { recencyWindow: 0, dedup: true });
    const baseRw4 = compress(scenario.messages, { recencyWindow: 4 });
    const dedupRw4 = compress(scenario.messages, { recencyWindow: 4, dedup: true });

    // Round-trip check on the rw=4 dedup result
    const er2 = uncompress(dedupRw4.messages, dedupRw4.verbatim);
    const rt2 =
      JSON.stringify(scenario.messages) === JSON.stringify(er2.messages) && er2.missing_ids.length === 0
        ? 'PASS'
        : 'FAIL';
    if (rt2 === 'FAIL') dedupFails++;

    const deduped = dedupRw4.compression.messages_deduped ?? 0;

    console.log(
      [
        scenario.name.padEnd(cols.name),
        baseRw0.compression.ratio.toFixed(2).padStart(9),
        dedupRw0.compression.ratio.toFixed(2).padStart(8),
        baseRw4.compression.ratio.toFixed(2).padStart(9),
        dedupRw4.compression.ratio.toFixed(2).padStart(8),
        String(deduped).padStart(8),
        rt2.padStart(cols.rt),
      ].join('  '),
    );
  }

  console.log(dedupSep);

  if (dedupFails > 0) {
    console.error(`FAIL: ${dedupFails} dedup scenario(s) failed round-trip`);
    process.exit(1);
  }

  console.log();
  console.log('All benchmarks passed.');
}

run();
