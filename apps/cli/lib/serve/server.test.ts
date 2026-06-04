// =============================================================================
// server.test — boot `uc serve` on an EPHEMERAL port (0) in-process and drive it
// with the REAL @ultracontext/js SDK over real HTTP through the FULL verb battery
// (create/append[array]/get[single+list+history]/update/delete[soft+permanent]/
// deleteMany), asserting the SAME response shapes the local backend produces.
// Plus events (commit → committed; dupe → committed:0; tail returns it) and auth
// (a bad/missing bearer → 401). The SDK is the wire contract — if it round-trips,
// the routes + shapes match exactly.
// =============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { UltraContext } from '@ultracontext/js';

import { startServer, type ServeHandle } from './server';
import { tempDbUrl, cleanupTempDbs } from '../testing/temp-db';

// the booted server + the bearer key + a temp config dir (off real ~)
let server: ServeHandle;
let sdk: UltraContext;
const tmpDirs: string[] = [];

// a fresh temp config dir so the serve key prefix is remembered off real ~
function freshConfigDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-serve-test-'));
    tmpDirs.push(dir);
    return dir;
}

// boot the server once on an ephemeral port over a fresh temp db
before(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', dbUrl: tempDbUrl(), configDir: freshConfigDir() });
    sdk = new UltraContext({ apiKey: server.key!, baseUrl: server.url });
});

after(async () => {
    await server.close();
    cleanupTempDbs();
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// -- first run mints a key ------------------------------------------------------

describe('uc serve boot', () => {
    // a fresh db mints the bearer key (surfaced once for the user to copy)
    it('mints a bearer key on first run', () => {
        assert.ok(server.key && server.key.startsWith('uc_'));
        assert.ok(server.url.startsWith('http://127.0.0.1:'));
    });
});

// -- the full verb battery via the SDK -----------------------------------------

describe('context verbs over the SDK', () => {
    // create → an id + echoed context metadata + a created_at
    it('create returns an id with metadata + created_at', async () => {
        const created = await sdk.create({ metadata: { source: 'serve-test' } });
        assert.ok(created.id.length > 0);
        assert.equal(created.metadata.source, 'serve-test');
        assert.ok(created.created_at);
    });

    // append (ARRAY) in ONE call → both messages, one version bump
    it('append an array of messages in one call', async () => {
        const c = await sdk.create();
        const res = await sdk.append(c.id, [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }]);
        assert.equal(res.data.length, 2);
        assert.equal(res.data[0].index, 0);
        assert.equal(res.data[1].index, 1);
        assert.equal(typeof res.version, 'number');
    });

    // get (single) → the messages back, with the same ids + content
    it('get a single context returns its messages', async () => {
        const c = await sdk.create();
        await sdk.append(c.id, { role: 'user', text: 'hello' });
        const got = await sdk.get<{ text: string }>(c.id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].text, 'hello');
    });

    // get (list) → the project's contexts (the created ones are present)
    it('get (list) returns the project contexts', async () => {
        const c = await sdk.create({ metadata: { source: 'list-probe' } });
        const list = await sdk.get({ source: 'list-probe' });
        assert.ok(list.data.some((row) => row.id === c.id));
    });

    // get (history) → the version timeline after create + append
    it('get with history returns the version timeline', async () => {
        const c = await sdk.create();
        await sdk.append(c.id, { role: 'user', text: 'x' });
        const got = await sdk.get(c.id, { history: true });
        assert.ok(Array.isArray(got.versions));
        assert.ok(got.versions!.length >= 1);
    });

    // update → a copy-on-write new version with the patched message
    it('update patches a message into a new version', async () => {
        const c = await sdk.create();
        const appended = await sdk.append(c.id, { role: 'user', text: 'before' });
        const id = appended.data[0].id;
        const updated = await sdk.update<{ text: string }>(c.id, { id, text: 'after' });
        assert.equal(updated.data[0].text, 'after');
    });

    // delete (soft, by ids) → the surviving messages + a new version
    it('delete (soft) removes a message and bumps the version', async () => {
        const c = await sdk.create();
        const a = await sdk.append(c.id, [{ text: 'keep' }, { text: 'drop' }]);
        const dropId = a.data[1].id;
        const res = await sdk.delete<{ text: string }>(c.id, [dropId]);
        assert.equal(res.data.length, 1);
        assert.equal(res.data[0].text, 'keep');
    });

    // delete (permanent) → the whole context is gone (a later get 404s → throws)
    it('delete (permanent) removes the whole context', async () => {
        const c = await sdk.create();
        const res = await sdk.delete(c.id, { permanent: true });
        assert.equal(res.deleted, true);
        assert.equal(res.id, c.id);
        await assert.rejects(() => sdk.get(c.id));
    });

    // deleteMany → a per-id results envelope + a deleted_count
    it('deleteMany batch-deletes contexts', async () => {
        const a = await sdk.create();
        const b = await sdk.create();
        const res = await sdk.deleteMany([a.id, b.id]);
        assert.equal(res.deleted_count, 2);
        assert.equal(res.results.length, 2);
        assert.ok(res.results.every((r) => r.deleted));
    });
});

