// =============================================================================
// resolve-client.test — local by default (real client), remote when --remote
// or when config sets mode:'remote'. The resolver reads creds from the injected
// env/config, so the choice is testable without real HTTP. Local clients are
// proven by a create round-trip; remote clients are proven by a real HTTP
// attempt against an unreachable host (no local fallback).
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { resolveClient } from './resolve-client';
import { tempDbUrl, cleanupTempDbs } from './testing/temp-db';

after(cleanupTempDbs);

// -- local path ---------------------------------------------------------------

describe('resolveClient', () => {
    // default → a working LocalContextClient (create round-trips, no server)
    it('returns a working local client by default', async () => {
        const client = await resolveClient({ dbUrl: tempDbUrl(), cwd: '/unused', env: {}, config: {} });

        const created = await client.create({});
        const appended = await client.append({ id: created.id, messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(appended.data.length, 1);
    });

    // -- remote path ----------------------------------------------------------

    // --remote with creds → a remote client (create hits the network, no local store)
    it('returns a remote client when --remote with creds', async () => {
        const client = await resolveClient({
            remote: true,
            env: { UC_API_KEY: 'sk_test', UC_API_URL: 'https://api.invalid.example' },
        });

        // a remote create attempts a real request to the unreachable host
        await assert.rejects(() => client.create({}));
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
            cwd: '/unused',
            config: { baseUrl: 'https://api.example.com', apiKey: 'sk_cfg' },
        });

        const created = await client.create({});
        const appended = await client.append({ id: created.id, messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(appended.data.length, 1);
    });

    // explicit config mode:'remote' opts into the hosted backend by default
    it('chooses remote when config sets mode:remote', async () => {
        const client = await resolveClient({
            config: { mode: 'remote', baseUrl: 'https://api.invalid.example', apiKey: 'sk_cfg' },
        });

        await assert.rejects(() => client.create({}));
    });

    // config baseUrl alone (no token) → falls back to local
    it('falls back to local when config has a baseUrl but no token', async () => {
        const client = await resolveClient({
            dbUrl: tempDbUrl(),
            cwd: '/unused',
            config: { baseUrl: 'https://api.example.com' },
        });

        const created = await client.create({});
        const appended = await client.append({ id: created.id, messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(appended.data.length, 1);
    });
});
