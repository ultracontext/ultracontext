// =============================================================================
// kv.test — the repeated `--count k=v` / `--label k=v` flag parsers. counts are
// string→int (a non-integer value is a clear error); labels are string→string.
// Both reject a missing `=` separator with a clear message naming the flag.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCounts, parseLabels } from './kv';

// -- counts -------------------------------------------------------------------

describe('parseCounts', () => {
    // collapses repeated k=v pairs into a string→int map
    it('parses integer pairs', () => {
        assert.deepEqual(parseCounts(['listed=10', 'changed=1']), { listed: 10, changed: 1 });
    });

    // undefined (flag never given) → undefined (no counts on the envelope)
    it('returns undefined for no pairs', () => {
        assert.equal(parseCounts(undefined), undefined);
    });

    // a non-integer value throws a clear, flag-named error
    it('throws on a non-integer value', () => {
        assert.throws(() => parseCounts(['x=abc']), /--count.*integer/);
    });

    // a missing `=` separator throws a clear, flag-named error
    it('throws on a missing separator', () => {
        assert.throws(() => parseCounts(['oops']), /--count.*key=value/);
    });
});

// -- labels -------------------------------------------------------------------

describe('parseLabels', () => {
    // collapses repeated k=v pairs into a string→string map
    it('parses string pairs', () => {
        assert.deepEqual(parseLabels(['app=claude', 'platform=ios']), { app: 'claude', platform: 'ios' });
    });

    // a value containing `=` keeps everything after the first `=`
    it('keeps everything after the first =', () => {
        assert.deepEqual(parseLabels(['url=a=b']), { url: 'a=b' });
    });

    // a missing `=` separator throws a clear, flag-named error
    it('throws on a missing separator', () => {
        assert.throws(() => parseLabels(['nope']), /--label.*key=value/);
    });
});
