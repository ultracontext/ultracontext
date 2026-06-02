// =============================================================================
// context-resolver.test — the single local 'local' project, ensured against a
// real temp SQLite adapter (no server). There is no default context anymore.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteAdapter } from '@ultracontext/storage/sqlite';

import { ensureProject } from './context-resolver';
import { tempDbUrl, cleanupTempDbs } from './testing/temp-db';

after(cleanupTempDbs);

// -- project ------------------------------------------------------------------

describe('ensureProject', () => {
    // first call creates the local project; second returns the same id
    it('is idempotent — same project id across calls', async () => {
        const storage = await createSqliteAdapter(tempDbUrl());

        const first = await ensureProject(storage);
        const second = await ensureProject(storage);

        assert.equal(typeof first, 'number');
        assert.equal(first, second);
    });

    // a fresh connection to the same db reuses the existing 'local' project row
    it('reuses the local project across connections', async () => {
        const url = tempDbUrl();

        const first = await ensureProject(await createSqliteAdapter(url));
        const second = await ensureProject(await createSqliteAdapter(url));

        assert.equal(first, second);
    });
});
