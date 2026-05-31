import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { buildNodeInsertRecords } from '../context-chain';
import { generatePublicId } from '../public-ids';
import { getContext } from './get-context';

// -- helpers ------------------------------------------------------------------
// Seed an additional version head (update/delete) under an existing root, with
// its own message copies, mirroring what the patch/delete handlers produce.

async function addVersion(
    storage: MemoryStorage,
    projectId: number,
    rootId: string,
    prevHeadId: string,
    operation: 'update' | 'delete',
    messages: object[],
    metadata: Record<string, unknown> = {},
): Promise<string> {
    // new version head node pointing back at the prior head
    const headId = generatePublicId('context');
    await storage.insertNodes({
        public_id: headId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: prevHeadId,
        content: {},
        metadata: { operation, affected: [], ...metadata },
    });

    // message copies linked under the new head
    if (messages.length > 0) {
        const nodeInputs = messages.map((m) => ({
            type: 'message',
            content: m as Record<string, unknown>,
            metadata: {},
        }));
        const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, headId, null);
        await storage.insertNodes(insertRecords);
    }

    return headId;
}

// Force deterministic created_at on a stored node by public_id (MemoryStorage
// stamps wall-clock time on insert; timestamp-based branches need control).

function stampCreatedAt(storage: MemoryStorage, publicId: string, iso: string) {
    const node = storage.getNodesByPublicId(publicId);
    assert.ok(node, `node ${publicId} should exist`);
    node!.created_at = iso;
}

// =============================================================================
// getContext — read a context's messages with version-control semantics
// =============================================================================

