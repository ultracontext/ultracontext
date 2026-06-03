import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import type { EventRow } from '@ultracontext/core';
import { createSqliteAdapter } from './index';

// =============================================================================
// EVENT STORE — the EventStore port implemented on the driver-agnostic
// SqliteAdapter, exercised over REAL temp-file dbs (libsql :memory: does NOT
// share tables across connections, so every test uses a file).
// =============================================================================

// unique temp db file per use, auto-cleaned (incl. WAL/SHM sidecars)
const tmpFiles: string[] = [];
function tmpDbUrl(): string {
    const file = path.join(os.tmpdir(), `uc-events-${process.pid}-${tmpFiles.length}-${Date.now()}.db`);
    tmpFiles.push(file);
    return `file:${file}`;
}
after(() => {
    for (const f of tmpFiles) {
        for (const ext of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(f + ext); } catch { /* ignore */ }
        }
    }
});

// build a minimal valid EventRow at a given occurred_at + delivery_state
function row(over: Partial<EventRow> & Pick<EventRow, 'event_id'>): EventRow {
    const base: EventRow = {
        event_id: over.event_id,
        kind: over.kind ?? 'agent.run.completed',
        source: over.source ?? 'test',
        subject: over.subject ?? 'subj:1',
        occurred_at: over.occurred_at ?? '2026-06-03T00:00:00.000Z',
        host: over.host ?? 'test-host',
        privacy: over.privacy ?? 'metadata_only',
        received_at: over.received_at ?? null,
        delivery_state: over.delivery_state ?? 'pending',
        project_id: over.project_id ?? null,
        envelope: over.envelope ?? '{}',
    };
    return { ...base, ...over };
}

