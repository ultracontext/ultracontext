// =============================================================================
// remote.test — RemoteContextClient delegates the ContextClient interface to
// the @ultracontext/js SDK. The SDK is faked here (no HTTP): each verb asserts
// it calls the matching SDK method with mapped args (metadata included) and
// reshapes the response. Every targeted verb takes an explicit context id.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteClient } from './remote';
import type { UltraContext } from '@ultracontext/js';

// -- SDK fake -----------------------------------------------------------------

// a recording fake of the SDK surface the client touches — every call is logged
function fakeSdk() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const record = (method: string) => (...args: unknown[]) => {
        calls.push({ method, args });
        return Promise.resolve(responses[method]);
    };

    // canned responses keyed by SDK method name (overridable per test)
    const responses: Record<string, unknown> = {
        create: { id: 'ctx_new', metadata: { source: 'cli' }, created_at: 't0' },
        append: { data: [{ id: 'm1', index: 0, metadata: {}, role: 'user', content: 'hi' }], version: 1 },
        get: { data: [{ id: 'm1', index: 0, metadata: {}, role: 'user', content: 'hi' }], version: 1 },
        update: { data: [{ id: 'm1', index: 0, metadata: {}, role: 'user', content: 'new' }], version: 2 },
        delete: { deleted: true, id: 'ctx_42' },
    };

    // the fake exposes only the methods the client uses + the call log
    const sdk = {
        create: record('create'),
        append: record('append'),
        get: record('get'),
        update: record('update'),
        delete: record('delete'),
    } as unknown as UltraContext;

    return { sdk, calls, responses };
}

// -- create -------------------------------------------------------------------

describe('RemoteContextClient.create', () => {
    // create → SDK.create({from?, metadata?}), returning the new context
    it('creates a context via the SDK, passing metadata', async () => {
        const { sdk, calls } = fakeSdk();
        const client = createRemoteClient(sdk);

        const res = await client.create({ metadata: { source: 'cli' } });

        assert.equal(calls[0].method, 'create');
        assert.deepEqual(calls[0].args[0], { from: undefined, version: undefined, at: undefined, before: undefined, metadata: { source: 'cli' } });
        assert.equal(res.id, 'ctx_new');
        assert.equal(res.metadata.source, 'cli');
    });

    // create({from}) forks via the SDK, forwarding the source id
    it('forks via the SDK when from is given', async () => {
        const { sdk, calls } = fakeSdk();
        const client = createRemoteClient(sdk);

        await client.create({ from: 'ctx_src', version: 2 });

        assert.equal(calls[0].method, 'create');
        assert.equal((calls[0].args[0] as { from?: string }).from, 'ctx_src');
        assert.equal((calls[0].args[0] as { version?: number }).version, 2);
    });
});

// -- append -------------------------------------------------------------------

describe('RemoteContextClient.append', () => {
    // append → SDK.append(id, messages), reshaped to AppendResult
    it('appends to an explicit context via the SDK', async () => {
        const { sdk, calls } = fakeSdk();
        const client = createRemoteClient(sdk);

        const res = await client.append({ id: 'ctx_42', messages: [{ role: 'user', content: 'hi' }] });

        assert.equal(calls[0].method, 'append');
        assert.equal(calls[0].args[0], 'ctx_42');
        assert.deepEqual(calls[0].args[1], [{ role: 'user', content: 'hi' }]);
        assert.equal(res.version, 1);
        assert.equal(res.id, 'ctx_42');
    });
});

// -- get ----------------------------------------------------------------------

describe('RemoteContextClient.get', () => {
    // get → SDK.get(id, selectors), reshaped to GetResult
    it('reads an explicit context via the SDK', async () => {
        const { sdk, calls } = fakeSdk();
        const client = createRemoteClient(sdk);

        const res = await client.get({ id: 'ctx_42', version: 3, history: true });

        assert.equal(calls[0].method, 'get');
        assert.equal(calls[0].args[0], 'ctx_42');
        assert.deepEqual(calls[0].args[1], { version: 3, at: undefined, before: undefined, history: true });
        assert.equal(res.version, 1);
        assert.equal(res.data[0].content, 'hi');
    });
});

// -- update -------------------------------------------------------------------

describe('RemoteContextClient.update', () => {
    // update → SDK.update(id, updates, {metadata}), reshaped to UpdateResult
    it('patches messages via the SDK with version metadata', async () => {
        const { sdk, calls } = fakeSdk();
        const client = createRemoteClient(sdk);

        const res = await client.update({ id: 'ctx_42', updates: [{ index: 0, content: 'new' }], metadata: { e: 1 } });

        assert.equal(calls[0].method, 'update');
        assert.equal(calls[0].args[0], 'ctx_42');
        assert.deepEqual(calls[0].args[1], [{ index: 0, content: 'new' }]);
        assert.deepEqual(calls[0].args[2], { metadata: { e: 1 } });
        assert.equal(res.version, 2);
    });
});

// -- delete -------------------------------------------------------------------

describe('RemoteContextClient.delete', () => {
    // whole-context delete → SDK.delete(id, {permanent:true}), audit metadata plumbed
    it('removes a whole context via the SDK with audit metadata', async () => {
        const { sdk, calls } = fakeSdk();
        const client = createRemoteClient(sdk);

        const res = await client.delete({ id: 'ctx_42', permanent: true, metadata: { reason: 'gdpr' } });

        assert.equal(calls[0].method, 'delete');
        assert.equal(calls[0].args[0], 'ctx_42');
        assert.deepEqual(calls[0].args[1], { permanent: true, metadata: { reason: 'gdpr' } });
        assert.equal(res.deleted, true);
        assert.equal(res.id, 'ctx_42');
    });

    // message-level delete → SDK.delete(id, ids, {metadata}), version metadata plumbed
    it('removes specific messages via the SDK with version metadata', async () => {
        const { sdk, calls } = fakeSdk();
        const client = createRemoteClient(sdk);

        const res = await client.delete({ id: 'ctx_42', ids: [0, 1], metadata: { reason: 'cleanup' } });

        assert.equal(calls[0].method, 'delete');
        assert.equal(calls[0].args[0], 'ctx_42');
        assert.deepEqual(calls[0].args[1], [0, 1]);
        assert.deepEqual(calls[0].args[2], { metadata: { reason: 'cleanup' } });
        assert.equal(res.deleted, true);
        assert.equal(res.id, 'ctx_42');
    });
});

// -- list ---------------------------------------------------------------------

describe('RemoteContextClient.list', () => {
    // list → SDK.get(filters) (overloaded list form), reshaped to ListResult
    it('filters contexts via the SDK', async () => {
        const { sdk, calls, responses } = fakeSdk();
        responses.get = { data: [{ id: 'ctx_42', metadata: { project_path: '/p' }, created_at: 't0' }] };
        const client = createRemoteClient(sdk);

        const res = await client.list({ limit: 5, source: 'cli' });

        assert.equal(calls[0].method, 'get');
        assert.deepEqual(calls[0].args[0], { limit: 5, source: 'cli', project_path: undefined, session_id: undefined });
        assert.equal(res.data.length, 1);
        assert.equal(res.data[0].id, 'ctx_42');
    });
});
