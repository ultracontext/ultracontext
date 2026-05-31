import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { MAX_BATCH_DELETE } from '../constants';
import { deleteManyContexts } from './delete-many';

// -- input validation — non-empty array ---------------------------------------

describe('deleteManyContexts — input validation', () => {
    it('rejects a non-array ids value as invalid_input', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // ids must be an array
        const result = await deleteManyContexts(storage, project!.id, 'not-an-array' as any);

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'ids must be a non-empty array of context IDs');
    });

    it('rejects an empty ids array as invalid_input', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // empty array is not allowed
        const result = await deleteManyContexts(storage, project!.id, []);

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'ids must be a non-empty array of context IDs');
    });

    it('rejects more than MAX_BATCH_DELETE ids as invalid_input', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // one over the batch ceiling
        const ids = Array.from({ length: MAX_BATCH_DELETE + 1 }, (_, i) => `ctx_${i}`);
        const result = await deleteManyContexts(storage, project!.id, ids);

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, `ids must contain at most ${MAX_BATCH_DELETE} items`);
    });

    it('accepts exactly MAX_BATCH_DELETE ids (boundary)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // the ceiling itself is allowed — all missing, so all Not found
        const ids = Array.from({ length: MAX_BATCH_DELETE }, (_, i) => `ctx_${i}`);
        const result = await deleteManyContexts(storage, project!.id, ids);

        assert.equal(result.ok, true);
        assert.equal(result.data.results.length, MAX_BATCH_DELETE);
        assert.equal(result.data.deleted_count, 0);
    });

    it('rejects any non-string element as invalid_input', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // a single non-string fails the whole request
        const result = await deleteManyContexts(storage, project!.id, ['ctx_a', 42, 'ctx_b'] as any);

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Each id must be a string');
    });
});

// -- per-item: missing context -------------------------------------------------

describe('deleteManyContexts — missing contexts', () => {
    it('marks an unknown id as Not found without deleting', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // no context seeded — id cannot resolve to a root
        const result = await deleteManyContexts(storage, project!.id, ['ctx_missing']);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [{ id: 'ctx_missing', deleted: false, error: 'Not found' }]);
        assert.equal(result.data.deleted_count, 0);
    });

    it('does not resolve a head/branch node as a root context', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // seed a context, then target its HEAD (non-root) id — must be Not found
        const seeded = await seedContext(storage, project!.id, { messages: [{ role: 'user', text: 'hi' }] });
        const result = await deleteManyContexts(storage, project!.id, [seeded.headId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [{ id: seeded.headId, deleted: false, error: 'Not found' }]);
        assert.equal(result.data.deleted_count, 0);
    });

    it('does not resolve a root from another project', async () => {
        const storage = new MemoryStorage();
        const projectA = await storage.insertProject('a');
        const projectB = await storage.insertProject('b');

        // root lives in project A — deleting under project B must miss
        const seeded = await seedContext(storage, projectA!.id, {});
        const result = await deleteManyContexts(storage, projectB!.id, [seeded.rootId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [{ id: seeded.rootId, deleted: false, error: 'Not found' }]);
        assert.equal(result.data.deleted_count, 0);

        // the root in project A is untouched
        assert.notEqual(storage.getNodesByPublicId(seeded.rootId), null);
    });
});

// -- per-item: successful permanent delete -------------------------------------

describe('deleteManyContexts — successful deletes', () => {
    it('permanently deletes a single context and its nodes', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // seed a context with messages, then delete it
        const seeded = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }],
        });
        const result = await deleteManyContexts(storage, project!.id, [seeded.rootId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [{ id: seeded.rootId, deleted: true }]);
        assert.equal(result.data.deleted_count, 1);

        // root, head, and message nodes are all gone
        assert.equal(storage.getNodesByPublicId(seeded.rootId), null);
        assert.equal(storage.getNodesByPublicId(seeded.headId), null);
        for (const msgId of seeded.messageIds) {
            assert.equal(storage.getNodesByPublicId(msgId), null);
        }
        assert.equal(storage.getAllNodes().length, 0);
    });

    it('deletes multiple contexts and reports a full deleted_count', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // seed two independent contexts
        const a = await seedContext(storage, project!.id, { messages: [{ text: 'a' }] });
        const b = await seedContext(storage, project!.id, { messages: [{ text: 'b' }] });
        const result = await deleteManyContexts(storage, project!.id, [a.rootId, b.rootId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [
            { id: a.rootId, deleted: true },
            { id: b.rootId, deleted: true },
        ]);
        assert.equal(result.data.deleted_count, 2);
        assert.equal(storage.getAllNodes().length, 0);
    });

    it('preserves input order in results', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // first id missing, second present — order must be preserved
        const present = await seedContext(storage, project!.id, {});
        const result = await deleteManyContexts(storage, project!.id, ['ctx_missing', present.rootId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [
            { id: 'ctx_missing', deleted: false, error: 'Not found' },
            { id: present.rootId, deleted: true },
        ]);
        assert.equal(result.data.deleted_count, 1);
    });
});

// -- version-control semantics -------------------------------------------------

