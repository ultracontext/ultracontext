// =============================================================================
// context-client.test — the contract compiles + a conforming mock satisfies it.
// Verbs mirror the SDK: create / append / get / update / delete / list, each
// targeted verb taking an EXPLICIT context id.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ContextClient } from './context-client';

// -- conformance --------------------------------------------------------------

describe('ContextClient contract', () => {
    // a minimal in-memory mock implements every verb with the right shapes
    it('a conforming client returns the declared result shapes', async () => {
        const client: ContextClient = {
            create: async (input) => ({ id: 'ctx_root', metadata: input.metadata ?? {}, created_at: '2026-01-01T00:00:00Z' }),
            append: async (input) => ({ data: input.messages.map((m, index) => ({ ...m, id: 'm' + index, index, metadata: {} })), version: 0, id: input.id }),
            get: async () => ({ data: [], version: 0 }),
            update: async () => ({ data: [], version: 1 }),
            delete: async (input) => ({ deleted: true, id: input.id }),
            deleteMany: async (input) => ({ results: input.ids.map((id) => ({ id, deleted: true })), deleted_count: input.ids.length }),
            list: async () => ({ data: [] }),
        };

        // create returns a fresh context id + echoed metadata
        const created = await client.create({ metadata: { source: 'test' } });
        assert.equal(created.id, 'ctx_root');
        assert.equal(created.metadata.source, 'test');

        // append echoes messages back as views with id + index, plus the context id
        const appended = await client.append({ id: 'ctx_root', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(appended.data.length, 1);
        assert.equal(appended.data[0].index, 0);
        assert.equal(appended.id, 'ctx_root');

        // delete reports the removed id
        const deleted = await client.delete({ id: 'ctx_x' });
        assert.equal(deleted.deleted, true);
        assert.equal(deleted.id, 'ctx_x');

        // deleteMany reports one row per id + a deleted_count summary
        const batch = await client.deleteMany({ ids: ['ctx_a', 'ctx_b'] });
        assert.equal(batch.results.length, 2);
        assert.equal(batch.deleted_count, 2);
        assert.equal(batch.results[0].id, 'ctx_a');
    });
});