// -- events --------------------------------------------------------------------

describe('events over HTTP', () => {
    // a committed envelope; the duplicate is idempotent; the tail returns it
    it('commit an event, dedupe the dupe, tail it back', async () => {
        const envelope = {
            schema_version: 'uc.event.v1',
            event_id: 'evt_serve_test_1',
            kind: 'serve.test',
            source: 'server-test',
            subject: 'demo',
            occurred_at: new Date().toISOString(),
            host: 'test-host',
            privacy: 'internal',
        };

        // POST /events → committed:true + a received_at + the event_id
        const first = await postEvent(server, envelope);
        assert.equal(first.status, 200);
        assert.equal(first.body.committed, true);
        assert.ok(first.body.received_at);
        assert.equal(first.body.event_id, 'evt_serve_test_1');

        // the same event_id again → committed:false (dedupe), never an error
        const dupe = await postEvent(server, envelope);
        assert.equal(dupe.status, 200);
        assert.equal(dupe.body.committed, false);

        // GET /events → the committed envelope is in the tail array
        const tail = await getEvents(server, { kind: 'serve.test' });
        assert.equal(tail.status, 200);
        assert.ok(Array.isArray(tail.body));
        assert.ok(tail.body.some((e: { event_id: string }) => e.event_id === 'evt_serve_test_1'));
    });
});

// -- auth ----------------------------------------------------------------------

describe('bearer auth', () => {
    // a missing bearer → 401
    it('rejects a request with no bearer', async () => {
        const res = await fetch(`${server.url}/contexts`);
        assert.equal(res.status, 401);
    });

    // a wrong bearer → 401
    it('rejects a request with a bad bearer', async () => {
        const res = await fetch(`${server.url}/contexts`, { headers: { Authorization: 'Bearer uc_live_wrong' } });
        assert.equal(res.status, 401);
    });
});

// -- raw HTTP helpers for events (the SDK has no events surface) ----------------

// POST an envelope to /events with the bearer; return status + parsed body
async function postEvent(s: ServeHandle, envelope: unknown): Promise<{ status: number; body: { committed: boolean; received_at: string | null; event_id: string } }> {
    const res = await fetch(`${s.url}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
    });
    return { status: res.status, body: await res.json() };
}

// GET /events with optional filters + the bearer; return status + the array body
async function getEvents(s: ServeHandle, filters: Record<string, string>): Promise<{ status: number; body: any }> {
    const qs = new URLSearchParams(filters).toString();
    const res = await fetch(`${s.url}/events?${qs}`, { headers: { Authorization: `Bearer ${s.key}` } });
    return { status: res.status, body: await res.json() };
}
