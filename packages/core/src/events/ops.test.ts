import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { emitEvent, commitEvent, tailEvents, eventStatus, flushPending } from './ops';
import { MemoryEventStore } from '../testing/memory-event-store';
import type { EventEnvelope } from './envelope';

// =============================================================================
// EVENT OPS — emit (local vs pending), commit idempotence, tail order/limit/
// filters, status, flush success/partial-failure. Driven against the in-memory
// EventStore double.
// =============================================================================

// a minimal valid emit input
function emitInput(over: Record<string, unknown> = {}) {
    return { kind: 'agent.run.completed', source: 'build-agent', subject: 'run:1', ...over };
}

describe('emitEvent — local mode', () => {
    it('builds, validates, inserts committed with received_at set', async () => {
        const store = new MemoryEventStore();
        const r = await emitEvent(store, emitInput(), { hostDefault: 'h1', localMode: true });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        const row = store.getAllRows()[0];
        assert.equal(row.delivery_state, 'committed');
        assert.notEqual(row.received_at, null);
        assert.equal(r.data.host, 'h1');
    });

    it('defaults event_id (evt_ + 24 hex), occurred_at, priority 50, ok true, privacy metadata_only', async () => {
        const store = new MemoryEventStore();
        const r = await emitEvent(store, emitInput(), { hostDefault: 'h1', localMode: true });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.match(r.data.event_id, /^evt_[0-9a-f]{24}$/);
        assert.equal(r.data.priority, 50);
        assert.equal(r.data.ok, true);
        assert.equal(r.data.privacy, 'metadata_only');
        assert.ok(!isNaN(Date.parse(r.data.occurred_at)));
    });

    it('honors a caller-provided event_id / privacy / priority', async () => {
        const store = new MemoryEventStore();
        const r = await emitEvent(store, emitInput({ event_id: 'evt_custom', privacy: 'public', priority: 10 }), {
            hostDefault: 'h1',
            localMode: true,
        });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.event_id, 'evt_custom');
        assert.equal(r.data.privacy, 'public');
        assert.equal(r.data.priority, 10);
    });

    it('rejects invalid input without inserting', async () => {
        const store = new MemoryEventStore();
        const r = await emitEvent(store, emitInput({ kind: 'bad kind' }), { hostDefault: 'h1', localMode: true });

        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.equal(r.code, 'invalid_input');
        assert.equal(store.getAllRows().length, 0);
    });
});

describe('emitEvent — remote (pending) mode', () => {
    it('inserts pending with received_at null', async () => {
        const store = new MemoryEventStore();
        const r = await emitEvent(store, emitInput(), { hostDefault: 'h1', localMode: false });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        const row = store.getAllRows()[0];
        assert.equal(row.delivery_state, 'pending');
        assert.equal(row.received_at, null);
    });
});

describe('commitEvent — hub side', () => {
    // a committed envelope JSON string for commit tests
    function envelopeJson(over: Partial<EventEnvelope> = {}): string {
        const env: EventEnvelope = {
            schema_version: 'uc.event.v1',
            event_id: 'evt_commit1',
            kind: 'agent.run.completed',
            source: 'build-agent',
            subject: 'run:1',
            occurred_at: '2026-06-03T06:25:02.978Z',
            host: 'h1',
            privacy: 'metadata_only',
            ...over,
        };
        return JSON.stringify(env);
    }

    it('parses, re-validates, sets received_at, inserts committed', async () => {
        const store = new MemoryEventStore();
        const r = await commitEvent(store, envelopeJson());

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.committed, true);
        const row = store.getAllRows()[0];
        assert.equal(row.delivery_state, 'committed');
        assert.notEqual(row.received_at, null);
    });

    it('is idempotent — a duplicate event_id returns committed:false, not an error', async () => {
        const store = new MemoryEventStore();
        await commitEvent(store, envelopeJson());
        const r = await commitEvent(store, envelopeJson());

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.committed, false);
        assert.equal(store.getAllRows().length, 1);
    });

    it('rejects malformed JSON', async () => {
        const store = new MemoryEventStore();
        const r = await commitEvent(store, '{not json');
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.equal(r.code, 'invalid_input');
    });

    it('rejects an invalid envelope', async () => {
        const store = new MemoryEventStore();
        const r = await commitEvent(store, JSON.stringify({ schema_version: 'uc.event.v1' }));
        assert.equal(r.ok, false);
    });

    it('overwrites a stale received_at to commit time', async () => {
        const store = new MemoryEventStore();
        const r = await commitEvent(store, envelopeJson({ received_at: '2000-01-01T00:00:00.000Z' }));
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.notEqual(r.data.received_at, '2000-01-01T00:00:00.000Z');
    });
});

