import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { updateMessages } from './update-messages';

// -- shared fixture — fresh project + seeded context with N messages ----------
// Returns the storage, the project id, and the seed result (root/head/message ids).

async function setup(messages: object[] = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }]) {
    const storage = new MemoryStorage();
    const project = await storage.insertProject('test');
    const seed = await seedContext(storage, project!.id, { messages });

    return { storage, projectId: project!.id, seed };
}

describe('updateMessages — body-shape validation (invalid_input)', () => {
    it('rejects a non-object/non-array body', async () => {
        const { storage, projectId, seed } = await setup();

        // parseUpdateRequestBody fails for primitives → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, 'nope' as unknown as object);

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Request body must be a JSON object or array');
    });

    it('rejects a non-object metadata field', async () => {
        const { storage, projectId, seed } = await setup();

        // metadata must be a plain object → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, { updates: [], metadata: 'x' });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'metadata must be an object');
    });

    it('rejects a non-array updates field', async () => {
        const { storage, projectId, seed } = await setup();

        // updates present but not an array → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, { updates: 'x' });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'updates must be an array');
    });
});

describe('updateMessages — per-update validation (invalid_input)', () => {
    it('rejects an update that is not an object', async () => {
        const { storage, projectId, seed } = await setup();

        // each update entry must itself be an object → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, { updates: [42] });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Each update must be an object');
    });

    it('rejects an update specifying both id and index', async () => {
        const { storage, projectId, seed } = await setup();

        // id + index are mutually exclusive → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: seed.messageIds[0], index: 0, text: 'z' }],
        });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Cannot specify both id and index');
    });

    it('rejects an update specifying neither id nor index', async () => {
        const { storage, projectId, seed } = await setup();

        // one selector is required → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, { updates: [{ text: 'z' }] });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Either id or index required');
    });

    it('rejects an id that is not a string', async () => {
        const { storage, projectId, seed } = await setup();

        // id must be a string → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, { updates: [{ id: 5, text: 'z' }] });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'id must be a string');
    });

    it('rejects an index that is not an integer', async () => {
        const { storage, projectId, seed } = await setup();

        // index must be an integer → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, { updates: [{ index: 1.5, text: 'z' }] });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'index must be an integer');
    });
});

describe('updateMessages — lookup failures', () => {
    it('returns not_found when the root context is missing', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // no context seeded → root lookup fails → not_found
        const result = await updateMessages(storage, project!.id, 'ctx_missing', { updates: [{ index: 0, text: 'z' }] });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });

    it('returns not_found when a target message id does not exist', async () => {
        const { storage, projectId, seed } = await setup();

        // id not among ordered nodes → not_found, message preserves the id
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: 'msg_ghost', text: 'z' }],
        });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Message not found: msg_ghost');
    });

    it('returns invalid_input when a positive index is out of range', async () => {
        const { storage, projectId, seed } = await setup();

        // index beyond message count → invalid_input, message preserves the index
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ index: 99, text: 'z' }],
        });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Index out of range: 99');
    });

    it('returns invalid_input when a negative index underflows past the start', async () => {
        const { storage, projectId, seed } = await setup();

        // -5 against 2 messages normalizes to -3 → still out of range → invalid_input
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ index: -5, text: 'z' }],
        });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Index out of range: -5');
    });
});

describe('updateMessages — success by id', () => {
    it('merges changes onto the targeted message and returns the new version', async () => {
        const { storage, projectId, seed } = await setup([
            { role: 'user', text: 'hello' },
            { role: 'assistant', text: 'world' },
        ]);

        // patch the first message by id
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: seed.messageIds[0], text: 'HELLO' }],
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // version advances from 0 (create) to 1 (update)
        assert.equal(result.data.version, 1);

        // every node is copied forward; only the targeted one changed
        assert.equal(result.data.data.length, 2);
        assert.equal(result.data.data[0].index, 0);
        assert.equal(result.data.data[0].role, 'user');
        assert.equal(result.data.data[0].text, 'HELLO');
        assert.equal(result.data.data[1].index, 1);
        assert.equal(result.data.data[1].text, 'world');
    });

    it('preserves untouched content fields when merging a partial update', async () => {
        const { storage, projectId, seed } = await setup([{ role: 'user', text: 'keep', tag: 'orig' }]);

        // only change text — role and tag must survive
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: seed.messageIds[0], text: 'changed' }],
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.data[0].text, 'changed');
        assert.equal(result.data.data[0].role, 'user');
        assert.equal(result.data.data[0].tag, 'orig');
    });
});

describe('updateMessages — success by index', () => {
    it('resolves a positive index to its message and updates it', async () => {
        const { storage, projectId, seed } = await setup([
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
        ]);

        // patch index 1
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ index: 1, text: 'B!' }],
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.data[1].text, 'B!');
        assert.equal(result.data.data[0].text, 'a');
    });

    it('resolves a negative index from the end', async () => {
        const { storage, projectId, seed } = await setup([
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
            { role: 'user', text: 'c' },
        ]);

        // -1 → last message
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ index: -1, text: 'C!' }],
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.data[2].text, 'C!');
        assert.equal(result.data.data[2].index, 2);
    });
});

