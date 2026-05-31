import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

// -- Test helpers -------------------------------------------------------------

// shape of the JSON bodies these endpoints return (kept loose for assertions)
type JsonBody = {
    id?: string;
    deleted?: boolean;
    metadata?: Record<string, unknown>;
    data: Array<{ id: string } & Record<string, unknown>>;
    version?: number;
    results: Array<{ deleted: boolean; error?: string } & Record<string, unknown>>;
    deleted_count?: number;
} & Record<string, unknown>;

// a Response whose json() resolves to the known JsonBody shape
type TestResponse = Omit<Response, 'json'> & { json(): Promise<JsonBody> };

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

async function setupTestApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage });

    // create project + API key
    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(apiKey);
    await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });

    const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };

    async function req(method: string, path: string, body?: unknown): Promise<TestResponse> {
        const init: RequestInit = { method, headers: { ...headers } };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        } else if (method === 'DELETE') {
            // No body — remove Content-Type
            init.headers = { Authorization: headers.Authorization };
        }
        return app.request(`http://localhost${path}`, init) as Promise<TestResponse>;
    }

    return { app, storage, req, headers, projectId: project!.id };
}

async function createTestContext(req: Function) {
    const res = await req('POST', '/contexts', {});
    assert.equal(res.status, 201);
    const data = await res.json();
    return data.id as string;
}

async function appendMessages(req: Function, contextId: string, messages: object[]) {
    const res = await req('POST', `/contexts/${contextId}`, messages);
    assert.equal(res.status, 201);
    return res.json();
}

// -- Tests --------------------------------------------------------------------