describe('tailEvents — chronological tail', () => {
    // emit n committed events with ascending occurred_at
    async function seed(store: MemoryEventStore, n: number, over: (i: number) => Record<string, unknown> = () => ({})) {
        for (let i = 0; i < n; i++) {
            await emitEvent(
                store,
                emitInput({
                    event_id: `evt_${i}`,
                    occurred_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
                    ...over(i),
                }),
                { hostDefault: 'h1', localMode: true }
            );
        }
    }

    it('returns the last N in chronological order (oldest-of-tail first)', async () => {
        const store = new MemoryEventStore();
        await seed(store, 5);
        const r = await tailEvents(store, { limit: 3 });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.deepEqual(r.data.map((e) => e.event_id), ['evt_2', 'evt_3', 'evt_4']);
    });

    it('defaults the limit to 20', async () => {
        const store = new MemoryEventStore();
        await seed(store, 25);
        const r = await tailEvents(store, {});

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.length, 20);
        assert.equal(r.data[0].event_id, 'evt_5');
    });

    it('filters by kind', async () => {
        const store = new MemoryEventStore();
        await seed(store, 4, (i) => ({ kind: i % 2 === 0 ? 'a.b' : 'c.d' }));
        const r = await tailEvents(store, { limit: 20, filters: { kind: 'a.b' } });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.deepEqual(r.data.map((e) => e.kind), ['a.b', 'a.b']);
    });

    it('filters by source and subject', async () => {
        const store = new MemoryEventStore();
        await seed(store, 2, (i) => ({ source: `src${i}`, subject: `sub${i}` }));
        const r = await tailEvents(store, { limit: 20, filters: { source: 'src1', subject: 'sub1' } });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.length, 1);
        assert.equal(r.data[0].event_id, 'evt_1');
    });

    it('returns parsed envelopes (round-trip fidelity)', async () => {
        const store = new MemoryEventStore();
        await seed(store, 1, () => ({ labels: { app: 'claude' } }));
        const r = await tailEvents(store, { limit: 1 });

        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data[0].schema_version, 'uc.event.v1');
        assert.deepEqual(r.data[0].labels, { app: 'claude' });
    });

    // tail is the COMMITTED log (docs: "tail reads the committed log"; received_at
    // is "Absent before commit"). A remote-emitter's pending row never reached a
    // hub — it must NOT surface in tail next to real committed facts.
    it('excludes pending (not-yet-committed) rows — tail is the committed log', async () => {
        const store = new MemoryEventStore();

        // one committed (local) + one pending (remote, undelivered)
        await emitEvent(store, emitInput({ event_id: 'evt_committed' }), { hostDefault: 'h1', localMode: true });
        await emitEvent(store, emitInput({ event_id: 'evt_pending' }), { hostDefault: 'h1', localMode: false });

        const r = await tailEvents(store, { limit: 20 });
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.deepEqual(r.data.map((e) => e.event_id), ['evt_committed']);
    });
});

describe('eventStatus', () => {
    it('reports server target, host, pending and sent counts', async () => {
        const store = new MemoryEventStore();
        await emitEvent(store, emitInput({ event_id: 'evt_p' }), { hostDefault: 'h1', localMode: false });
        await emitEvent(store, emitInput({ event_id: 'evt_c' }), { hostDefault: 'h1', localMode: true });

        const r = await eventStatus(store, { target: 'hub.example', host: 'h1' });
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.target, 'hub.example');
        assert.equal(r.data.host, 'h1');
        assert.equal(r.data.pending, 1);
        assert.equal(r.data.sent, 0);
    });
});

describe('flushPending', () => {
    // seed n pending events
    async function seedPending(store: MemoryEventStore, n: number) {
        for (let i = 0; i < n; i++) {
            await emitEvent(store, emitInput({ event_id: `evt_${i}` }), { hostDefault: 'h1', localMode: false });
        }
    }

    it('delivers every pending and marks them sent — flushed N, failed 0', async () => {
        const store = new MemoryEventStore();
        await seedPending(store, 3);

        const r = await flushPending(store, async () => true);
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.flushed, 3);
        assert.equal(r.data.failed, 0);
        const counts = await store.countByDeliveryState();
        assert.equal(counts.sent, 3);
        assert.equal(counts.pending, 0);
    });

    it('leaves a failed delivery pending — partial failure', async () => {
        const store = new MemoryEventStore();
        await seedPending(store, 3);

        // deliver fails for evt_1 only
        const r = await flushPending(store, async (json) => !JSON.parse(json).event_id.endsWith('1'));
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.flushed, 2);
        assert.equal(r.data.failed, 1);
        const counts = await store.countByDeliveryState();
        assert.equal(counts.sent, 2);
        assert.equal(counts.pending, 1);
    });

    it('flushes nothing when there are no pending events', async () => {
        const store = new MemoryEventStore();
        const r = await flushPending(store, async () => true);
        assert.equal(r.ok, true);
        if (!r.ok) return;
        assert.equal(r.data.flushed, 0);
        assert.equal(r.data.failed, 0);
    });
});
