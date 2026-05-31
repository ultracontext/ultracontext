import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from './memory-adapter';
import { listContexts } from '../ops/list-contexts';

// -- smoke test — verifies the package wires together end-to-end --------------

describe('@ultracontext/core smoke', () => {
    it('lists empty contexts for a fresh project', async () => {
        const storage = new MemoryStorage();

        // insert a project, then list its (zero) contexts
        const project = await storage.insertProject('test');
        const result = await listContexts(storage, project!.id, {});

        assert.deepEqual(result, { data: [] });
    });
});
