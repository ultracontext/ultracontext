// =============================================================================
// resolve-client.test — local by default (real client), remote when --remote
// or when config carries a baseUrl + token. The resolver reads creds from the
// injected env/config, so the choice is testable without real HTTP.
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
        const client = await resolveClient({ dbUrl: tempDbUrl(), cwd: '/work/resolve-local', env: {}, config: {} });

        const added = await client.add({ messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(added.data.length, 1);
    });

    // -- remote path ----------------------------------------------------------

    // --remote with creds → a remote client (get requires an id, proving it's not local)
    it('returns a remote client when --remote with creds', async () => {
        const client = await resolveClient({
            remote: true,
            env: { UC_API_KEY: 'sk_test' },
        });

        // the remote client rejects an id-less get (local would resolve a default)
        await assert.rejects(() => client.get({}), /context id/i);
    });

    // --remote without any credential → a clear, actionable error.
    // inject config:{} so it never reads the dev's real ~/.ultracontext (which
    // may carry an apiKey) — keeps the assertion deterministic on any machine.
    it('throws a clear error when --remote without an api key', async () => {
        await assert.rejects(
            () => resolveClient({ remote: true, env: {}, config: {} }),
            /api key/i,
        );
    });

    // LOCAL-FIRST: stale creds in config must NOT auto-flip to remote
    it('stays local by default even when config carries creds', async () => {
        const client = await resolveClient({
            dbUrl: tempDbUrl(),
            cwd: '/work/resolve-local-creds',
            config: { baseUrl: 'https://api.example.com', apiKey: 'sk_cfg' },
        });

        const added = await client.add({ messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(added.data.length, 1);
    });

    // explicit config mode:'remote' opts into the hosted backend by default
    it('chooses remote when config sets mode:remote', async () => {
        const client = await resolveClient({
            config: { mode: 'remote', baseUrl: 'https://api.example.com', apiKey: 'sk_cfg' },
        });

        await assert.rejects(() => client.get({}), /context id/i);
    });

    // config baseUrl alone (no token) → falls back to local
    it('falls back to local when config has a baseUrl but no token', async () => {
        const client = await resolveClient({
            dbUrl: tempDbUrl(),
            cwd: '/work/resolve-cfg-notoken',
            config: { baseUrl: 'https://api.example.com' },
        });

        const added = await client.add({ messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(added.data.length, 1);
    });
});
