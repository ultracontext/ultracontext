import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { deleteMessages } from './delete-messages';

// -- helpers ------------------------------------------------------------------
// Build a fresh project + seeded context with N messages. Returns the storage,
// projectId, root context id, and the seeded message ids so each test can pick
// targets by id or rely on positional index.

async function setup(messages: object[] = []) {
    const storage = new MemoryStorage();
    const project = await storage.insertProject('test');
    const seeded = await seedContext(storage, project!.id, { messages });
    return { storage, projectId: project!.id, ...seeded };
}

// -- input validation: ids --------------------------------------------------

describe('deleteMessages — ids validation', () => {
    it('rejects undefined ids with invalid_input', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // ids missing entirely
        const result = await deleteMessages(storage, projectId, rootId, { ids: undefined as any });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
    });

    it('rejects null ids with invalid_input', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // ids explicitly null
        const result = await deleteMessages(storage, projectId, rootId, { ids: null as any });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
    });

    it('rejects an empty array with invalid_input "ids must be a non-empty array"', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // empty ids array
        const result = await deleteMessages(storage, projectId, rootId, { ids: [] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'ids must be a non-empty array');
    });

    it('rejects a non-string, non-integer element with invalid_input', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // float index is not an integer
        const result = await deleteMessages(storage, projectId, rootId, { ids: [1.5] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Each id must be a string or integer index');
    });

    it('rejects a boolean element with invalid_input', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // non-numeric, non-string element
        const result = await deleteMessages(storage, projectId, rootId, { ids: [true as any] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Each id must be a string or integer index');
    });
});

// -- context / head resolution ------------------------------------------------

describe('deleteMessages — resolution errors', () => {
    it('returns not_found "Context not found" for an unknown context id', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // no context seeded for this id
        const result = await deleteMessages(storage, project!.id, 'context_missing', { ids: [0] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });

    it('scopes the context lookup to the project (other project not found)', async () => {
        const storage = new MemoryStorage();
        const projectA = await storage.insertProject('a');
        const projectB = await storage.insertProject('b');

        // seed under project A, then attempt delete as project B
        const seeded = await seedContext(storage, projectA!.id, { messages: [{ role: 'user', content: 'a' }] });
        const result = await deleteMessages(storage, projectB!.id, seeded.rootId, { ids: [0] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });
});

// -- target resolution: string ids -------------------------------------------

describe('deleteMessages — string id targets', () => {
    it('returns not_found "Message not found: X" for an unknown message id', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // string id that is not among the context messages
        const result = await deleteMessages(storage, projectId, rootId, { ids: ['msg_nope'] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Message not found: msg_nope');
    });

    it('deletes a message by its public id', async () => {
        const { storage, projectId, rootId, messageIds } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);

        // delete the first message by its id
        const result = await deleteMessages(storage, projectId, rootId, { ids: [messageIds[0]] });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.data.length, 1);
        assert.equal((result.data.data[0] as any).content, 'b');
    });
});

// -- target resolution: integer indices --------------------------------------

describe('deleteMessages — index targets', () => {
    it('returns invalid_input "Index out of range: X" for a too-large positive index', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // index 5 is past the single message
        const result = await deleteMessages(storage, projectId, rootId, { ids: [5] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Index out of range: 5');
    });

    it('returns invalid_input "Index out of range: X" for a negative index that wraps past 0', async () => {
        const { storage, projectId, rootId } = await setup([{ role: 'user', content: 'a' }]);

        // -2 wraps to -1 with one message -> still out of range, message preserves raw input
        const result = await deleteMessages(storage, projectId, rootId, { ids: [-2] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Index out of range: -2');
    });

    it('deletes by positive index', async () => {
        const { storage, projectId, rootId } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ]);

        // remove the middle message at index 1
        const result = await deleteMessages(storage, projectId, rootId, { ids: [1] });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.data.length, 2);
        assert.deepEqual(
            result.data.data.map((m: any) => m.content),
            ['a', 'c'],
        );
    });

    it('deletes by negative index (wraps to last message)', async () => {
        const { storage, projectId, rootId } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);

        // -1 targets the last message
        const result = await deleteMessages(storage, projectId, rootId, { ids: [-1] });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.data.length, 1);
        assert.equal((result.data.data[0] as any).content, 'a');
    });
});

// -- success shape & version semantics ----------------------------------------

