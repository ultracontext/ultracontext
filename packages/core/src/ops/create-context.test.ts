import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { generatePublicId } from '../public-ids';
import { buildNodeInsertRecords, findHead, getOrderedNodes } from '../context-chain';
import { createContext } from './create-context';

// -- helpers ------------------------------------------------------------------
// Append a new version head + copied message nodes onto an existing root, so
// version-selection branches can be exercised without calling sibling ops.

async function addVersion(storage: MemoryStorage, projectId: number, rootId: string, messages: object[]) {
    // create the new version head linked off the current head
    const currentHead = await findHead(storage, rootId);
    const headId = generatePublicId('context');
    await storage.insertNodes({
        public_id: headId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: currentHead ? currentHead.public_id : null,
        content: {},
        metadata: { operation: 'update' },
    });

    // copy message nodes under the new head
    const nodeInputs = messages.map((m) => ({ type: 'message', content: m as Record<string, unknown>, metadata: {} }));
    const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, headId, null);
    await storage.insertNodes(insertRecords);

    return headId;
}

// -- create-context behavior --------------------------------------------------

describe('createContext', () => {
    // -- simple create (no fork) ----------------------------------------------

    it('creates a root context and initial head with no source', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, {});

        // success result shape
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.match(result.data.id, /^ctx_/);
            assert.deepEqual(result.data.metadata, {});
            assert.equal(typeof result.data.created_at, 'string');
        }
    });

    it('persists the root node and an initial head with operation: create', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, {});
        assert.equal(result.ok, true);
        if (!result.ok) return;

        // root node exists with context_id null and parent_id null
        const root = storage.getNodesByPublicId(result.data.id);
        assert.ok(root);
        assert.equal(root!.context_id, null);
        assert.equal(root!.parent_id, null);
        assert.equal(root!.type, 'context');

        // exactly one head exists, with operation: create metadata
        const head = await findHead(storage, result.data.id);
        assert.ok(head);
        const headNode = storage.getNodesByPublicId(head!.public_id);
        assert.deepEqual(headNode!.metadata, { operation: 'create' });
    });

    it('stores provided metadata on the root node', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { metadata: { source: 'cli' } });

        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(result.data.metadata, { source: 'cli' });
        }
    });

    // -- require-from validation ----------------------------------------------

    it('rejects version without from', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { version: 0 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'version, at, and before require from');
        }
    });

    it('rejects at without from', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { at: 0 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'version, at, and before require from');
        }
    });

    it('rejects before without from', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { before: '2099-01-01T00:00:00Z' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'version, at, and before require from');
        }
    });

    // -- invalid timestamp ----------------------------------------------------
    // Timestamp parsing happens before the require-from check, so a bad
    // timestamp wins even when from is absent.

    it('rejects an unparseable before timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { from: 'ctx_whatever', before: 'not-a-date' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid timestamp format');
        }
    });

    // -- source not found -----------------------------------------------------

    it('returns not_found when the source context does not exist', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { from: 'ctx_missing' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Source context not found');
        }
    });

    // -- fork copies source nodes ---------------------------------------------

    it('forks a source context and copies its message nodes', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }],
        });

        const result = await createContext(storage, project!.id, { from: seed.rootId });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // forked root records its source via parent_id
        const root = storage.getNodesByPublicId(result.data.id);
        assert.equal(root!.parent_id, seed.rootId);

        // copied nodes match source content, in order, parented to the source nodes
        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, head!.public_id);
        assert.equal(copied.length, 2);
        assert.deepEqual(copied.map((n) => n.content), [
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
        ]);
        assert.deepEqual(copied.map((n) => n.parent_id), seed.messageIds);
    });

    it('forks a source context with zero messages (empty head)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, {});

        const result = await createContext(storage, project!.id, { from: seed.rootId });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // new head exists but holds no message nodes
        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, head!.public_id);
        assert.equal(copied.length, 0);
    });

    // -- version selection ----------------------------------------------------

    it('forks a specific version by index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0-msg' }] });
        await addVersion(storage, project!.id, seed.rootId, [{ text: 'v1-msg-a' }, { text: 'v1-msg-b' }]);

        // version 0 is the original create head — fork it
        const result = await createContext(storage, project!.id, { from: seed.rootId, version: 0 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'v0-msg' }]);
    });

    it('forks a later version by index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0-msg' }] });
        await addVersion(storage, project!.id, seed.rootId, [{ text: 'v1-msg-a' }, { text: 'v1-msg-b' }]);

        const result = await createContext(storage, project!.id, { from: seed.rootId, version: 1 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'v1-msg-a' }, { text: 'v1-msg-b' }]);
    });

    it('returns not_found for an out-of-range version index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, version: 99 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Version not found');
        }
    });

    it('returns not_found for a negative version index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, version: -1 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Version not found');
        }
    });

    it('returns not_found for a non-numeric version', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, version: 'abc' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Version not found');
        }
    });

    // -- before-timestamp version selection -----------------------------------

    it('forks the version at-or-before a timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        // a far-future cutoff includes every existing version + node
        const result = await createContext(storage, project!.id, { from: seed.rootId, before: '2099-01-01T00:00:00Z' });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'm0' }]);
    });

    it('filters copied nodes to those at-or-before the timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }, { text: 'm1' }] });

        // a far-past cutoff drops every node created after it
        const result = await createContext(storage, project!.id, { from: seed.rootId, before: '1970-01-01T00:00:00Z' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'No version found before timestamp');
        }
    });

    it('returns not_found when no version exists before the timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, before: '1971-01-01T00:00:00Z' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'No version found before timestamp');
        }
    });

    // -- at-index slicing -----------------------------------------------------

    it('slices the source nodes to the given index when forking with at', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, {
            messages: [{ text: 'm0' }, { text: 'm1' }, { text: 'm2' }],
        });

        // at=1 keeps nodes [0..1] inclusive
        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 1 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'm0' }, { text: 'm1' }]);
    });

    it('keeps only the first node when forking with at=0', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }, { text: 'm1' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 0 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'm0' }]);
    });

    it('returns invalid_input for an out-of-range at index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 5 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid index');
        }
    });

    it('returns invalid_input for a negative at index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: -1 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid index');
        }
    });

    it('returns invalid_input for a non-numeric at index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 'xyz' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid index');
        }
    });

    // -- rollback on head-creation failure ------------------------------------
    // If the initial head insert fails, the orphaned root must be removed and
    // an internal error returned.

    it('rolls back the root and returns internal when head creation fails', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // fail the SECOND insertNodes call (the head), letting the root insert succeed
        let calls = 0;
        const original = storage.insertNodes.bind(storage);
        storage.insertNodes = (async (values: any) => {
            calls += 1;
            if (calls === 2) throw new Error('boom');
            return original(values);
        }) as typeof storage.insertNodes;

        const result = await createContext(storage, project!.id, {});

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'internal');
            assert.equal(result.message, 'Failed to create context');
        }

        // the orphaned root node was rolled back
        const roots = storage.getAllNodes().filter((n) => n.type === 'context' && n.context_id === null);
        assert.equal(roots.length, 0);
    });

    // -- rollback on source-copy failure --------------------------------------
    // If copying forked nodes fails, root + head must be rolled back and an
    // internal error returned.

    it('rolls back root and head and returns internal when copying source nodes fails', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        // count inserts AFTER the seed; fail the copy-nodes insert (root, head, copy => 3rd)
        let calls = 0;
        const original = storage.insertNodes.bind(storage);
        storage.insertNodes = (async (values: any) => {
            calls += 1;
            if (calls === 3) throw new Error('boom');
            return original(values);
        }) as typeof storage.insertNodes;

        const result = await createContext(storage, project!.id, { from: seed.rootId });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'internal');
            assert.equal(result.message, 'Failed to copy source context');
        }

        // only the original seeded root remains — the forked root was rolled back
        const roots = storage.getAllNodes().filter((n) => n.type === 'context' && n.context_id === null);
        assert.deepEqual(roots.map((r) => r.public_id), [seed.rootId]);
    });
});
