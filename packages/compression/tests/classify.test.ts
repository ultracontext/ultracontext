import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../src/classify.js';

describe('classifyMessage', () => {
  describe('T0 — verbatim required', () => {
    it('detects code fences', () => {
      const r = classifyMessage('```typescript\nconst x = 1\n```');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('code_fence');
    });

    it('detects indented code', () => {
      const r = classifyMessage('Here is code:\n    const x = 1;\n    return x;');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('indented_code');
    });

    it('detects LaTeX math', () => {
      const r = classifyMessage('The formula is $E = mc^2$ exactly');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('latex_math');
    });

    it('detects URLs', () => {
      const r = classifyMessage('See https://example.com/api/v2/endpoint');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('url');
    });

    it('detects SQL SELECT...FROM (keyword density)', () => {
      const r = classifyMessage('SELECT id, name FROM users WHERE active = 1');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects SQL CREATE TABLE', () => {
      const r = classifyMessage('CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(255))');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects multiline SQL JOIN', () => {
      const r = classifyMessage(
        'SELECT u.id, o.total\nFROM users u\nJOIN orders o ON u.id = o.user_id\nWHERE o.total > 100'
      );
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects SQL INSERT INTO', () => {
      const r = classifyMessage("INSERT INTO logs (level, message) VALUES ('error', 'timeout')");
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects SQL UPDATE...WHERE', () => {
      const r = classifyMessage("UPDATE users SET active = 0 WHERE last_login < '2024-01-01'");
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects CTE (WITH RECURSIVE)', () => {
      const r = classifyMessage('WITH RECURSIVE cte AS (SELECT 1 UNION SELECT n+1 FROM cte WHERE n < 10) SELECT * FROM cte');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects TRUNCATE + CASCADE', () => {
      const r = classifyMessage('TRUNCATE TABLE sessions CASCADE');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects GRANT/REVOKE', () => {
      const r = classifyMessage('GRANT SELECT, INSERT ON users TO readonly_role; REVOKE DELETE ON users FROM guest_role');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_content');
    });

    it('does not false-positive on single SQL keyword in prose', () => {
      const r = classifyMessage('Please select your option from the dropdown menu on the left side of the screen.');
      expect(r.reasons).not.toContain('sql_content');
    });

    it('does not false-positive on prose with "update" and non-SQL context', () => {
      const r = classifyMessage('We need to update the documentation and delete the old drafts from the shared drive.');
      expect(r.reasons).not.toContain('sql_content');
    });

    it('detects OpenAI API keys', () => {
      const r = classifyMessage('Token: sk-abc123def456ghi789jkl012mno345pqr');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects API keys with hyphens (sk-proj-*)', () => {
      const r = classifyMessage('Key: sk-proj-abc123def456ghi789jkl012mno345pqr');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects AWS access key IDs', () => {
      const r = classifyMessage('AWS key: AKIAIOSFODNN7EXAMPLE');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects GitHub PAT classic (ghp_*)', () => {
      const r = classifyMessage('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects GitHub fine-grained PAT', () => {
      const r = classifyMessage('Token: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects Stripe keys', () => {
      const r = classifyMessage('Stripe: sk_live_ABCDEFGHIJKLMNOPQRSTUVWx');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects Slack bot tokens (xoxb)', () => {
      const r = classifyMessage('Bot token: xoxb-123456789012-abcdefghij1234567890');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects Slack user tokens (xoxp)', () => {
      const r = classifyMessage('User token: xoxp-123456789012-abcdefghij1234567890');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects Slack app tokens (xoxa)', () => {
      const r = classifyMessage('App token: xoxa-2-123456789012-abcdefghij1234567890');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects Slack refresh tokens (xoxr)', () => {
      const r = classifyMessage('Refresh: xoxr-123456789012-abcdefghij1234567890');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects SendGrid keys', () => {
      const r = classifyMessage('SG.abcdefghijklmnopqrstuv.wxyz0123456789abcdefghijklmno');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects GitLab PAT', () => {
      const r = classifyMessage('Token: glpat-abc123def456ghi789jkl0');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects npm tokens', () => {
      const r = classifyMessage('Token: npm_abcdefghijklmnopqrstuvwxyz0123456789AB');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects Google API keys', () => {
      const r = classifyMessage('Key: AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('detects unknown provider keys via generic entropy fallback', () => {
      // Looks like prefix + separator + mixed alphanumeric body
      const r = classifyMessage('Token: myservice-a8Kj2mNp4qRs6tUv8wXy0zBc3dEfGh');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
    });

    it('does not false-positive on normal identifiers', () => {
      const r = classifyMessage('The component uses my-very-long-css-class-name-here');
      expect(r.reasons).not.toContain('api_key');
    });

    it('detects git SHAs', () => {
      const r = classifyMessage('commit a3f9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('hash_or_sha');
    });

    it('detects legal language', () => {
      const r = classifyMessage('The party shall not disclose any information');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('legal_term');
    });

    it('detects file paths', () => {
      const r = classifyMessage('Located at /usr/local/bin/ancs/config.json');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('file_path');
    });

    it('detects version numbers', () => {
      const r = classifyMessage('Requires version 3.14.1 or higher');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('version_number');
    });

    it('detects email addresses', () => {
      const r = classifyMessage('Contact support@example.com for help');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('email');
    });

    it('detects phone numbers', () => {
      const r = classifyMessage('Call us at 555-123-4567 for details');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('phone');
    });

    it('detects direct quotes', () => {
      const r = classifyMessage('He said \u201cThis is a very important statement about policy\u201d to the committee');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('direct_quote');
    });

    it('detects numeric with units', () => {
      const r = classifyMessage('The speed was 3.14 GHz under load');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('numeric_with_units');
    });

    it('detects inline code density / special chars', () => {
      const r = classifyMessage('{{{}}}[][]<><>||\\\\;;::@@##$$%%^^&&**()()=+=+``~~');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('high_special_char_ratio');
    });

    it('detects JSON content', () => {
      const r = classifyMessage('{"key": "value", "count": 42}');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('json_structure');
    });

    it('detects YAML content', () => {
      const r = classifyMessage('name: my-service\nversion: 1.0\nport: 8080');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('yaml_structure');
    });

    it('has high confidence for clear T0 content', () => {
      const r = classifyMessage('```python\nprint("hello")\n```');
      expect(r.confidence).toBeGreaterThan(0.7);
    });

    it('increases confidence with more reasons', () => {
      // Code fence + file path + url = multiple reasons
      const r = classifyMessage('```bash\ncurl https://example.com/api/v2/data\n```');
      expect(r.confidence).toBeGreaterThan(0.75);
    });

    it('detects unicode math symbols', () => {
      const r = classifyMessage('The set is defined as A ∪ B ∩ C where ∀x ∈ A');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('unicode_math');
    });

    it('detects verse / poetry patterns', () => {
      const r = classifyMessage('Here is a poem\nRoses are red\nViolets are blue\nSugar is sweet');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('verse_pattern');
    });

    it('detects high line-length variance', () => {
      const r = classifyMessage(
        'x\nThis is a much longer line that creates significant variance compared to the short ones around it\ny\nz'
      );
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('high_line_length_variance');
    });

    it('detects IP addresses via ip_or_semver', () => {
      const r = classifyMessage('The server is at 192.168.1.1 on the local network');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('ip_or_semver');
    });

    it('detects quoted keys', () => {
      const r = classifyMessage('The config has "timeout": 30 and "retries": 5');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('quoted_key');
    });

    it('caps confidence at 0.95', () => {
      // Lots of signals stacked
      const r = classifyMessage(
        '```python\nimport os\npath = "/usr/local/bin"\nurl = "https://example.com"\nemail = "a@b.com"\nversion = "v1.2.3"\n```'
      );
      expect(r.confidence).toBeLessThanOrEqual(0.95);
    });
  });

  describe('false-positive resistance', () => {
    it('prose mentioning "from" and "select" in non-SQL context stays T3', () => {
      const r = classifyMessage(
        'You can select any option from the settings panel. The team will update the config and create a new deployment pipeline for the staging environment.'
      );
      expect(r.reasons).not.toContain('sql_content');
    });

    it('prose with "delete from" in conversational context stays non-SQL', () => {
      const r = classifyMessage('I need to delete the old images from my camera roll and update my storage plan.');
      expect(r.reasons).not.toContain('sql_content');
    });

    it('prose with "where" and "values" in English does not trigger sql_content', () => {
      const r = classifyMessage(
        'The system processes entries where defaults are established. Users should adjust these values to match their specific requirements.'
      );
      expect(r.reasons).not.toContain('sql_content');
    });

    it('prose with "schema" in tech context does not trigger sql_content', () => {
      const r = classifyMessage(
        'When moving from the old schema to the new architecture, teams should carefully plan the migration path.'
      );
      expect(r.reasons).not.toContain('sql_content');
    });

    it('CSS hex color does not trigger hash_or_sha', () => {
      // #ff00ff is only 6 hex chars, well below the 40-char minimum
      const r = classifyMessage('Set the background to #ff00ff and the text to #333333 for the header component.');
      expect(r.reasons).not.toContain('hash_or_sha');
    });

    it('short alphanumeric slug does not trigger api_key', () => {
      const r = classifyMessage('The package is published as my-cool-lib on npm.');
      expect(r.reasons).not.toContain('api_key');
    });

    it('UUID does not trigger api_key', () => {
      const r = classifyMessage('The session ID is 550e8400-e29b-41d4-a716-446655440000.');
      expect(r.reasons).not.toContain('api_key');
    });

    it('kebab-case CSS class does not trigger api_key', () => {
      const r = classifyMessage('Add the class btn-primary-large-disabled-outline to the button.');
      expect(r.reasons).not.toContain('api_key');
    });

    it('verbose CSS BEM class does not trigger api_key', () => {
      const r = classifyMessage('Apply the class billing-dashboard-wrapper-outer-container-v2 to the root element.');
      expect(r.reasons).not.toContain('api_key');
    });

    it('npm scope-like name does not trigger api_key', () => {
      const r = classifyMessage('Install the package my-org-internal-service-name-production from the registry.');
      expect(r.reasons).not.toContain('api_key');
    });

    it('"version 2" in prose does not trigger version_number for surrounding text', () => {
      // version_number should fire, but the whole message should still be T0 — this tests
      // that the pattern is scoped and does not cause unexpected side effects
      const r = classifyMessage('We shipped version 2 last week and it went smoothly.');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('version_number');
      expect(r.reasons).not.toContain('sql_content');
    });

    it('numeric_with_units does not fire on bare numbers without units', () => {
      const r = classifyMessage('There are 5000 items in the queue and 12 workers available.');
      expect(r.reasons).not.toContain('numeric_with_units');
    });

    it('"must" in normal tech prose does not trigger legal_term', () => {
      const r = classifyMessage('The API must return a 200 status code for valid requests.');
      expect(r.reasons).not.toContain('legal_term');
    });

    it('single "key: value" line does not trigger yaml_structure', () => {
      const r = classifyMessage('Note: this is an important reminder about the upcoming deadline.');
      expect(r.reasons).not.toContain('yaml_structure');
    });

    it('prose starting with "[" does not trigger json_structure', () => {
      const r = classifyMessage('[Note: please review the attached document before the meeting tomorrow.]');
      expect(r.reasons).not.toContain('json_structure');
    });
  });

  describe('real-world variations', () => {
    it('detects API key embedded in a JSON config', () => {
      const r = classifyMessage('{"apiKey": "sk-proj-abc123def456ghi789jkl012mno345pqr", "model": "gpt-4"}');
      expect(r.reasons).toContain('api_key');
    });

    it('detects API key pasted with surrounding quotes', () => {
      const r = classifyMessage("Set OPENAI_API_KEY='sk-ant-api03-abc123def456ghi789jkl' in your .env file.");
      expect(r.reasons).toContain('api_key');
    });

    it('detects API key in a multi-line env block', () => {
      const r = classifyMessage(
        'DATABASE_URL=postgres://localhost/mydb\nSTRIPE_KEY=sk_test_4eC39HqLyjWDarjtT1zdp7dc0123456789\nPORT=3000'
      );
      expect(r.reasons).toContain('api_key');
    });

    it('detects SQL in an error message', () => {
      const r = classifyMessage(
        'ERROR: relation "users" does not exist at character 15\n' +
        'STATEMENT: SELECT id, email FROM users WHERE active = true ORDER BY created_at DESC LIMIT 10'
      );
      expect(r.reasons).toContain('sql_content');
    });

    it('detects SQL embedded in ORM debug output', () => {
      const r = classifyMessage(
        '[2024-03-15 10:23:45] DEBUG: Executing query: INSERT INTO audit_log (user_id, action, timestamp) VALUES ($1, $2, NOW()) RETURNING id'
      );
      expect(r.reasons).toContain('sql_content');
    });

    it('detects lowercase SQL (common in ORM output)', () => {
      const r = classifyMessage('select u.id, u.name from users u inner join orders o on u.id = o.user_id where o.total > 100');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects mixed-case SQL', () => {
      const r = classifyMessage('Select Count(*) From users Where active = true Group By role');
      expect(r.reasons).toContain('sql_content');
    });

    it('detects EXPLAIN ANALYZE output', () => {
      const r = classifyMessage(
        'EXPLAIN ANALYZE SELECT * FROM orders WHERE created_at > NOW() - INTERVAL \'7 days\' ORDER BY total DESC LIMIT 50'
      );
      expect(r.reasons).toContain('sql_content');
    });

    it('detects schema migration SQL', () => {
      const r = classifyMessage(
        'ALTER TABLE users ADD COLUMN last_login TIMESTAMP NOT NULL DEFAULT NOW();\n' +
        'CREATE INDEX idx_users_last_login ON users (last_login);'
      );
      expect(r.reasons).toContain('sql_content');
    });

    it('detects Anthropic sk-ant-* key format', () => {
      const r = classifyMessage('Use sk-ant-api03-abc123def456ghi789jkl012mno345pqr for auth.');
      expect(r.reasons).toContain('api_key');
    });

    it('detects key with underscores (Supabase-style)', () => {
      const r = classifyMessage('Token: sbp_a8b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(r.reasons).toContain('api_key');
    });
  });

  describe('cross-pattern and multi-signal', () => {
    it('SQL inside a code fence triggers both code_fence and sql_content', () => {
      const r = classifyMessage('```sql\nSELECT * FROM users WHERE active = true ORDER BY name\n```');
      expect(r.reasons).toContain('code_fence');
      expect(r.reasons).toContain('sql_content');
    });

    it('API key + URL in the same message triggers both', () => {
      const r = classifyMessage('curl -H "Authorization: Bearer sk-proj-abc123def456ghi789jkl012mno345pqr" https://api.openai.com/v1/chat');
      expect(r.reasons).toContain('api_key');
      expect(r.reasons).toContain('url');
    });

    it('long prose with a single URL is still T0 (URL preserves it)', () => {
      const prose = 'The system handles request routing and load balancing across multiple regions. '.repeat(5);
      const r = classifyMessage(prose + ' See https://docs.example.com/architecture for details.');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('url');
    });

    it('message with SQL + file paths + version triggers all three', () => {
      const r = classifyMessage(
        'Running migration v2.3.1 from /db/migrations/003.sql:\n' +
        'ALTER TABLE sessions ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) CASCADE'
      );
      expect(r.reasons).toContain('sql_content');
      expect(r.reasons).toContain('file_path');
      expect(r.reasons).toContain('version_number');
    });

    it('confidence scales with number of distinct signals', () => {
      // Single signal
      const r1 = classifyMessage('Check https://example.com for updates');
      // Multiple signals
      const r2 = classifyMessage(
        'Check https://example.com, contact admin@example.com, version v3.2.1'
      );
      expect(r2.confidence).toBeGreaterThan(r1.confidence);
    });
  });

  describe('T2 — short factual assertions', () => {
    it('classifies short factual text as T2', () => {
      const r = classifyMessage('The service uses PostgreSQL.');
      expect(r.decision).toBe('T2');
    });

    it('classifies very short text as T2', () => {
      const r = classifyMessage('OK, done.');
      expect(r.decision).toBe('T2');
    });

    it('classifies 19-word prose as T2 (boundary)', () => {
      // Exactly 19 words — below the 20-word T3 threshold
      const r = classifyMessage(
        'The quick brown fox jumps over the lazy dog near the old oak tree by the river bank today'
      );
      expect(r.decision).toBe('T2');
    });

    it('classifies empty string as T2', () => {
      const r = classifyMessage('');
      expect(r.decision).toBe('T2');
      expect(r.reasons).toEqual([]);
    });
  });

  describe('T3 — compressible prose', () => {
    it('classifies clean prose as T3', () => {
      const r = classifyMessage(
        'The system processes incoming requests and routes them to the appropriate handler. ' +
        'Each request is validated before processing begins. Errors are logged centrally.'
      );
      expect(r.decision).toBe('T3');
    });

    it('has lower confidence for non-T0 content', () => {
      const r = classifyMessage(
        'This is simple informational text about a process that handles various operations in the system and continues with more detail about the workflow.'
      );
      expect(r.decision).toBe('T3');
      expect(r.confidence).toBeLessThan(0.75);
    });

    it('classifies medium-length prose as T3', () => {
      const r = classifyMessage(
        'When designing a microservice architecture, it is important to consider the boundaries between services. ' +
        'Each service should own its data and expose well-defined APIs.'
      );
      expect(r.decision).toBe('T3');
    });

    it('classifies 20-word prose as T3 (boundary)', () => {
      // Exactly 20 words — at the T3 threshold
      const r = classifyMessage(
        'The quick brown fox jumps over the lazy dog near the old oak tree by the river bank today again'
      );
      expect(r.decision).toBe('T3');
    });
  });

  describe('performance', () => {
    it('completes in under 5ms', () => {
      const start = performance.now();
      classifyMessage('A reasonably sized paragraph of text content here. It talks about various things.');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5);
    });

    it('handles 1000 calls under 500ms', () => {
      const input = 'A reasonably sized paragraph of text content here. It talks about various things and keeps going for a while.';
      const start = performance.now();
      for (let i = 0; i < 1000; i++) classifyMessage(input);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });
});
