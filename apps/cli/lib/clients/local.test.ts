// =============================================================================
// local.test — LocalContextClient against a real temp SQLite db (no server, no
// HTTP, no cwd default). Covers: create returns an id; create({from}) forks
// (copies source messages); append(id)+get(id) round-trip; context + message
// metadata persist; delete metadata is recorded as a version.
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

// build a fresh client bound to a temp db (cwd is unused — no default context)
async function freshClient() {
    return createLocalClient({ dbUrl: tempDbUrl(), cwd: '/unused' });
}

// -- create -------------------------------------------------------------------

describe('LocalContextClient.create', () => {
    // create makes a root context and returns its id + echoed metadata
    it('returns a new context id with context-level metadata', async () => {
        const client = await freshClient();

        const created = await client.create({ metadata: { source: 'cli', label: 'notes' } });
        assert.ok(created.id.length > 0);
        assert.equal(created.metadata.source, 'cli');

        // the metadata tags the CONTEXT — discoverable via list
        const listed = await client.list({ source: 'cli' });
        assert.ok(listed.data.some((c) => c.id === created.id && c.metadata.label === 'notes'));
    });

    // create({from}) forks a source — the clone carries its messages
    it('forks a source context, copying its messages', async () => {
        const client = await freshClient();

        // seed a source context with two messages
        const source = await client.create({});
        await client.append({ id: source.id, messages: [{ content: 'one' }, { content: 'two' }] });

        // fork it — the clone is a distinct context with the same messages
        const fork = await client.create({ from: source.id });
        assert.notEqual(fork.id, source.id);

        const got = await client.get({ id: fork.id });
        assert.deepEqual(got.data.map((m) => m.content), ['one', 'two']);
    });
});

// -- append + get round-trip --------------------------------------------------

describe('LocalContextClient append/get', () => {
    // appending to an explicit id and reading it back returns the same messages
    it('round-trips messages through an explicit context id', async () => {
        const client = await freshClient();

        const ctx = await client.create({});
        const appended = await client.append({ id: ctx.id, messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ] });
        assert.equal(appended.id, ctx.id);
        assert.equal(appended.data.length, 2);

        const got = await client.get({ id: ctx.id });
        assert.equal(got.data.length, 2);
        assert.equal(got.data[0].role, 'user');
        assert.equal(got.data[1].content, 'hi');
    });

    // per-message metadata survives the round-trip
    it('persists per-message metadata', async () => {
        const client = await freshClient();

        const ctx = await client.create({});
        await client.append({ id: ctx.id, messages: [{ content: 'tagged', metadata: { pinned: true } }] });

        const got = await client.get({ id: ctx.id });
        assert.equal(got.data[0].metadata.pinned, true);
    });

    // appends accumulate on the same explicit context
    it('accumulates appends on the same context', async () => {
        const client = await freshClient();

        const ctx = await client.create({});
        await client.append({ id: ctx.id, messages: [{ content: 'one' }] });
        await client.append({ id: ctx.id, messages: [{ content: 'two' }] });

        const got = await client.get({ id: ctx.id });
        assert.equal(got.data.length, 2);
    });
});

// -- update -------------------------------------------------------------------

describe('LocalContextClient.update', () => {
    // update patches a message by index → bumps the version
    it('patches a message and bumps version', async () => {
        const client = await freshClient();

        const ctx = await client.create({});
        await client.append({ id: ctx.id, messages: [{ role: 'user', content: 'old' }] });

        const updated = await client.update({ id: ctx.id, updates: [{ index: 0, content: 'new' }] });
        assert.equal(updated.version, 1);

        const got = await client.get({ id: ctx.id });
        assert.equal(got.data[0].content, 'new');
    });
});

// -- delete -------------------------------------------------------------------

describe('LocalContextClient.delete', () => {
    // whole-context delete permanently removes the context
    it('removes the whole context', async () => {
        const client = await freshClient();

        const ctx = await client.create({});
        await client.append({ id: ctx.id, messages: [{ content: 'bye' }] });

        const res = await client.delete({ id: ctx.id, permanent: true });
        assert.equal(res.deleted, true);
        assert.equal(res.id, ctx.id);

        // it no longer reads back
        await assert.rejects(() => client.get({ id: ctx.id }));
    });

    // a message-level delete with metadata records it on the new version head
    it('records delete metadata as a version (message delete)', async () => {
        const client = await freshClient();

        const ctx = await client.create({});
        await client.append({ id: ctx.id, messages: [{ content: 'a' }, { content: 'b' }] });

        // drop index 0, tagging the delete with an audit reason
        await client.delete({ id: ctx.id, ids: [0], metadata: { reason: 'cleanup' } });

        // the survivor remains
        const got = await client.get({ id: ctx.id });
        assert.deepEqual(got.data.map((m) => m.content), ['b']);

        // the delete version carries the metadata in its history
        const history = await client.get({ id: ctx.id, history: true });
        const versions = (history as unknown as { versions?: Array<{ operation: string; metadata?: Record<string, unknown> }> }).versions ?? [];
        const del = versions.find((v) => v.operation === 'delete');
        assert.ok(del, 'a delete version exists');
        assert.equal(del!.metadata?.reason, 'cleanup');
    });
});

// -- deleteMany ---------------------------------------------------------------

describe('LocalContextClient.deleteMany', () => {
    // batch delete fans out permanent deletes, capturing per-id errors as rows
    it('deletes many contexts and captures per-id errors without aborting', async () => {
        const client = await freshClient();

        // two real contexts + one bogus id (the bogus one must NOT abort the batch)
        const a = await client.create({});
        const b = await client.create({});

        const res = await client.deleteMany({ ids: [a.id, b.id, 'ctx_missing'] });

        // every requested id gets a row; the two real ones deleted, the bogus failed
        assert.equal(res.results.length, 3);
        assert.equal(res.deleted_count, 2);
        const bad = res.results.find((r) => r.id === 'ctx_missing');
        assert.equal(bad?.deleted, false);
        assert.ok(bad?.error, 'the missing id carries an error reason');

        // the two real contexts are actually gone
        await assert.rejects(() => client.get({ id: a.id }));
        await assert.rejects(() => client.get({ id: b.id }));
    });
});

// -- errors / fresh home ------------------------------------------------------

describe('LocalContextClient edge cases', () => {
    // operating on a missing context surfaces a thrown error (not_found)
    it('throws when getting a non-existent explicit id', async () => {
        const client = await freshClient();
        await assert.rejects(() => client.get({ id: 'ctx_does_not_exist' }));
    });

    // a db url under a not-yet-existent dir works — the dir is created first
    // (mirrors a fresh HOME where ~/.ultracontext does not exist yet)
    it('creates the db parent dir when missing', async () => {
        const root = path.join(os.tmpdir(), `uc-cli-freshhome-${process.pid}-${Date.now()}`);
        tmpDirs.push(root);
        const dbUrl = 'file:' + path.join(root, 'nested', 'uc.db');

        const client = await createLocalClient({ dbUrl, cwd: '/unused' });
        const ctx = await client.create({});
        const appended = await client.append({ id: ctx.id, messages: [{ content: 'hi' }] });
        assert.equal(appended.data.length, 1);
    });
});
