// =============================================================================
// ultracontext.browser.test — the UNIFIED facade over the BROWSER backend
// (sql.js + IndexedDB via fake-indexeddb). Proves `new UltraContext()` works
// LOCALLY in a browser with no server and no key, and that EVERY verb behaves
// identically to the node backend: create / append (single + array) / get
// (single + list + history) / update / delete (soft + permanent + empty-throws)
// / deleteMany / fork via create({from}). Plus persistence: write → flush →
// reopen → data survives. Edge runtime (no IDB, no window) → a clear throw.
//
// The real facade is hard-wired to the `#local-backend` seam (node loader under
// node test). To exercise it over the BROWSER backend WITHOUT flipping sql.js's
// own package condition (which would force its http-fetch browser build), the
// tests bind the facade's lazily-built backend to the browser seam directly.
// =============================================================================

import 'fake-indexeddb/auto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UltraContext } from './ultracontext';
import { loadLocalBackend } from './local-backend.browser';
import type { Backend } from './local-backend-types';

// -- typed message body -------------------------------------------------------

// the content-bearing shape the data rows carry (SDK responses are generic over it)
type Msg = { content: string; role?: string };

// -- browser-backed facade helper ---------------------------------------------

// a unique IndexedDB record name per call so tests never share state
let counter = 0;
function uniqueName(): string {
    return `uc-browser-${process.pid}-${counter++}-${Date.now()}`;
}

// build the REAL facade, then force its memoized backend to the BROWSER seam —
// the facade's verb-adaptation code runs unchanged over the sql.js + IDB client.
function browserFacade(name = uniqueName()): { uc: UltraContext; name: string } {
    const uc = new UltraContext({ db: name });
    // assign the private memoized backend so resolve() returns the browser one
    (uc as unknown as { backend: Promise<Backend> }).backend = loadLocalBackend({ db: name });
    return { uc, name };
}

// -- verb parity over the browser backend -------------------------------------

