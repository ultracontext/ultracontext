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

    it('detects SQL SELECT...FROM', () => {
      const r = classifyMessage('SELECT id, name FROM users WHERE active = 1');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_query');
    });

    it('detects SQL CREATE TABLE', () => {
      const r = classifyMessage('CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(255))');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_query');
    });

    it('detects multiline SQL JOIN', () => {
      const r = classifyMessage(
        'SELECT u.id, o.total\nFROM users u\nJOIN orders o ON u.id = o.user_id\nWHERE o.total > 100'
      );
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_query');
    });

    it('detects SQL INSERT INTO', () => {
      const r = classifyMessage("INSERT INTO logs (level, message) VALUES ('error', 'timeout')");
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_query');
    });

    it('detects SQL UPDATE...SET', () => {
      const r = classifyMessage("UPDATE users SET active = 0 WHERE last_login < '2024-01-01'");
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('sql_query');
    });

    it('does not false-positive on prose "select...from"', () => {
      const r = classifyMessage('Please select your option from the dropdown menu on the left side of the screen.');
      expect(r.reasons).not.toContain('sql_query');
    });

    it('detects API keys', () => {
      const r = classifyMessage('Token: sk-abc123def456ghi789jkl012mno345pqr');
      expect(r.decision).toBe('T0');
      expect(r.reasons).toContain('api_key');
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
