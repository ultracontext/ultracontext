// =============================================================================
// context-client.test — the contract compiles + a conforming mock satisfies it.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ContextClient } from './context-client';

// -- conformance --------------------------------------------------------------

describe('ContextClient contract', () => {
    // a minimal in-memory mock implements every verb with the right shapes
    it('a conforming client returns the declared result shapes', async () => {
        const client: ContextClient = {
            add: async (input) => ({ data: input.messages.map((m, index) => ({ ...m, id: 'm' + index, index, metadata: {} })), version: 0 }),
            get: async () => ({ data: [], version: 0 }),
            update: async () => ({ data: [], version: 1 }),
            delete: async (input) => ({ deleted: true, id: input.id ?? 'root' }),
            list: async () => ({ data: [] }),
        };

        // add echoes messages back as views with id + index
        const added = await client.add({ messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(added.data.length, 1);
        assert.equal(added.data[0].index, 0);

        // delete reports the removed id
        const deleted = await client.delete({ id: 'ctx_x' });
        assert.equal(deleted.deleted, true);
        assert.equal(deleted.id, 'ctx_x');
    });
});