describe('DELETE /contexts/:id (permanent)', () => {
    it('should delete an entire context with no body', async () => {
        const { req, storage } = await setupTestApp();
        const contextId = await createTestContext(req);
        await appendMessages(req, contextId, [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
        ]);

        // verify context exists
        const getBefore = await req('GET', `/contexts/${contextId}`);
        assert.equal(getBefore.status, 200);

        // permanent delete
        const res = await req('DELETE', `/contexts/${contextId}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.deleted, true);
        assert.equal(body.id, contextId);

        // verify context is gone
        const getAfter = await req('GET', `/contexts/${contextId}`);
        assert.equal(getAfter.status, 404);
    });

    it('should return 404 for non-existent context', async () => {
        const { req } = await setupTestApp();
        const res = await req('DELETE', '/contexts/ctx_nonexistent');
        assert.equal(res.status, 404);
    });

    it('should return 400 for malformed JSON body', async () => {
        const { app, headers } = await setupTestApp();
        const contextId = await createTestContext(
            (method: string, path: string, body?: unknown) => {
                const init: RequestInit = { method, headers: { ...headers } };
                if (body !== undefined) init.body = JSON.stringify(body);
                return app.request(`http://localhost${path}`, init);
            }
        );

        // Send malformed JSON with Content-Type
        const res = await app.request(`http://localhost/contexts/${contextId}`, {
            method: 'DELETE',
            headers: { ...headers },
            body: '{invalid json',
        });
        assert.equal(res.status, 400);
    });

    it('should not leave orphan nodes after permanent delete', async () => {
        const { req, storage } = await setupTestApp();
        const contextId = await createTestContext(req);
        await appendMessages(req, contextId, [
            { role: 'user', content: 'Hello' },
        ]);

        const nodesBefore = storage.getAllNodes().length;
        assert.ok(nodesBefore > 0);

        await req('DELETE', `/contexts/${contextId}`);

        const nodesAfter = storage.getAllNodes();
        // All nodes belonging to this context should be gone
        const contextNodes = nodesAfter.filter(
            (n) => n.public_id === contextId || n.context_id === contextId
        );
        assert.equal(contextNodes.length, 0);
    });

    it('should clear parent_id on forked contexts when source is permanently deleted', async () => {
        const { req, storage } = await setupTestApp();

        // Create source context with messages
        const sourceId = await createTestContext(req);
        await appendMessages(req, sourceId, [
            { role: 'user', content: 'Original message' },
        ]);

        // Fork from source
        const forkRes = await req('POST', '/contexts', { from: sourceId });
        assert.equal(forkRes.status, 201);
        const fork = await forkRes.json();
        const forkId = fork.id as string;

        // Verify fork has parent_id pointing to source
        const forkNode = storage.getNodesByPublicId(forkId);
        assert.equal(forkNode?.parent_id, sourceId);

        // permanent delete source
        await req('DELETE', `/contexts/${sourceId}`);

        // Verify fork's parent_id was cleared (not orphaned)
        const forkNodeAfter = storage.getNodesByPublicId(forkId);
        assert.equal(forkNodeAfter?.parent_id, null);

        // Verify fork still works
        const forkGet = await req('GET', `/contexts/${forkId}`);
        assert.equal(forkGet.status, 200);
    });

    it('should reject body with unknown keys (typo-safe)', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        // {"id": "msg_x"} is a typo — developer meant {"ids": ["msg_x"]}.
        // Must 400, not silently wipe.
        const res = await req('DELETE', `/contexts/${contextId}`, { id: 'msg_x' });
        assert.equal(res.status, 400);
        // Context should still exist
        const get = await req('GET', `/contexts/${contextId}`);
        assert.equal(get.status, 200);
    });

    it('should accept explicit {permanent: true} body', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        const res = await req('DELETE', `/contexts/${contextId}`, { permanent: true });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.deleted, true);
    });

    it('should echo audit metadata on explicit permanent delete', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        const res = await req('DELETE', `/contexts/${contextId}`, {
            permanent: true,
            metadata: { reason: 'cleanup', author: 'alice' },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.metadata, { reason: 'cleanup', author: 'alice' });
    });

    it('should reject ambiguous body combining permanent and ids', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        const res = await req('DELETE', `/contexts/${contextId}`, { permanent: true, ids: ['msg_x'] });
        assert.equal(res.status, 400);
        // Context must still exist
        const get = await req('GET', `/contexts/${contextId}`);
        assert.equal(get.status, 200);
    });

    it('should reject empty ids array on soft delete', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        const res = await req('DELETE', `/contexts/${contextId}`, { ids: [] });
        assert.equal(res.status, 400);
    });

    it('should accept empty {} as permanent delete for legacy tolerance', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        const res = await req('DELETE', `/contexts/${contextId}`, {});
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.deleted, true);
    });

    it('should clear parent_id on forked message nodes when source is permanently deleted', async () => {
        const { req, storage } = await setupTestApp();

        // Create source with messages
        const sourceId = await createTestContext(req);
        const appendResult = await appendMessages(req, sourceId, [
            { role: 'user', content: 'Original' },
        ]);
        const originalMsgId = appendResult.data[0].id;

        // Fork
        const forkRes = await req('POST', '/contexts', { from: sourceId });
        const fork = await forkRes.json();
        const forkId = fork.id;

        // Get fork messages — they should have parent_id pointing to original messages
        const forkMessages = await req('GET', `/contexts/${forkId}`);
        const forkData = await forkMessages.json();
        const forkedMsgId = forkData.data[0].id;

        const forkedMsg = storage.getNodesByPublicId(forkedMsgId);
        assert.equal(forkedMsg?.parent_id, originalMsgId);

        // permanent delete source
        await req('DELETE', `/contexts/${sourceId}`);

        // Forked message's parent_id should be cleared
        const forkedMsgAfter = storage.getNodesByPublicId(forkedMsgId);
        assert.equal(forkedMsgAfter?.parent_id, null);
    });
});