describe('UltraContext browser backend — verb parity', () => {
    // create → {id, metadata, created_at}; metadata tags the context
    it('creates a context with metadata', async () => {
        const { uc } = browserFacade();
        const created = await uc.create({ metadata: { source: 'sdk' } });
        assert.ok(created.id.length > 0);
        assert.equal(created.metadata.source, 'sdk');
        assert.ok(created.created_at);
    });

    // append(id, object) → one message; AppendResponse {data, version}
    it('appends a single message object', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        const res = await uc.append<Msg>(id, { role: 'user', content: 'hi' });
        assert.equal(res.data.length, 1);
        assert.equal(typeof res.version, 'number');
        assert.equal(res.data[0].content, 'hi');
    });

    // append(id, ARRAY) → many messages in one version
    it('appends an array of messages in one version', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        const res = await uc.append<Msg>(id, [{ content: 'a' }, { content: 'b' }]);
        assert.equal(res.data.length, 2);
        assert.equal(res.data[0].index, 0);
        assert.equal(res.data[1].index, 1);
    });

    // get(id) → single-context GetResponse {data, version}
    it('gets a single context by id', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        await uc.append(id, { content: 'one' });
        const got = await uc.get<Msg>(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'one');
        assert.equal(typeof got.version, 'number');
    });

    // get(id, {history}) → versions[] alongside the data
    it('gets a context with history', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        await uc.append(id, { content: 'x' });
        const got = await uc.get(id, { history: true });
        assert.ok(Array.isArray(got.versions));
    });

    // get() / get({filters}) → list overload
    it('lists contexts via the no-id / filters overload', async () => {
        const { uc } = browserFacade();
        const a = await uc.create({ metadata: { source: 'sdk' } });
        await uc.create({ metadata: { source: 'other' } });

        const all = await uc.get();
        assert.ok(all.data.some((c) => c.id === a.id));

        const filtered = await uc.get({ source: 'sdk' });
        assert.ok(filtered.data.every((c) => c.metadata.source === 'sdk'));
    });

    // update(id, {index, ...}) → UpdateResponse {data, version}; read-back persists
    it('updates a message by index', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        await uc.append(id, { content: 'old' });
        const res = await uc.update<Msg>(id, { index: 0, content: 'new' });
        assert.equal(res.data[0].content, 'new');
        assert.equal(typeof res.version, 'number');

        const got = await uc.get<Msg>(id);
        assert.equal(got.data[0].content, 'new');
    });

    // delete(id, ids) → SOFT delete; surface is {data, version} (survivors)
    it('soft-deletes messages, surfacing {data, version}', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        await uc.append(id, [{ content: 'keep' }, { content: 'drop' }]);
        const res = await uc.delete<Msg>(id, 1);
        assert.ok(Array.isArray(res.data));
        assert.equal(res.data.map((m) => m.content).join(','), 'keep');
        assert.equal(typeof res.version, 'number');
    });

    // delete(id, []) → empty soft-delete intent → throws, context intact
    it('rejects delete(id, []) and leaves the context intact', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        await uc.append(id, { content: 'keep me' });

        await assert.rejects(() => uc.delete(id, []), /ids/);

        const got = await uc.get<Msg>(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'keep me');
    });

    // delete(id, {permanent:true}) → PermanentDeleteResponse {deleted, id}; gone
    it('permanently deletes a whole context', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        await uc.append(id, { content: 'bye' });
        const res = await uc.delete(id, { permanent: true });
        assert.equal(res.deleted, true);
        assert.equal(res.id, id);

        await assert.rejects(() => uc.get(id));
    });

    // deleteMany(ids) → loops permanent deletes; per-id errors captured
    it('deletes many contexts, capturing per-id errors', async () => {
        const { uc } = browserFacade();
        const a = await uc.create();
        const b = await uc.create();

        const res = await uc.deleteMany([a.id, b.id, 'ctx_missing']);
        assert.equal(res.results.length, 3);
        assert.equal(res.deleted_count, 2);

        const bad = res.results.find((r) => r.id === 'ctx_missing');
        assert.equal(bad?.deleted, false);
        assert.ok(bad?.error);
    });

    // create({from}) → FORK: the new context inherits the source's messages
    it('forks a context via create({ from })', async () => {
        const { uc } = browserFacade();
        const { id } = await uc.create();
        await uc.append(id, [{ content: 'a' }, { content: 'b' }]);

        const fork = await uc.create({ from: id });
        assert.ok(fork.id.length > 0);
        assert.notEqual(fork.id, id);

        const got = await uc.get<Msg>(fork.id);
        assert.equal(got.data.map((m) => m.content).join(','), 'a,b');
    });

    // local errors THROW (parity with remote's HTTP-error throw)
    it('throws on a missing context', async () => {
        const { uc } = browserFacade();
        await assert.rejects(() => uc.get('ctx_nope'));
    });
});

// -- persistence across reopen -------------------------------------------------

describe('UltraContext browser backend — persistence', () => {
    // write → flush the snapshot → a fresh facade on the SAME name sees the data
    it('survives flush + reopen via IndexedDB', async () => {
        const name = uniqueName();

        // first facade: write, then force the IndexedDB snapshot out via the
        // PUBLIC flush() — the affordance web apps call before navigation
        const first = browserFacade(name);
        const { id } = await first.uc.create({ metadata: { keep: true } });
        await first.uc.append(id, { content: 'persisted' });
        await first.uc.flush();

        // second facade on the same name: the prior context + message are present
        const second = browserFacade(name);
        const got = await second.uc.get<Msg>(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'persisted');
    });
});

// -- edge runtime --------------------------------------------------------------

describe('UltraContext browser backend — edge runtime', () => {
    // no IndexedDB AND no window → local mode cannot persist → a clear throw
    it('throws an actionable error when neither IndexedDB nor window exist', async () => {
        const savedIdb = (globalThis as { indexedDB?: unknown }).indexedDB;
        const savedWindow = (globalThis as { window?: unknown }).window;
        try {
            delete (globalThis as { indexedDB?: unknown }).indexedDB;
            delete (globalThis as { window?: unknown }).window;
            await assert.rejects(() => loadLocalBackend({ db: uniqueName() }), /persistent runtime|apiKey/i);
        } finally {
            (globalThis as { indexedDB?: unknown }).indexedDB = savedIdb;
            (globalThis as { window?: unknown }).window = savedWindow;
        }
    });
});
