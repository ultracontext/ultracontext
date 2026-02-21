/**
 * Real-world stress tests — validates classifier + compressor against
 * content patterns that caused false-positives in production.
 *
 * Run: npx tsx bench/stress.ts
 */
import { classifyMessage } from '../src/classify.js';
import { compressMessages } from '../src/compress.js';
import { expandMessages } from '../src/expand.js';
import type { Message } from '../src/types.js';

let nextId = 1;
function msg(role: string, content: string, extra?: Partial<Message>): Message {
  const id = String(nextId++);
  return { id, index: nextId - 1, role, content, metadata: {}, ...extra };
}

type TestResult = { name: string; pass: boolean; detail: string };
const results: TestResult[] = [];

function test(name: string, fn: () => { pass: boolean; detail: string }) {
  try {
    const { pass, detail } = fn();
    results.push({ name, pass, detail });
  } catch (e: unknown) {
    results.push({ name, pass: false, detail: `THREW: ${(e as Error).message}` });
  }
}

// ---------------------------------------------------------------------------
// A: SQL false-positives on English prose
// ---------------------------------------------------------------------------

test('A1: prose with "select" + "from" — no sql_content', () => {
  const r = classifyMessage(
    'Please select your preferred option from the dropdown menu. The team will update the configuration and create a new deployment pipeline for the staging environment.'
  );
  return { pass: !r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A2: prose with "where" + "values" — no sql_content', () => {
  const r = classifyMessage(
    'The system processes entries where defaults are established across all tenants. Users should adjust these values to match their specific operational requirements and constraints.'
  );
  return { pass: !r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A3: prose with "schema" + "from" — no sql_content', () => {
  const r = classifyMessage(
    'When moving from the old schema to the new architecture, teams should carefully plan the migration path to minimize downtime and ensure data integrity across all services.'
  );
  return { pass: !r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A4: prose with "update" + "delete" + "from" — no sql_content (3 kw, 0 anchors)', () => {
  const r = classifyMessage(
    'We need to update the documentation and delete the old drafts from the shared drive before the quarterly review next Monday.'
  );
  return { pass: !r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A5: prose with "select" + "from" + "schema" + "view" — no sql_content (4 kw, 2 weak, < strong)', () => {
  const r = classifyMessage(
    'You can select the appropriate view from the schema browser to inspect the data model. The dashboard shows the current configuration state for all active environments.'
  );
  return { pass: !r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A6: real SQL still detected — SELECT FROM WHERE', () => {
  const r = classifyMessage('SELECT u.id, u.email FROM users u WHERE u.active = true');
  return { pass: r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A7: real SQL still detected — INSERT INTO VALUES', () => {
  const r = classifyMessage("INSERT INTO audit_log (user_id, action) VALUES ($1, $2) RETURNING id");
  return { pass: r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A8: real SQL still detected — UPDATE SET WHERE', () => {
  const r = classifyMessage("UPDATE users SET active = false WHERE last_login < '2024-01-01'");
  return { pass: r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

test('A9: real SQL still detected — CREATE TABLE with PRIMARY KEY', () => {
  const r = classifyMessage('CREATE TABLE sessions (id SERIAL PRIMARY KEY, token VARCHAR(255) NOT NULL)');
  return { pass: r.reasons.includes('sql_content'), detail: `reasons: ${r.reasons}` };
});

// ---------------------------------------------------------------------------
// B: API key false-positives on CSS class names
// ---------------------------------------------------------------------------

test('B1: CSS BEM class — no api_key', () => {
  const r = classifyMessage(
    'Apply the class billing-dashboard-wrapper-outer-container-v2 to the root element for the new layout.'
  );
  return { pass: !r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('B2: long kebab-case identifier — no api_key', () => {
  const r = classifyMessage(
    'The component uses user-profile-settings-panel-container-main-v3 as its root class.'
  );
  return { pass: !r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('B3: npm scope-like name — no api_key', () => {
  const r = classifyMessage(
    'Install the package my-org-internal-service-name-production from the private registry.'
  );
  return { pass: !r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('B4: Tailwind-style utility classes — no api_key', () => {
  const r = classifyMessage(
    'Use the classes flex-col-reverse-items-center-justify-between-gap-4 and bg-gradient-to-r for the hero section.'
  );
  return { pass: !r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('B5: real generic API key still detected', () => {
  const r = classifyMessage('Token: myservice-a8Kj2mNp4qRs6tUv8wXy0zBc3dEfGh');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('B6: Supabase-style key still detected', () => {
  const r = classifyMessage('Token: sbp_a8b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('B7: sk-proj key still detected', () => {
  const r = classifyMessage('Key: sk-proj-abc123def456ghi789jkl012mno345pqr');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

// ---------------------------------------------------------------------------
// C: 753-char prose tool result — should COMPRESS, not preserve
// ---------------------------------------------------------------------------

test('C1: long prose tool result gets compressed', () => {
  const toolProse =
    'The authentication service handles all user identity verification across the platform. ' +
    'When a request arrives, the service first checks the session store for an active session, ' +
    'then validates the token signature against the current signing key. If the token has expired ' +
    'but falls within the renewal window, the service automatically issues a fresh token pair. ' +
    'The service maintains a blocklist of revoked tokens in memory, synchronized across instances ' +
    'through a pub-sub channel. Failed authentication attempts are tracked per account to enable ' +
    'progressive lockout after repeated failures. The service also provides hooks for downstream ' +
    'middleware to attach additional claims or enforce fine-grained access policies based on ' +
    'resource ownership.';

  const messages = [msg('tool', toolProse)];
  const r = compressMessages(messages, { recencyWindow: 0 });
  const compressed = r.compression.messages_compressed > 0;
  const summary = r.messages[0].content?.startsWith('[summary:') ?? false;
  return {
    pass: compressed && summary,
    detail: `compressed=${compressed}, chars=${toolProse.length}, output=${r.messages[0].content?.slice(0, 80)}...`,
  };
});

test('C2: same prose classified as T3 (not T0)', () => {
  const toolProse =
    'The authentication service handles all user identity verification across the platform. ' +
    'When a request arrives, the service first checks the session store for an active session, ' +
    'then validates the token signature against the current signing key. If the token has expired ' +
    'but falls within the renewal window, the service automatically issues a fresh token pair. ' +
    'The service maintains a blocklist of revoked tokens in memory, synchronized across instances ' +
    'through a pub-sub channel. Failed authentication attempts are tracked per account to enable ' +
    'progressive lockout after repeated failures. The service also provides hooks for downstream ' +
    'middleware to attach additional claims or enforce fine-grained access policies based on ' +
    'resource ownership.';
  const r = classifyMessage(toolProse);
  return { pass: r.decision === 'T3', detail: `decision=${r.decision}, reasons=${r.reasons}` };
});

// ---------------------------------------------------------------------------
// D: multi-paragraph prose — compressed, summary captures emphasis
// ---------------------------------------------------------------------------

test('D1: multi-paragraph prose compresses and captures emphasis from paragraph 2', () => {
  const prose =
    'The system architecture uses a standard three-tier pattern with a presentation layer, ' +
    'business logic layer, and data access layer. Each tier communicates through well-defined interfaces.\n\n' +
    'However the caching layer is critically important for maintaining acceptable response times ' +
    'under peak load. Without proper cache invalidation, stale data propagates to all downstream consumers.\n\n' +
    'The deployment pipeline runs automated tests before promoting builds to production. Each stage ' +
    'includes smoke tests and canary analysis to catch regressions early.';

  const messages = [msg('user', prose)];
  const r = compressMessages(messages, { recencyWindow: 0 });
  const content = r.messages[0].content ?? '';
  const compressed = r.compression.messages_compressed > 0;
  const capturesEmphasis = content.includes('caching') || content.includes('cache');
  return {
    pass: compressed && capturesEmphasis,
    detail: `compressed=${compressed}, capturesCache=${capturesEmphasis}, summary=${content.slice(0, 120)}...`,
  };
});

// ---------------------------------------------------------------------------
// E: round-trip on compressed tool messages
// ---------------------------------------------------------------------------

test('E1: compress → expand round-trip on mixed tool conversation', () => {
  nextId = 1000;
  const toolProse =
    'The authentication service handles all user identity verification across the platform. ' +
    'When a request arrives, the service first checks the session store for an active session, ' +
    'then validates the token signature against the current signing key. If the token has expired ' +
    'but falls within the renewal window, the service automatically issues a fresh token pair. ' +
    'The service maintains a blocklist of revoked tokens in memory, synchronized across instances ' +
    'through a pub-sub channel. Failed authentication attempts are tracked per account.';

  const input = [
    msg('system', 'You are a coding assistant.'),
    msg('user', 'Read the auth docs'),
    msg('assistant', 'Let me read those files.', {
      tool_calls: [{ id: 'tc1', function: { name: 'read', arguments: '{}' } }],
    }),
    msg('tool', toolProse),
    msg('assistant', 'Here is what I found.', {
      tool_calls: [{ id: 'tc2', function: { name: 'read', arguments: '{}' } }],
    }),
    msg('tool', 'SELECT id, email FROM users WHERE active = true ORDER BY created_at'),
    msg('user', 'Thanks'),
    msg('assistant', 'Happy to help!'),
  ];

  const cr = compressMessages(input, { recencyWindow: 0 });
  const er = expandMessages(cr.messages, cr.verbatim);

  const roundTrip = JSON.stringify(er.messages) === JSON.stringify(input);
  const noMissing = er.missing_ids.length === 0;
  const proseCompressed = cr.compression.messages_compressed > 0;

  return {
    pass: roundTrip && noMissing && proseCompressed,
    detail: `roundTrip=${roundTrip}, missing=${er.missing_ids}, compressed=${cr.compression.messages_compressed}, preserved=${cr.compression.messages_preserved}`,
  };
});

// ---------------------------------------------------------------------------
// F: tightened structural detectors
// ---------------------------------------------------------------------------

test('F1: "Note: this is important" — no yaml_structure', () => {
  const r = classifyMessage('Note: this is an important reminder about the upcoming sprint deadline.');
  return { pass: !r.reasons.includes('yaml_structure'), detail: `reasons: ${r.reasons}` };
});

test('F2: "Error: something broke" — no yaml_structure', () => {
  const r = classifyMessage('Error: the build failed because of a missing dependency in the pipeline.');
  return { pass: !r.reasons.includes('yaml_structure'), detail: `reasons: ${r.reasons}` };
});

test('F3: real YAML still detected (multi-line)', () => {
  const r = classifyMessage('name: my-service\nversion: 1.0\nport: 8080');
  return { pass: r.reasons.includes('yaml_structure'), detail: `reasons: ${r.reasons}` };
});

test('F4: "[Action required]" prose — no json_structure', () => {
  const r = classifyMessage('[Action required] Please update your local environment variables before deploying.');
  return { pass: !r.reasons.includes('json_structure'), detail: `reasons: ${r.reasons}` };
});

test('F5: real JSON still detected', () => {
  const r = classifyMessage('{"key": "value", "count": 42}');
  return { pass: r.reasons.includes('json_structure'), detail: `reasons: ${r.reasons}` };
});

test('F6: JSON array still detected', () => {
  const r = classifyMessage('["alpha", "beta", "gamma"]');
  return { pass: r.reasons.includes('json_structure'), detail: `reasons: ${r.reasons}` };
});

test('F7: "must" in tech prose — no legal_term', () => {
  const r = classifyMessage('The server must respond within 200ms for all health check endpoints under normal load.');
  return { pass: !r.reasons.includes('legal_term'), detail: `reasons: ${r.reasons}` };
});

test('F8: "shall" in legal text — still triggers legal_term', () => {
  const r = classifyMessage('The licensee shall not redistribute the software without written consent.');
  return { pass: r.reasons.includes('legal_term'), detail: `reasons: ${r.reasons}` };
});

test('F9: single indented line — no indented_code', () => {
  const r = classifyMessage('As discussed:\n    Thank you for your patience during the migration process.');
  return { pass: !r.reasons.includes('indented_code'), detail: `reasons: ${r.reasons}` };
});

test('F10: two consecutive indented lines — still triggers indented_code', () => {
  const r = classifyMessage('Here is code:\n    const x = 1;\n    return x;');
  return { pass: r.reasons.includes('indented_code'), detail: `reasons: ${r.reasons}` };
});

test('F11: two capitalized lines — no verse_pattern (need 3)', () => {
  const r = classifyMessage('Here is a list\nDashboard Module\nAuthentication Flow\n');
  return { pass: !r.reasons.includes('verse_pattern'), detail: `reasons: ${r.reasons}` };
});

test('F12: three capitalized lines — triggers verse_pattern', () => {
  const r = classifyMessage('Here is a poem\nRoses are red\nViolets are blue\nSugar is sweet');
  return { pass: r.reasons.includes('verse_pattern'), detail: `reasons: ${r.reasons}` };
});

// ---------------------------------------------------------------------------
// G: regression — all provider-specific keys still work
// ---------------------------------------------------------------------------

test('G1: OpenAI key', () => {
  const r = classifyMessage('sk-abc123def456ghi789jkl012mno345pqr');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('G2: AWS key', () => {
  const r = classifyMessage('AKIAIOSFODNN7EXAMPLE');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('G3: GitHub PAT', () => {
  const r = classifyMessage('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('G4: Stripe key', () => {
  const r = classifyMessage('sk_live_ABCDEFGHIJKLMNOPQRSTUVWx');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

test('G5: Slack token', () => {
  const r = classifyMessage('xoxb-123456789012-abcdefghij1234567890');
  return { pass: r.reasons.includes('api_key'), detail: `reasons: ${r.reasons}` };
});

// ---------------------------------------------------------------------------
// Print results
// ---------------------------------------------------------------------------

const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;

console.log();
console.log('Real-World Stress Tests');
console.log('='.repeat(90));

for (const r of results) {
  const icon = r.pass ? 'PASS' : 'FAIL';
  const line = `  ${icon}  ${r.name}`;
  console.log(line);
  if (!r.pass) {
    console.log(`        ${r.detail}`);
  }
}

console.log('='.repeat(90));
console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);
console.log();

if (failed > 0) {
  process.exit(1);
}
