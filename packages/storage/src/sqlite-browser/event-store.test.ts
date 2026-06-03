import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { EventRow } from '@ultracontext/core';
import { createBrowserSqliteAdapter } from './index';

// =============================================================================
// BROWSER EVENT STORE SMOKE — the EventStore port works in the browser driver
// too (same driver-agnostic SqliteAdapter, sql.js engine, fake IndexedDB here).
// Proves insertEvent/listEvents/dedupe inherit with ZERO extra work.
// =============================================================================

// each test owns a fresh fake-indexeddb so persistence is isolated per name
let restoreIdb: (() => void) | undefined;
beforeEach(async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    restoreIdb = () => { (globalThis as { indexedDB?: unknown }).indexedDB = previous; };
});
afterEach(() => {
    restoreIdb?.();
    restoreIdb = undefined;
});

// a minimal committed event row
function row(eventId: string, occurredAt: string): EventRow {
    return {
        event_id: eventId,
        kind: 'claude.session.updated',
        source: 'driver',
        subject: 'claude:session:1',
        occurred_at: occurredAt,
        host: 'browser',
        privacy: 'metadata_only',
        received_at: occurredAt,
        delivery_state: 'committed',
        project_id: null,
        envelope: JSON.stringify({ event_id: eventId }),
    };
}

describe('createBrowserSqliteAdapter EventStore — in-browser, no server', () => {
    it('inserts, dedupes, and tails events through the browser adapter', async () => {
        const store = await createBrowserSqliteAdapter({ name: 'events.db' });

        // insert two, in reverse chronological order
        assert.equal((await store.insertEvent(row('evt_2', '2026-06-03T00:00:02.000Z'))).inserted, true);
        assert.equal((await store.insertEvent(row('evt_1', '2026-06-03T00:00:01.000Z'))).inserted, true);

        // a dupe never throws and is not counted
        assert.equal((await store.insertEvent(row('evt_1', '2026-06-03T00:00:01.000Z'))).inserted, false);

        // tail comes back chronological (oldest-of-tail first)
        const rows = await store.listEvents({ limit: 20 });
        assert.deepEqual(rows.map((e) => e.event_id), ['evt_1', 'evt_2']);
    });

    it('persists emitted events to IndexedDB: write → flush → reopen → present', async () => {
        const name = 'events-persist.db';

        const a = await createBrowserSqliteAdapter({ name });
        await a.insertEvent(row('evt_persist', '2026-06-03T00:00:00.000Z'));
        await a.flush();

        // reopen a brand-new adapter on the same name — the snapshot restores
        const b = await createBrowserSqliteAdapter({ name });
        const rows = await b.listEvents({ limit: 20 });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].event_id, 'evt_persist');
    });
});
