// =============================================================================
// resolve-client.test — local by default (real client), remote when --remote
// or when config sets mode:'remote'. The resolver reads creds from the injected
// env/config, so the choice is testable without real HTTP. Local clients are
// proven by a create round-trip; remote clients are proven by a real HTTP
// attempt against an unreachable host (no local fallback). The unified-remote
// path is proven END TO END against an in-process `uc serve` — the SAME remote
// path the hosted cloud takes, so serve + cloud are interchangeable.
// =============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClient } from './resolve-client';
import { writeRemote } from './remote';
import { startServer, type ServeHandle } from './serve/server';
import { tempDbUrl, cleanupTempDbs } from './testing/temp-db';

// temp config dirs for the persisted-remote read path
const cfgDirs: string[] = [];
async function tempCfgDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-resolve-'));
    cfgDirs.push(dir);
    return dir;
}

after(cleanupTempDbs);
after(async () => {
    for (const dir of cfgDirs) await rm(dir, { recursive: true, force: true });
});

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

    // --remote reads the API side of the unified remote written by `uc remote
    // set` — proves the persisted config.json {baseUrl, apiKey} feed the resolver
    it('picks the api side of the persisted unified remote under --remote', async () => {
        const dir = await tempCfgDir();
        await writeRemote({ api: { baseUrl: 'https://api.invalid.example', apiKey: 'sk_persisted' } }, dir);

        // env empty so only the persisted unified remote supplies the creds
        const client = await resolveClient({ remote: true, env: {}, configDir: dir });
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

// -- contexts over a SELF-HOST `uc serve` (api coord = serve url + key) --------

describe('resolveClient → in-process uc serve (self-host == cloud)', () => {
    // an in-process serve the remote client talks HTTP to (the api coord target)
    let server: ServeHandle;
    let dir: string;

    before(async () => {
        // boot serve on an ephemeral port over a fresh temp db
        server = await startServer({ port: 0, host: '127.0.0.1', dbUrl: tempDbUrl(), configDir: await tempCfgDir() });

        // persist the serve url+key as the unified remote's api coord — EXACTLY
        // what `uc remote set <t> --api <serve-url> --key <serve-key>` writes
        dir = await tempCfgDir();
        await writeRemote({ api: { baseUrl: server.url, apiKey: server.key! } }, dir);
    });
    after(async () => { await server.close(); });

    // the SAME remote path the hosted cloud takes: --remote builds the @ultracontext/js
    // SDK from the persisted api coord and create/get round-trip over real HTTP.
    it('create + append + get round-trip through the CLI remote path', async () => {
        // env empty so only the persisted api coord supplies the creds
        const client = await resolveClient({ remote: true, env: {}, configDir: dir });

        // create a context on the serve, append a message, read it back over HTTP
        const created = await client.create({ metadata: { source: 'serve-rt' } });
        assert.ok(created.id.length > 0);

        const appended = await client.append({ id: created.id, messages: [{ role: 'user', content: 'over-http' }] });
        assert.equal(appended.data.length, 1);

        const got = await client.get({ id: created.id });
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'over-http');
    });
});
