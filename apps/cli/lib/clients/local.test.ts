// =============================================================================
// local.test — LocalContextClient round-trips through the ContextClient
// interface against a real temp SQLite db. No server, no HTTP.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createLocalClient } from './local';
import { tempDbUrl, cleanupTempDbs } from '../testing/temp-db';

// extra temp dirs created by the fresh-home test (removed recursively after)
const tmpDirs: string[] = [];

after(() => {
    cleanupTempDbs();
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// build a fresh client bound to a temp db + a fixed cwd
async function freshClient(cwd = '/work/local-test') {
    return createLocalClient({ dbUrl: tempDbUrl(), cwd });
}

// -- add → get ----------------------------------------------------------------

describe('LocalContextClient', () => {
    // append to the default context, then read it back ordered
    it('add → get round-trips against the default context', async () => {
        const client = await freshClient();

        const added = await client.add({ messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ] });
        assert.equal(added.data.length, 2);

        const got = await client.get({});
        assert.equal(got.data.length, 2);
        assert.equal(got.data[0].role, 'user');
        assert.equal(got.data[1].content, 'hi');
    });

    // the default context is stable across calls (same cwd → same context)
    it('appends accumulate on the same default context', async () => {
        const client = await freshClient('/work/accumulate');

        await client.add({ messages: [{ role: 'user', content: 'one' }] });
        await client.add({ messages: [{ role: 'user', content: 'two' }] });

        const got = await client.get({});
        assert.equal(got.data.length, 2);
    });

    // list returns the default context, discoverable by its cwd tag
    it('list returns the project contexts', async () => {
        const client = await freshClient('/work/listed');
        await client.add({ messages: [{ role: 'user', content: 'x' }] });

        const listed = await client.list({});
        assert.ok(listed.data.length >= 1);
        assert.equal(listed.data[0].metadata.project_path, '/work/listed');
    });

    // update patches a message by index → bumps the version
    it('update patches a message and bumps version', async () => {
        const client = await freshClient('/work/updated');
        await client.add({ messages: [{ role: 'user', content: 'old' }] });

        const updated = await client.update({ updates: [{ index: 0, content: 'new' }] });
        assert.equal(updated.version, 1);

        const got = await client.get({});
        assert.equal(got.data[0].content, 'new');
    });

    // delete permanently removes the context
    it('delete removes the context', async () => {
        const client = await freshClient('/work/deleted');
        const added = await client.add({ messages: [{ role: 'user', content: 'bye' }] });
        assert.ok(added.data.length === 1);

        // resolve the id via list, then delete it explicitly
        const listed = await client.list({});
        const id = listed.data[0].id;

        const res = await client.delete({ id });
        assert.equal(res.deleted, true);
        assert.equal(res.id, id);

        // it no longer appears in the listing
        const after = await client.list({ project_path: '/work/deleted' });
        assert.equal(after.data.length, 0);
    });

    // operating on a missing context surfaces a thrown error (not_found)
    it('throws when getting a non-existent explicit id', async () => {
        const client = await freshClient('/work/missing');
        await assert.rejects(() => client.get({ id: 'ctx_does_not_exist' }));
    });

    // a db url under a not-yet-existent dir works — the dir is created first
    // (mirrors a fresh HOME where ~/.ultracontext does not exist yet)
    it('creates the db parent dir when missing', async () => {
        // a nested path that does not exist — opening would SQLITE_CANTOPEN
        const root = path.join(os.tmpdir(), `uc-cli-freshhome-${process.pid}-${Date.now()}`);
        tmpDirs.push(root);
        const dbUrl = 'file:' + path.join(root, 'nested', 'uc.db');

        const client = await createLocalClient({ dbUrl, cwd: '/work/freshhome' });
        const added = await client.add({ messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(added.data.length, 1);
    });
});