describe('deleteMessages — success shape', () => {
    it('returns the remaining messages with reindexed positions and a version number', async () => {
        const { storage, projectId, rootId } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ]);

        // delete the first message, leaving b, c
        const result = await deleteMessages(storage, projectId, rootId, { ids: [0] });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // remaining messages preserve order and are reindexed from 0
        assert.equal(result.data.data.length, 2);
        assert.deepEqual(
            result.data.data.map((m: any) => m.content),
            ['b', 'c'],
        );
        assert.deepEqual(
            result.data.data.map((m: any) => m.index),
            [0, 1],
        );

        // each result row exposes a fresh id and metadata
        for (const row of result.data.data as any[]) {
            assert.equal(typeof row.id, 'string');
            assert.ok('metadata' in row);
        }

        // version advances to 1 (create=0, delete=1)
        assert.equal(result.data.version, 1);
    });

    it('deletes multiple targets in one call', async () => {
        const { storage, projectId, rootId, messageIds } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ]);

        // mix id + index targeting first and last messages
        const result = await deleteMessages(storage, projectId, rootId, { ids: [messageIds[0], 2] });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.data.length, 1);
        assert.equal((result.data.data[0] as any).content, 'b');
    });

    it('can delete every message, leaving an empty version', async () => {
        const { storage, projectId, rootId } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);

        // remove all messages by index
        const result = await deleteMessages(storage, projectId, rootId, { ids: [0, 1] });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.data.length, 0);
        assert.equal(result.data.version, 1);
    });
});

// -- copy-on-write & version head ---------------------------------------------

describe('deleteMessages — version-control semantics', () => {
    it('creates a new version head with operation=delete and affected ids', async () => {
        const { storage, projectId, rootId, messageIds } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);

        // delete one message and inspect the new head node metadata
        const result = await deleteMessages(storage, projectId, rootId, { ids: [messageIds[0]] });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        // find the freshly created delete head among version nodes
        const heads = storage
            .getAllNodes()
            .filter((n) => n.type === 'context' && n.context_id === rootId);
        const deleteHead = heads.find((h) => (h.metadata as any).operation === 'delete');

        assert.ok(deleteHead, 'expected a version head with operation=delete');
        assert.deepEqual((deleteHead!.metadata as any).affected, [messageIds[0]]);
    });

    it('merges userMetadata into the version head metadata', async () => {
        const { storage, projectId, rootId } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);

        // pass user metadata alongside the delete
        const result = await deleteMessages(storage, projectId, rootId, {
            ids: [0],
            userMetadata: { reason: 'cleanup' },
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        const deleteHead = storage
            .getAllNodes()
            .find((n) => n.type === 'context' && n.context_id === rootId && (n.metadata as any).operation === 'delete');

        assert.ok(deleteHead);
        assert.equal((deleteHead!.metadata as any).reason, 'cleanup');
        assert.equal((deleteHead!.metadata as any).operation, 'delete');
    });

    it('copies surviving messages instead of mutating originals (copy-on-write)', async () => {
        const { storage, projectId, rootId, headId, messageIds } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);

        // delete the first message
        const result = await deleteMessages(storage, projectId, rootId, { ids: [messageIds[0]] });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        // the original head's message nodes are untouched
        const originalMessages = storage.getAllNodes().filter((n) => n.context_id === headId && n.type === 'message');
        assert.equal(originalMessages.length, 2);

        // the new copies carry a parent_id back to their source nodes
        const newId = result.data.data[0].id as any;
        const copy = storage.getNodesByPublicId(newId);
        assert.ok(copy);
        assert.equal(copy!.parent_id, messageIds[1]);
    });

    it('links new message copies via prev_id in order', async () => {
        const { storage, projectId, rootId } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ]);

        // delete the middle message, leaving a -> c
        const result = await deleteMessages(storage, projectId, rootId, { ids: [1] });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        const firstId = result.data.data[0].id as any;
        const secondId = result.data.data[1].id as any;

        // first copy has no prev_id, second points back at the first
        assert.equal(storage.getNodesByPublicId(firstId)!.prev_id, null);
        assert.equal(storage.getNodesByPublicId(secondId)!.prev_id, firstId);
    });

    it('rolls back the new head when inserting filtered copies fails (internal)', async () => {
        const { storage, projectId, rootId } = await setup([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);

        // make the second insertNodes call (the filtered copies) throw
        const original = storage.insertNodes.bind(storage);
        let calls = 0;
        (storage as any).insertNodes = async (values: any) => {
            calls += 1;
            // first call = version head (allow), subsequent = filtered copies (fail)
            if (calls >= 2) throw new Error('boom');
            return original(values);
        };

        const result = await deleteMessages(storage, projectId, rootId, { ids: [0] });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'internal');

        // the orphaned delete head was rolled back
        const deleteHead = storage
            .getAllNodes()
            .find((n) => n.type === 'context' && n.context_id === rootId && (n.metadata as any).operation === 'delete');
        assert.equal(deleteHead, undefined);
    });
});