describe('getContext', () => {
    // -- not found -------------------------------------------------------------

    it('returns not_found when the root context does not exist', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await getContext(storage, project!.id, 'ctx_missing', {});

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });

    it('scopes lookup to the project — another project cannot read the context', async () => {
        const storage = new MemoryStorage();
        const owner = await storage.insertProject('owner');
        const other = await storage.insertProject('other');
        const { rootId } = await seedContext(storage, owner!.id, { messages: [{ text: 'hi' }] });

        const result = await getContext(storage, other!.id, rootId, {});

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });

    // -- empty head ------------------------------------------------------------

    it('returns ok({ data: [], version: 0 }) when there is no head', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // raw root with NO head node — findHead returns null
        const rootId = generatePublicId('context');
        await storage.insertNodes({
            public_id: rootId,
            project_id: project!.id,
            type: 'context',
            context_id: null,
            parent_id: null,
            content: {},
            metadata: {},
        });

        const result = await getContext(storage, project!.id, rootId, {});

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.deepEqual(result.data.data, []);
        assert.equal(result.data.version, 0);
    });

    // -- head selection (default) ----------------------------------------------

    it('returns the head messages ordered, with index/id/metadata and version', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId, messageIds } = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }],
        });

        const result = await getContext(storage, project!.id, rootId, {});

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        // single create version → version 0
        assert.equal(result.data.version, 0);
        assert.equal(result.data.data.length, 2);
        // node order preserved + index/id/metadata spread
        assert.deepEqual(result.data.data[0], { role: 'user', text: 'a', id: messageIds[0], index: 0, metadata: {} });
        assert.deepEqual(result.data.data[1], { role: 'assistant', text: 'b', id: messageIds[1], index: 1, metadata: {} });
    });

    it('returns empty data with version 0 for a created-but-message-less head', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, {});

        const result = await getContext(storage, project!.id, rootId, {});

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.deepEqual(result.data.data, []);
        assert.equal(result.data.version, 0);
    });

    it('selects the latest head when multiple versions exist', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });
        // ensure created_at ordering: head0 < head1
        stampCreatedAt(storage, seed.headId, '2026-01-01T00:00:00.000Z');
        const head1 = await addVersion(storage, project!.id, seed.rootId, seed.headId, 'update', [{ text: 'v1' }]);
        stampCreatedAt(storage, head1, '2026-01-02T00:00:00.000Z');

        const result = await getContext(storage, project!.id, seed.rootId, {});

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        // latest version index = 1, latest head's message
        assert.equal(result.data.version, 1);
        assert.equal(result.data.data.length, 1);
        assert.equal(result.data.data[0].text, 'v1');
    });

    // -- version selection -----------------------------------------------------

    it('returns the requested version head when version is provided', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });
        stampCreatedAt(storage, seed.headId, '2026-01-01T00:00:00.000Z');
        const head1 = await addVersion(storage, project!.id, seed.rootId, seed.headId, 'update', [{ text: 'v1' }]);
        stampCreatedAt(storage, head1, '2026-01-02T00:00:00.000Z');

        const result = await getContext(storage, project!.id, seed.rootId, { version: 0 });

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.equal(result.data.version, 0);
        assert.equal(result.data.data[0].text, 'v0');
    });

    it('returns not_found for an out-of-range version index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });

        const result = await getContext(storage, project!.id, rootId, { version: 5 });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Version not found');
    });

    it('returns not_found for a negative version index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });

        const result = await getContext(storage, project!.id, rootId, { version: -1 });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Version not found');
    });

    it('returns not_found for a non-numeric version (NaN)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });

        const result = await getContext(storage, project!.id, rootId, { version: 'abc' });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Version not found');
    });

    // -- before (timestamp) selection ------------------------------------------

    it('returns invalid_input for an unparseable before timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });

        const result = await getContext(storage, project!.id, rootId, { before: 'not-a-date' });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Invalid timestamp format');
    });

    it('selects the latest version at-or-before the before timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });
        stampCreatedAt(storage, seed.headId, '2026-01-01T00:00:00.000Z');
        // stamp v0's message at-or-before the cutoff so it survives the message-level before filter
        stampCreatedAt(storage, seed.messageIds[0], '2026-01-01T00:00:00.000Z');
        const head1 = await addVersion(storage, project!.id, seed.rootId, seed.headId, 'update', [{ text: 'v1' }]);
        stampCreatedAt(storage, head1, '2026-01-05T00:00:00.000Z');

        // before falls between v0 and v1 → resolves to v0
        const result = await getContext(storage, project!.id, seed.rootId, { before: '2026-01-03T00:00:00.000Z' });

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.equal(result.data.version, 0);
        assert.equal(result.data.data[0].text, 'v0');
    });

    it('returns not_found when no version exists before the timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });
        stampCreatedAt(storage, seed.headId, '2026-01-10T00:00:00.000Z');

        const result = await getContext(storage, project!.id, seed.rootId, { before: '2026-01-01T00:00:00.000Z' });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'No version found before timestamp');
    });

    it('filters head messages to those at-or-before the before timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId, headId, messageIds } = await seedContext(storage, project!.id, {
            messages: [{ text: 'm0' }, { text: 'm1' }, { text: 'm2' }],
        });
        // head created early so it qualifies as a version before the cutoff
        stampCreatedAt(storage, headId, '2026-01-01T00:00:00.000Z');
        stampCreatedAt(storage, messageIds[0], '2026-01-02T00:00:00.000Z');
        stampCreatedAt(storage, messageIds[1], '2026-01-03T00:00:00.000Z');
        stampCreatedAt(storage, messageIds[2], '2026-01-09T00:00:00.000Z');

        // cutoff after m1 but before m2 → only first two messages remain
        const result = await getContext(storage, project!.id, rootId, { before: '2026-01-05T00:00:00.000Z' });

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.equal(result.data.data.length, 2);
        assert.deepEqual(result.data.data.map((m: any) => m.text), ['m0', 'm1']);
    });

    // -- at (index) selection --------------------------------------------------

    it('slices messages up to and including the at index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, {
            messages: [{ text: 'm0' }, { text: 'm1' }, { text: 'm2' }],
        });

        const result = await getContext(storage, project!.id, rootId, { at: 1 });

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.equal(result.data.data.length, 2);
        assert.deepEqual(result.data.data.map((m: any) => m.text), ['m0', 'm1']);
        // re-indexed from 0 within the slice
        assert.equal(result.data.data[0].index, 0);
        assert.equal(result.data.data[1].index, 1);
    });

    it('returns not_found (Index out of range) when at >= message count', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await getContext(storage, project!.id, rootId, { at: 5 });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Index out of range');
    });

    it('returns invalid_input (Invalid index) when at is negative', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await getContext(storage, project!.id, rootId, { at: -1 });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Invalid index');
    });

    it('returns invalid_input (Invalid index) when at is non-numeric (NaN)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await getContext(storage, project!.id, rootId, { at: 'xyz' });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'invalid_input');
        assert.equal(result.message, 'Invalid index');
    });

    // -- history flag ----------------------------------------------------------

    it('omits versions[] when history is not requested', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await getContext(storage, project!.id, rootId, {});

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.equal(result.data.versions, undefined);
    });

    it('includes versions[] with version/created_at/operation/affected/metadata when history requested', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0' }] });
        stampCreatedAt(storage, seed.headId, '2026-01-01T00:00:00.000Z');
        const head1 = await addVersion(storage, project!.id, seed.rootId, seed.headId, 'update', [{ text: 'v1' }], {
            note: 'edit',
        });
        stampCreatedAt(storage, head1, '2026-01-02T00:00:00.000Z');

        const result = await getContext(storage, project!.id, seed.rootId, { history: true });

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.ok(Array.isArray(result.data.versions));
        assert.equal(result.data.versions!.length, 2);
        // create version
        assert.equal(result.data.versions![0].version, 0);
        assert.equal(result.data.versions![0].operation, 'create');
        // update version carries user metadata
        assert.equal(result.data.versions![1].version, 1);
        assert.equal(result.data.versions![1].operation, 'update');
        assert.deepEqual(result.data.versions![1].metadata, { note: 'edit' });
    });

    it('includes versions[] alongside an at-sliced result', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, {
            messages: [{ text: 'm0' }, { text: 'm1' }],
        });

        const result = await getContext(storage, project!.id, rootId, { at: 0, history: true });

        assert.equal(result.ok, true);
        assert.ok(result.ok);
        assert.equal(result.data.data.length, 1);
        assert.equal(result.data.data[0].text, 'm0');
        assert.ok(Array.isArray(result.data.versions));
        assert.equal(result.data.versions!.length, 1);
    });
});
