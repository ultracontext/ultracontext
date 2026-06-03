import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createContext, appendMessages, getContext } from '@ultracontext/core';
import { createBrowserSqliteAdapter } from './index';

// =============================================================================
// BROWSER SQLITE — sql.js + IndexedDB persistence. Runs in node here (sql.js is
// pure wasm; IndexedDB is faked). Proves new UltraContext() works LOCALLY in a
// browser with zero server and zero key, persisting snapshots to IndexedDB.
// =============================================================================

// each test owns a fresh fake-indexeddb so persistence is isolated per name
let restoreIdb: (() => void) | undefined;
beforeEach(async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    restoreIdb = () => {
        (globalThis as { indexedDB?: unknown }).indexedDB = previous;
    };
});
afterEach(() => {
    restoreIdb?.();
    restoreIdb = undefined;
});

describe('createBrowserSqliteAdapter — core ops run in-browser, no server', () => {
    it('round-trips create → append → get through @ultracontext/core', async () => {
        const storage = await createBrowserSqliteAdapter({ name: 'crud.db' });
        const project = await storage.insertProject('test');
        const projectId = project!.id;

        // create a context
        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;

        // append two messages
        const appended = await appendMessages(storage, projectId, created.data.id, [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ]);
        assert.equal(appended.ok, true);
        if (!appended.ok) return;
        assert.equal(appended.data.data.length, 2);

        // read them back, ordered
        const got = await getContext(storage, projectId, created.data.id, {});
        assert.equal(got.ok, true);
        if (!got.ok) return;
        assert.equal(got.data.data.length, 2);
        assert.equal(got.data.data[0].role, 'user');
        assert.equal(got.data.data[1].role, 'assistant');
    });

    it('persists to IndexedDB: write → flush → reopen new adapter → data present', async () => {
        const name = 'persist.db';

        // write with one adapter, force a snapshot to IndexedDB
        const a = await createBrowserSqliteAdapter({ name });
        const project = await a.insertProject('test');
        const projectId = project!.id;
        const created = await createContext(a, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;
        await appendMessages(a, projectId, created.data.id, [{ role: 'user', content: 'persisted' }]);
        await a.flush();

        // reopen a brand-new adapter on the SAME name — the snapshot restores
        const b = await createBrowserSqliteAdapter({ name });
        const got = await getContext(b, projectId, created.data.id, {});
        assert.equal(got.ok, true);
        if (!got.ok) return;
        assert.equal(got.data.data.length, 1);
        assert.equal(got.data.data[0].content, 'persisted');
    });

    it('isolates by name: a different name reopens empty', async () => {
        // write under one name
        const a = await createBrowserSqliteAdapter({ name: 'one.db' });
        await a.insertProject('only-in-one');
        await a.flush();

        // a different name has its own (empty) snapshot
        const b = await createBrowserSqliteAdapter({ name: 'two.db' });
        const found = await b.findProjectByName('only-in-one');
        assert.equal(found, null);
    });

    it('debounced save lands without an explicit flush', async () => {
        const name = 'debounce.db';

        // mutate, then wait past the debounce window (~100ms) — no flush() call
        const a = await createBrowserSqliteAdapter({ name });
        const project = await a.insertProject('test');
        const projectId = project!.id;
        const created = await createContext(a, projectId, {});
        if (!created.ok) return;
        await appendMessages(a, projectId, created.data.id, [{ role: 'user', content: 'auto-saved' }]);
        await new Promise((r) => setTimeout(r, 250));

        // reopen — the debounced snapshot made it to IndexedDB on its own
        const b = await createBrowserSqliteAdapter({ name });
        const got = await getContext(b, projectId, created.data.id, {});
        assert.equal(got.ok, true);
        if (!got.ok) return;
        assert.equal(got.data.data.length, 1);
        assert.equal(got.data.data[0].content, 'auto-saved');
    });
});

describe('createBrowserSqliteAdapter — no IndexedDB fallback', () => {
    it('falls back to in-memory + warns once when indexedDB is absent', async () => {
        // hide IndexedDB to simulate an edge runtime / locked-down browser
        const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
        delete (globalThis as { indexedDB?: unknown }).indexedDB;

        // capture console.warn to assert exactly one warning
        const original = console.warn;
        let warnings = 0;
        console.warn = () => { warnings += 1; };

        try {
            // still fully functional, just non-persistent
            const storage = await createBrowserSqliteAdapter({ name: 'no-idb.db' });
            const project = await storage.insertProject('test');
            const projectId = project!.id;
            const created = await createContext(storage, projectId, {});
            assert.equal(created.ok, true);
            if (!created.ok) return;
            const appended = await appendMessages(storage, projectId, created.data.id, [{ role: 'user', content: 'ephemeral' }]);
            assert.equal(appended.ok, true);

            // flush is a no-op but must not throw, and warns only once total
            await storage.flush();
            assert.equal(warnings, 1);
        } finally {
            console.warn = original;
            (globalThis as { indexedDB?: unknown }).indexedDB = previous;
        }
    });
});