describe('deleteManyContexts — version-control semantics', () => {
    it('deletes every version (head) of a context, not just the latest', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // seed a context, then add a second version head under the same root
        const seeded = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });
        await storage.insertNodes({
            public_id: 'context_v1',
            project_id: project!.id,
            type: 'context',
            context_id: seeded.rootId,
            prev_id: seeded.headId,
            content: {},
            metadata: { operation: 'update' },
        });
        await storage.insertNodes({
            public_id: 'msg_v1',
            project_id: project!.id,
            type: 'message',
            context_id: 'context_v1',
            prev_id: null,
            content: { text: 'v1' },
            metadata: {},
        });

        const result = await deleteManyContexts(storage, project!.id, [seeded.rootId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [{ id: seeded.rootId, deleted: true }]);
        assert.equal(result.data.deleted_count, 1);

        // both version heads and all their messages are gone
        assert.equal(storage.getNodesByPublicId('context_v1'), null);
        assert.equal(storage.getNodesByPublicId('msg_v1'), null);
        assert.equal(storage.getAllNodes().length, 0);
    });

    it('clears parent references from forked contexts pointing at the deleted root', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // seed a root, then a forked root whose parent_id points back at it
        const seeded = await seedContext(storage, project!.id, {});
        await storage.insertNodes({
            public_id: 'context_fork',
            project_id: project!.id,
            type: 'context',
            context_id: null,
            parent_id: seeded.rootId,
            content: {},
            metadata: { operation: 'create' },
        });

        const result = await deleteManyContexts(storage, project!.id, [seeded.rootId]);

        assert.equal(result.ok, true);
        assert.equal(result.data.deleted_count, 1);

        // the fork survives, but its parent reference to the deleted root is cleared
        const fork = storage.getNodesByPublicId('context_fork');
        assert.notEqual(fork, null);
        assert.equal(fork!.parent_id, null);
    });
});

// -- per-item: transaction failure ---------------------------------------------

describe('deleteManyContexts — failures and partial results', () => {
    it('reports the thrown error message for a failed delete', async () => {
        const project = { id: 1 };

        // storage whose delete throws during the transaction
        class FailingStorage extends MemoryStorage {
            async deleteNodeByPublicId(): Promise<void> {
                throw new Error('boom');
            }
        }
        const storage = new FailingStorage();
        const seeded = await seedContext(storage, project.id, {});

        const result = await deleteManyContexts(storage, project.id, [seeded.rootId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [{ id: seeded.rootId, deleted: false, error: 'boom' }]);
        assert.equal(result.data.deleted_count, 0);
    });

    it('uses "Unknown error" when a non-Error value is thrown', async () => {
        const project = { id: 1 };

        // storage that throws a non-Error value
        class WeirdFailingStorage extends MemoryStorage {
            async deleteNodeByPublicId(): Promise<void> {
                throw 'string-failure';
            }
        }
        const storage = new WeirdFailingStorage();
        const seeded = await seedContext(storage, project.id, {});

        const result = await deleteManyContexts(storage, project.id, [seeded.rootId]);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [{ id: seeded.rootId, deleted: false, error: 'Unknown error' }]);
        assert.equal(result.data.deleted_count, 0);
    });

    it('mixes success, missing, and failure in one batch (partial result)', async () => {
        const project = { id: 1 };

        // delete throws only for one specific root id
        class SelectiveFailingStorage extends MemoryStorage {
            async deleteNodeByPublicId(projectId: number, publicId: string): Promise<void> {
                if (publicId === this.poisonId) throw new Error('cannot delete');
                return super.deleteNodeByPublicId(projectId, publicId);
            }
            poisonId = '';
        }
        const storage = new SelectiveFailingStorage();

        // one deletable, one poisoned, one missing
        const good = await seedContext(storage, project.id, {});
        const bad = await seedContext(storage, project.id, {});
        storage.poisonId = bad.rootId;

        const result = await deleteManyContexts(storage, project.id, [good.rootId, bad.rootId, 'ctx_missing']);

        assert.equal(result.ok, true);
        assert.deepEqual(result.data.results, [
            { id: good.rootId, deleted: true },
            { id: bad.rootId, deleted: false, error: 'cannot delete' },
            { id: 'ctx_missing', deleted: false, error: 'Not found' },
        ]);
        assert.equal(result.data.deleted_count, 1);

        // the good context is gone; the bad context's root survives
        assert.equal(storage.getNodesByPublicId(good.rootId), null);
        assert.notEqual(storage.getNodesByPublicId(bad.rootId), null);
    });

    it('always returns ok even when every item fails', async () => {
        const project = { id: 1 };

        // every delete throws — handler still returns ok({results, deleted_count})
        class FailingStorage extends MemoryStorage {
            async deleteNodeByPublicId(): Promise<void> {
                throw new Error('nope');
            }
        }
        const storage = new FailingStorage();
        const a = await seedContext(storage, project.id, {});
        const b = await seedContext(storage, project.id, {});

        const result = await deleteManyContexts(storage, project.id, [a.rootId, b.rootId]);

        assert.equal(result.ok, true);
        assert.equal(result.data.deleted_count, 0);
        assert.equal(result.data.results.length, 2);
        assert.ok(result.data.results.every((r) => r.deleted === false && r.error === 'nope'));
    });
});
