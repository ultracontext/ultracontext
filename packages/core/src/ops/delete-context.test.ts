import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { generatePublicId } from '../public-ids';
import { buildNodeInsertRecords } from '../context-chain';
import { deleteContextPermanent } from './delete-context';

// -- deleteContextPermanent — permanent (history-wiping) delete of a context --

describe('deleteContextPermanent', () => {
    // -- success: minimal context (no messages) -------------------------------

    it('deletes a freshly seeded context and returns { deleted: true, id }', async () => {
        const storage = new MemoryStorage();

        // seed a project + empty context
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // delete it permanently
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});

        // success Result with deleted flag + echoed id, no metadata key
        assert.equal(result.ok, true);
        assert.deepEqual(result.data, { deleted: true, id: rootId });
    });

    // -- success: wipes all nodes from storage --------------------------------

    it('removes the root node, head node, and all message nodes from storage', async () => {
        const storage = new MemoryStorage();

        // seed a context with three messages
        const project = await storage.insertProject('test');
        const { rootId, headId, messageIds } = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }],
        });

        // sanity: nodes exist before delete
        assert.equal(storage.getAllNodes().length, 5);

        // delete permanently
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});

        // every node tied to the context is gone
        assert.equal(result.ok, true);
        assert.equal(storage.getNodesByPublicId(rootId), null);
        assert.equal(storage.getNodesByPublicId(headId), null);
        for (const msgId of messageIds) {
            assert.equal(storage.getNodesByPublicId(msgId), null);
        }
        assert.equal(storage.getAllNodes().length, 0);
    });

    // -- success: echoes auditMetadata when provided --------------------------

    it('echoes auditMetadata into the success data when params.auditMetadata is set', async () => {
        const storage = new MemoryStorage();

        // seed a context to delete
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // delete with audit metadata
        const audit = { reason: 'gdpr', actor: 'fabio' };
        const result = await deleteContextPermanent(storage, project!.id, rootId, { auditMetadata: audit });

        // metadata is echoed verbatim alongside deleted + id
        assert.equal(result.ok, true);
        assert.deepEqual(result.data, { deleted: true, id: rootId, metadata: audit });
    });

    // -- success: omits metadata key when auditMetadata is absent -------------

    it('omits the metadata key entirely when no auditMetadata is provided', async () => {
        const storage = new MemoryStorage();

        // seed + delete without audit metadata
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});

        // no metadata key present in the returned data
        assert.equal(result.ok, true);
        assert.equal('metadata' in result.data, false);
    });

    // -- not_found: context does not exist ------------------------------------

    it('returns not_found with "Context not found" when the context is missing', async () => {
        const storage = new MemoryStorage();

        // project exists but no context seeded
        const project = await storage.insertProject('test');
        const result = await deleteContextPermanent(storage, project!.id, 'ctx_missing', {});

        // error Result mapping 404 -> not_found, preserving the exact message
        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });

    // -- not_found: context belongs to a different project --------------------

    it('returns not_found when the context belongs to another project', async () => {
        const storage = new MemoryStorage();

        // seed a context under project A
        const projectA = await storage.insertProject('a');
        const projectB = await storage.insertProject('b');
        const { rootId } = await seedContext(storage, projectA!.id);

        // attempt delete scoped to project B -> not found
        const result = await deleteContextPermanent(storage, projectB!.id, rootId, {});

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');

        // project A's nodes remain untouched
        assert.notEqual(storage.getNodesByPublicId(rootId), null);
    });

    // -- internal: transaction failure surfaces the thrown message -----------

    it('returns internal with the thrown error message when the delete transaction fails', async () => {
        const storage = new MemoryStorage();

        // seed a context to target
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // force the permanent-delete tx to throw a known error
        storage.transaction = async () => {
            throw new Error('db exploded');
        };

        // failure maps 500 -> internal, preserving the thrown message verbatim
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});
        assert.equal(result.ok, false);
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'db exploded');
    });

    // -- internal: non-Error throw falls back to default message --------------

    it('returns internal with "Failed to delete context" when a non-Error is thrown', async () => {
        const storage = new MemoryStorage();

        // seed a context to target
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // throw a non-Error value from the tx
        storage.transaction = async () => {
            throw 'boom';
        };

        // fallback message matches the route's default
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});
        assert.equal(result.ok, false);
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'Failed to delete context');
    });

    // -- tx semantics: runs inside a serializable transaction -----------------

    it('runs permanentlyDelete inside a serializable transaction', async () => {
        const storage = new MemoryStorage();

        // seed a context to delete
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // spy on the transaction options
        const original = storage.transaction.bind(storage);
        let seenOptions: unknown;
        storage.transaction = async (fn: any, options?: unknown) => {
            seenOptions = options;
            return original(fn, options as any);
        };

        // delete + assert isolation level was requested
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});
        assert.equal(result.ok, true);
        assert.deepEqual(seenOptions, { isolationLevel: 'serializable' });
    });

    // -- version-control: wipes every version head (multiple versions) --------

    it('deletes all version heads of a multi-version context', async () => {
        const storage = new MemoryStorage();

        // seed a context (head v0)
        const project = await storage.insertProject('test');
        const { rootId, headId: headV0 } = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'first' }],
        });

        // append a second version head (v1) chained off v0, mirroring an update op
        const headV1 = generatePublicId('context');
        await storage.insertNodes({
            public_id: headV1,
            project_id: project!.id,
            type: 'context',
            context_id: rootId,
            prev_id: headV0,
            content: {},
            metadata: { operation: 'update', affected: [] },
        });

        // sanity: two version heads exist
        const versionsBefore = await storage.findContextBranches(rootId);
        assert.equal(versionsBefore.length, 2);

        // delete permanently
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});

        // both version heads and the root are gone
        assert.equal(result.ok, true);
        assert.equal(storage.getNodesByPublicId(headV0), null);
        assert.equal(storage.getNodesByPublicId(headV1), null);
        assert.equal(storage.getNodesByPublicId(rootId), null);
    });

    // -- version-control: clears parent refs from forked (child) contexts -----

    it('clears parent references on forked contexts that point at the deleted root', async () => {
        const storage = new MemoryStorage();

        // seed the root context to delete
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // create a forked root context whose parent_id points at the deleted root
        const forkId = generatePublicId('context');
        await storage.insertNodes({
            public_id: forkId,
            project_id: project!.id,
            type: 'context',
            context_id: null,
            parent_id: rootId,
            content: {},
            metadata: {},
        });

        // delete the parent context permanently
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});

        // fork survives but its dangling parent_id is cleared
        assert.equal(result.ok, true);
        const fork = storage.getNodesByPublicId(forkId);
        assert.notEqual(fork, null);
        assert.equal(fork!.parent_id, null);
    });

    // -- version-control: clears message parent refs across branches ----------

    it('clears parent references on messages copied from the deleted context', async () => {
        const storage = new MemoryStorage();

        // seed a context with one message under its head
        const project = await storage.insertProject('test');
        const { rootId, messageIds } = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'origin' }],
        });
        const originMsgId = messageIds[0];

        // create a copied message in an unrelated context whose parent_id is the origin message
        const otherHead = generatePublicId('context');
        const copied = buildNodeInsertRecords(
            [{ type: 'message', content: { role: 'user', text: 'copy' }, metadata: {}, parent_id: originMsgId }],
            project!.id,
            otherHead,
            null,
        );
        await storage.insertNodes(copied);
        const copiedId = copied[0].public_id;

        // delete the origin context permanently
        const result = await deleteContextPermanent(storage, project!.id, rootId, {});

        // the copied message survives but its dangling parent ref is cleared
        assert.equal(result.ok, true);
        const copiedNode = storage.getNodesByPublicId(copiedId);
        assert.notEqual(copiedNode, null);
        assert.equal(copiedNode!.parent_id, null);
    });

    // -- version-control: leaves sibling contexts fully intact ----------------

    it('does not touch a sibling context that shares the project', async () => {
        const storage = new MemoryStorage();

        // seed two independent contexts in the same project
        const project = await storage.insertProject('test');
        const target = await seedContext(storage, project!.id, { messages: [{ role: 'user', text: 'x' }] });
        const survivor = await seedContext(storage, project!.id, { messages: [{ role: 'user', text: 'y' }] });

        // delete only the target
        const result = await deleteContextPermanent(storage, project!.id, target.rootId, {});

        // survivor's root, head, and message all remain
        assert.equal(result.ok, true);
        assert.notEqual(storage.getNodesByPublicId(survivor.rootId), null);
        assert.notEqual(storage.getNodesByPublicId(survivor.headId), null);
        assert.notEqual(storage.getNodesByPublicId(survivor.messageIds[0]), null);
    });
});
