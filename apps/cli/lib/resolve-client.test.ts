// =============================================================================
// resolve-client.test — local by default (real client), remote when asked.
// Remote isn't built yet, so it must throw a clear not-implemented error.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { resolveClient } from './resolve-client';
import { tempDbUrl, cleanupTempDbs } from './testing/temp-db';

after(cleanupTempDbs);

// -- local path ---------------------------------------------------------------

describe('resolveClient', () => {
    // default → a working LocalContextClient (add round-trips, no server)
    it('returns a working local client by default', async () => {
        const client = await resolveClient({ dbUrl: tempDbUrl(), cwd: '/work/resolve-local' });

        const added = await client.add({ messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(added.data.length, 1);
    });

    // --remote → the remote client (stubbed: every verb throws not-implemented)
    it('throws not-implemented for the remote client', async () => {
        const client = await resolveClient({ remote: true, dbUrl: tempDbUrl(), cwd: '/work/resolve-remote' });
        await assert.rejects(() => client.list({}), /not implemented/i);
    });
});