describe('DELETE /contexts/:id with body (message delete)', () => {
    it('should delete messages by id', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        const appended = await appendMessages(req, contextId, [
            { role: 'user', content: 'Keep' },
            { role: 'assistant', content: 'Delete me' },
        ]);
        const msgToDelete = appended.data[1].id;

        const res = await req('DELETE', `/contexts/${contextId}`, { ids: [msgToDelete] });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.length, 1);
        assert.equal(body.version, 1);
    });

    it('should delete messages by index', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        await appendMessages(req, contextId, [
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Second' },
            { role: 'user', content: 'Third' },
        ]);

        // Delete first and last
        const res = await req('DELETE', `/contexts/${contextId}`, { ids: [0, -1] });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.length, 1);
    });

    it('should return 404 for non-existent message id', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        await appendMessages(req, contextId, [{ role: 'user', content: 'Hello' }]);

        const res = await req('DELETE', `/contexts/${contextId}`, { ids: ['msg_nonexistent'] });
        assert.equal(res.status, 404);
    });

    it('should return 400 for out of range index', async () => {
        const { req } = await setupTestApp();
        const contextId = await createTestContext(req);
        await appendMessages(req, contextId, [{ role: 'user', content: 'Hello' }]);

        const res = await req('DELETE', `/contexts/${contextId}`, { ids: [99] });
        assert.equal(res.status, 400);
    });
});

describe('POST /contexts/delete-many', () => {
    it('should delete multiple contexts', async () => {
        const { req } = await setupTestApp();
        const id1 = await createTestContext(req);
        const id2 = await createTestContext(req);
        await appendMessages(req, id1, [{ role: 'user', content: 'A' }]);
        await appendMessages(req, id2, [{ role: 'user', content: 'B' }]);

        const res = await req('POST', '/contexts/delete-many', { ids: [id1, id2] });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.results.length, 2);
        assert.ok(body.results.every((r: any) => r.deleted === true));

        // Verify both are gone
        const get1 = await req('GET', `/contexts/${id1}`);
        assert.equal(get1.status, 404);
        const get2 = await req('GET', `/contexts/${id2}`);
        assert.equal(get2.status, 404);
    });

    it('should handle partial failures gracefully', async () => {
        const { req } = await setupTestApp();
        const realId = await createTestContext(req);

        const res = await req('POST', '/contexts/delete-many', {
            ids: [realId, 'ctx_nonexistent'],
        });
        assert.equal(res.status, 207);
        const body = await res.json();
        assert.equal(body.results[0].deleted, true);
        assert.equal(body.results[1].deleted, false);
        assert.equal(body.results[1].error, 'Not found');
        assert.equal(body.deleted_count, 1);
    });

    it('should return 400 for empty ids array', async () => {
        const { req } = await setupTestApp();
        const res = await req('POST', '/contexts/delete-many', { ids: [] });
        assert.equal(res.status, 400);
    });

    it('should return 400 for missing ids field', async () => {
        const { req } = await setupTestApp();
        const res = await req('POST', '/contexts/delete-many', {});
        assert.equal(res.status, 400);
    });

    it('should return 400 for oversized ids array', async () => {
        const { req } = await setupTestApp();
        const ids = Array.from({ length: 101 }, (_, i) => `ctx_${i}`);
        const res = await req('POST', '/contexts/delete-many', { ids });
        assert.equal(res.status, 400);
    });

    it('should return 400 for non-string element in ids', async () => {
        const { req } = await setupTestApp();
        const res = await req('POST', '/contexts/delete-many', { ids: ['ctx_ok', 42] });
        assert.equal(res.status, 400);
    });

    it('should not be shadowed by POST /contexts/:id route', async () => {
        const { req } = await setupTestApp();
        // This should hit delete-many, NOT contexts/:id with id="delete-many".
        // All items fail (non-existent) → 500, but response shape proves routing.
        const res = await req('POST', '/contexts/delete-many', { ids: ['ctx_test'] });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.ok(body.results); // delete-many response shape, not append response
        assert.equal(body.results[0].error, 'Not found');
    });
});