describe('updateMessages — multiple updates in one call', () => {
    it('applies every update in a single new version', async () => {
        const { storage, projectId, seed } = await setup([
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
            { role: 'user', text: 'c' },
        ]);

        // mix id-based and index-based selectors
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [
                { id: seed.messageIds[0], text: 'A!' },
                { index: 2, text: 'C!' },
            ],
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.version, 1);
        assert.equal(result.data.data[0].text, 'A!');
        assert.equal(result.data.data[1].text, 'b');
        assert.equal(result.data.data[2].text, 'C!');
    });
});

describe('updateMessages — version-control semantics', () => {
    it('creates a new head whose metadata records operation, affected ids, and user metadata', async () => {
        const { storage, projectId, seed } = await setup([{ role: 'user', text: 'a' }]);

        // attach user metadata to the version head
        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: seed.messageIds[0], text: 'A!' }],
            metadata: { reason: 'fix typo' },
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // find the head node added by this update (operation: 'update')
        const heads = storage.getAllNodes().filter((n) => n.type === 'context' && n.context_id === seed.rootId);
        const updateHead = heads.find((n) => (n.metadata as any).operation === 'update');

        assert.ok(updateHead, 'expected an update version head');
        assert.equal((updateHead!.metadata as any).operation, 'update');
        assert.deepEqual((updateHead!.metadata as any).affected, [seed.messageIds[0]]);
        assert.equal((updateHead!.metadata as any).reason, 'fix typo');

        // the new head chains off the previous head
        assert.equal(updateHead!.prev_id, seed.headId);
    });

    it('copies messages onto the new head via copy-on-write (parent_id links to the prior node)', async () => {
        const { storage, projectId, seed } = await setup([
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
        ]);

        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ index: 0, text: 'A!' }],
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // locate the update head and its copied message nodes
        const updateHead = storage
            .getAllNodes()
            .find((n) => n.type === 'context' && n.context_id === seed.rootId && (n.metadata as any).operation === 'update');
        const copied = storage.getAllNodes().filter((n) => n.type === 'message' && n.context_id === updateHead!.public_id);

        // one copy per original message, each pointing back to its source node
        assert.equal(copied.length, 2);
        const parents = copied.map((n) => n.parent_id).sort();
        assert.deepEqual(parents, [...seed.messageIds].sort());

        // copies must be new nodes, not the originals
        for (const c of copied) {
            assert.ok(!seed.messageIds.includes(c.public_id));
        }
    });

    it('advances the version on each successive update', async () => {
        const { storage, projectId, seed } = await setup([{ role: 'user', text: 'a' }]);

        // first update → version 1
        const first = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ index: 0, text: 'v1' }],
        });
        assert.equal(first.ok, true);
        if (!first.ok) return;
        assert.equal(first.data.version, 1);

        // resolve the new head's first message id for the second update
        const v1 = first.data.data[0].id;

        // second update against the new head → version 2
        const second = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: v1, text: 'v2' }],
        });
        assert.equal(second.ok, true);
        if (!second.ok) return;
        assert.equal(second.data.version, 2);
        assert.equal(second.data.data[0].text, 'v2');
    });

    it('leaves prior versions intact (no mutation of the original message nodes)', async () => {
        const { storage, projectId, seed } = await setup([{ role: 'user', text: 'original' }]);

        await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: seed.messageIds[0], text: 'mutated' }],
        });

        // the original seeded node still holds its original content
        const original = storage.getNodesByPublicId(seed.messageIds[0]);
        assert.equal((original!.content as any).text, 'original');
    });
});

describe('updateMessages — rollback on insert failure (internal)', () => {
    it('rolls back the new head and returns internal when copying nodes fails', async () => {
        const { storage, projectId, seed } = await setup([{ role: 'user', text: 'a' }]);

        // force the message-copy insertNodes call to throw (the head insert is a single object)
        const original = storage.insertNodes.bind(storage);
        let calls = 0;
        (storage as any).insertNodes = async (values: any) => {
            calls += 1;
            if (Array.isArray(values)) throw new Error('boom');
            return original(values);
        };

        const result = await updateMessages(storage, projectId, seed.rootId, {
            updates: [{ id: seed.messageIds[0], text: 'A!' }],
        });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'Failed to update messages');

        // restore + assert the orphaned head was rolled back (no stray update head remains)
        (storage as any).insertNodes = original;
        const updateHead = storage
            .getAllNodes()
            .find((n) => n.type === 'context' && n.context_id === seed.rootId && (n.metadata as any).operation === 'update');
        assert.equal(updateHead, undefined);
    });
});
