import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isoTimestamp } from './iso-timestamp';

describe('isoTimestamp', () => {
    // Date objects normalize via toISOString()
    it('converts a Date object to ISO-8601 UTC', () => {
        const d = new Date('2026-06-03T18:15:56.673Z');
        assert.equal(isoTimestamp(d), '2026-06-03T18:15:56.673Z');
    });

    // ISO strings pass through unchanged (idempotent)
    it('passes an already-ISO string through unchanged', () => {
        const iso = '2026-06-03T16:09:07.367Z';
        assert.equal(isoTimestamp(iso), iso);
    });

    // ISO with second precision is normalized to millisecond precision + Z
    it('normalizes a second-precision ISO string to ms precision', () => {
        assert.equal(isoTimestamp('2026-06-03T16:09:07Z'), '2026-06-03T16:09:07.000Z');
    });

    // ISO carrying an explicit offset is converted to UTC
    it('converts an ISO string with offset to UTC', () => {
        assert.equal(isoTimestamp('2026-06-03T13:09:07.000-03:00'), '2026-06-03T16:09:07.000Z');
    });

    // Postgres-style with microsecond fraction and +00 → ISO UTC (ms precision)
    it('parses a Postgres-style string with fraction and +00', () => {
        assert.equal(isoTimestamp('2026-06-03 18:15:56.673625+00'), '2026-06-03T18:15:56.673Z');
    });

    // Postgres-style without fraction and +00 → ISO UTC
    it('parses a Postgres-style string without fraction and +00', () => {
        assert.equal(isoTimestamp('2026-06-03 18:15:56+00'), '2026-06-03T18:15:56.000Z');
    });

    // Postgres-style with +HH:MM offset → ISO UTC
    it('parses a Postgres-style string with +HH:MM offset', () => {
        assert.equal(isoTimestamp('2026-06-03 15:15:56.500000-03:00'), '2026-06-03T18:15:56.500Z');
    });

    // Postgres-style with +HH (hour-only) offset → ISO UTC
    it('parses a Postgres-style string with hour-only offset', () => {
        assert.equal(isoTimestamp('2026-06-03 20:15:56.000000+02'), '2026-06-03T18:15:56.000Z');
    });

    // Idempotent: feeding the function its own output yields the same value
    it('is idempotent on Postgres-style input', () => {
        const once = isoTimestamp('2026-06-03 18:15:56.673625+00');
        assert.equal(isoTimestamp(once), once);
    });

    // Garbage that cannot be parsed is returned verbatim (never throws)
    it('returns unparseable garbage unchanged', () => {
        assert.equal(isoTimestamp('not-a-timestamp'), 'not-a-timestamp');
        assert.equal(isoTimestamp(''), '');
    });
});
