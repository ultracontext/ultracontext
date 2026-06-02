// =============================================================================
// version.test — RED. The CLI version is the single source of truth read from
// the package's own package.json (so doctor/upgrade/main never drift). We test
// the resolver against an injected reader so no real filesystem is touched.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveVersion } from './version';

// -- resolver -----------------------------------------------------------------

describe('resolveVersion', () => {
    // reads the version field out of the injected package.json text
    it('returns the version from package.json', () => {
        const read = () => JSON.stringify({ name: 'ultracontext', version: '2.3.4' });
        assert.equal(resolveVersion(read), '2.3.4');
    });

    // a missing/unreadable package.json degrades to a stable unknown marker
    it('returns 0.0.0 when the version cannot be read', () => {
        const read = () => { throw new Error('nope'); };
        assert.equal(resolveVersion(read), '0.0.0');
    });
});
