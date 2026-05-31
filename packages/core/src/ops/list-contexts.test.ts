import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { listContexts } from './list-contexts';

describe('listContexts', () => {
    it('returns empty data for a project with no contexts', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await listContexts(storage, project!.id, {});

        assert.deepEqual(result, { data: [] });
    });

    it('lists root contexts mapped to id/metadata/created_at', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const a = await seedContext(storage, project!.id, { metadata: { source: 'cli' } });
        const b = await seedContext(storage, project!.id, { metadata: { source: 'web' } });

        const result = await listContexts(storage, project!.id, {});
        const ids = result.data.map((c) => c.id);

        assert.equal(result.data.length, 2);
        assert.ok(ids.includes(a.rootId) && ids.includes(b.rootId));
        assert.ok(result.data.every((c) => 'metadata' in c && 'created_at' in c));
    });

    it('respects the limit', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        await seedContext(storage, project!.id, {});
        await seedContext(storage, project!.id, {});

        const result = await listContexts(storage, project!.id, { limit: 1 });

        assert.equal(result.data.length, 1);
    });
});