describe('SqliteAdapter EventStore — real temp-file db', () => {
    it('inserts an event row and reads it back via listEvents', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        const r = await store.insertEvent(row({ event_id: 'evt_a', envelope: '{"event_id":"evt_a"}' }));
        assert.equal(r.inserted, true);

        const rows = await store.listEvents({ limit: 20 });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].event_id, 'evt_a');
        assert.equal(rows[0].envelope, '{"event_id":"evt_a"}');
    });

    it('dedupes on event_id: a second insert returns inserted:false, never throws', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        const first = await store.insertEvent(row({ event_id: 'evt_dupe' }));
        assert.equal(first.inserted, true);

        // same event_id again — idempotent, no throw, the row is not doubled
        const second = await store.insertEvent(row({ event_id: 'evt_dupe', kind: 'other.kind' }));
        assert.equal(second.inserted, false);

        const rows = await store.listEvents({ limit: 20 });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, 'agent.run.completed'); // original row kept
    });

    it('listEvents returns the newest N in chronological order (oldest-of-tail first)', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        // insert out of order — three distinct occurred_at timestamps
        await store.insertEvent(row({ event_id: 'evt_2', occurred_at: '2026-06-03T00:00:02.000Z' }));
        await store.insertEvent(row({ event_id: 'evt_1', occurred_at: '2026-06-03T00:00:01.000Z' }));
        await store.insertEvent(row({ event_id: 'evt_3', occurred_at: '2026-06-03T00:00:03.000Z' }));

        // newest-LAST: chronological, oldest first
        const all = await store.listEvents({ limit: 20 });
        assert.deepEqual(all.map((e) => e.event_id), ['evt_1', 'evt_2', 'evt_3']);

        // a limit takes the NEWEST two, still oldest-of-tail first
        const tail = await store.listEvents({ limit: 2 });
        assert.deepEqual(tail.map((e) => e.event_id), ['evt_2', 'evt_3']);
    });

    it('listEvents filters by kind / source / subject (ANDed)', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        await store.insertEvent(row({ event_id: 'evt_a', kind: 'claude.session.updated', source: 'driver', subject: 'claude:session:1' }));
        await store.insertEvent(row({ event_id: 'evt_b', kind: 'sync.failed', source: 'driver', subject: 'sync:1' }));
        await store.insertEvent(row({ event_id: 'evt_c', kind: 'claude.session.updated', source: 'other', subject: 'claude:session:2' }));

        const byKind = await store.listEvents({ limit: 20, kind: 'claude.session.updated' });
        assert.deepEqual(byKind.map((e) => e.event_id).sort(), ['evt_a', 'evt_c']);

        const byKindAndSource = await store.listEvents({ limit: 20, kind: 'claude.session.updated', source: 'driver' });
        assert.deepEqual(byKindAndSource.map((e) => e.event_id), ['evt_a']);

        const bySubject = await store.listEvents({ limit: 20, subject: 'sync:1' });
        assert.deepEqual(bySubject.map((e) => e.event_id), ['evt_b']);
    });

    it('listEvents committed:true returns only committed rows (the tail/committed log)', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        await store.insertEvent(row({ event_id: 'evt_committed', delivery_state: 'committed', occurred_at: '2026-06-03T00:00:01.000Z' }));
        await store.insertEvent(row({ event_id: 'evt_pending', delivery_state: 'pending', occurred_at: '2026-06-03T00:00:02.000Z' }));
        await store.insertEvent(row({ event_id: 'evt_sent', delivery_state: 'sent', occurred_at: '2026-06-03T00:00:03.000Z' }));

        // committed-only excludes pending + sent — exactly what `tail` reads
        const committed = await store.listEvents({ limit: 20, committed: true });
        assert.deepEqual(committed.map((e) => e.event_id), ['evt_committed']);

        // no committed filter → the generic newest-N reader returns all states
        const all = await store.listEvents({ limit: 20 });
        assert.equal(all.length, 3);
    });

    it('pendingEvents returns only pending rows, oldest first, optionally capped', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        await store.insertEvent(row({ event_id: 'evt_committed', delivery_state: 'committed', occurred_at: '2026-06-03T00:00:00.000Z' }));
        await store.insertEvent(row({ event_id: 'evt_p2', delivery_state: 'pending', occurred_at: '2026-06-03T00:00:02.000Z' }));
        await store.insertEvent(row({ event_id: 'evt_p1', delivery_state: 'pending', occurred_at: '2026-06-03T00:00:01.000Z' }));

        // oldest pending first; committed excluded
        const pending = await store.pendingEvents();
        assert.deepEqual(pending.map((e) => e.event_id), ['evt_p1', 'evt_p2']);

        // capped
        const one = await store.pendingEvents(1);
        assert.deepEqual(one.map((e) => e.event_id), ['evt_p1']);
    });

    it('markDelivered flips a pending row to sent', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        await store.insertEvent(row({ event_id: 'evt_x', delivery_state: 'pending' }));
        await store.markDelivered('evt_x');

        const stillPending = await store.pendingEvents();
        assert.equal(stillPending.length, 0);

        const counts = await store.countByDeliveryState();
        assert.equal(counts.sent, 1);
        assert.equal(counts.pending, 0);
    });

    it('countByDeliveryState groups counts, zero-filling absent states', async () => {
        const store = await createSqliteAdapter(tmpDbUrl());

        await store.insertEvent(row({ event_id: 'evt_c1', delivery_state: 'committed' }));
        await store.insertEvent(row({ event_id: 'evt_c2', delivery_state: 'committed' }));
        await store.insertEvent(row({ event_id: 'evt_p1', delivery_state: 'pending' }));

        const counts = await store.countByDeliveryState();
        assert.deepEqual(counts, { committed: 2, pending: 1, sent: 0 });
    });

    it('persists events across reconnects to the same file', async () => {
        const url = tmpDbUrl();

        let store = await createSqliteAdapter(url);
        await store.insertEvent(row({ event_id: 'evt_persist', delivery_state: 'committed' }));

        // reopen a fresh connection — the row survives
        store = await createSqliteAdapter(url);
        const rows = await store.listEvents({ limit: 20 });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].event_id, 'evt_persist');
    });
});

describe('SqliteAdapter EventStore — schema upgrade on a pre-existing db', () => {
    it('adds the events table to a db file that predates it (CREATE TABLE IF NOT EXISTS)', async () => {
        const url = tmpDbUrl();
        const file = url.slice('file:'.length);

        // simulate an OLD db: create only the projects table, no events table,
        // via the raw libsql client (bypassing the adapter's full DDL)
        const { createClient } = await import('@libsql/client');
        const legacy = createClient({ url });
        await legacy.execute('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL, public_id TEXT)');
        legacy.close();
        assert.equal(fs.existsSync(file), true);

        // open via the adapter — bootstrap applies the events DDL to the old file
        const store = await createSqliteAdapter(url);
        const r = await store.insertEvent(row({ event_id: 'evt_upgraded', delivery_state: 'committed' }));
        assert.equal(r.inserted, true);

        const rows = await store.listEvents({ limit: 20 });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].event_id, 'evt_upgraded');
    });
});
