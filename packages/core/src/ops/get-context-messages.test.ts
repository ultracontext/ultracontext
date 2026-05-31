import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { getContextMessages } from './get-context-messages';

describe('getContextMessages', () => {
    it('returns null when the context does not exist', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await getContextMessages(storage, project!.id, 'ctx_missing');

        assert.equal(result, null);
    });

    it('returns the head messages ordered with id/index/metadata', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, {
            messages: [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'second' },
            ],
        });

        const result = await getContextMessages(storage, project!.id, rootId);

        assert.ok(result && 'data' in result);
        assert.equal(result.data.length, 2);
        assert.equal(result.data[0].index, 0);
        assert.equal(result.data[0].role, 'user');
        assert.equal(result.data[1].index, 1);
        assert.equal(result.data[1].role, 'assistant');
    });
});
