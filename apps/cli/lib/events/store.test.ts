// =============================================================================
// store.test — openEventStore opens the SAME sqlite adapter the context verbs
// use (UC_DB_URL else ~/.ultracontext/uc.db), creating a missing parent dir.
// Drives a TEMP sqlite FILE (libsql :memory: doesn't share tables across
// connections) and asserts the returned handle is a usable EventStore.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEventStore } from './store';

// -- temp dirs ----------------------------------------------------------------

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'uc-cli-evt-store-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// -- open ---------------------------------------------------------------------

describe('openEventStore', () => {
    // opens a usable EventStore on a temp file, creating the missing parent dir
    it('opens an EventStore on a temp file, creating the parent dir', async () => {
        const dir = await tempDir();
        const dbUrl = 'file:' + join(dir, 'nested', 'uc.db');

        const store = await openEventStore(dbUrl);

        // a fresh store has no committed/pending/sent rows
        const counts = await store.countByDeliveryState();
        assert.deepEqual(counts, { committed: 0, pending: 0, sent: 0 });

        // and it round-trips an inserted row
        const { inserted } = await store.insertEvent({
            event_id: 'evt_x', kind: 'k.k.k', source: 's', subject: 'sub',
            occurred_at: new Date().toISOString(), host: 'h', privacy: 'metadata_only',
            received_at: new Date().toISOString(), delivery_state: 'committed', project_id: null,
            envelope: '{"schema_version":"uc.event.v1"}',
        });
        assert.equal(inserted, true);
    });
});
