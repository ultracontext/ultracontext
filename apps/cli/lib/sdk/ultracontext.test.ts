// =============================================================================
// ultracontext.test — the UNIFIED UltraContext facade. ONE class exposing the
// remote SDK's public signatures, backed LOCAL (sqlite + core) or REMOTE (hosted
// API via @ultracontext/js). Selection rule: mode ?? (apiKey ? 'remote':'local').
// LOCAL covers create/append (object + ARRAY)/get (single + list)/update/delete
// (soft + permanent)/deleteMany against a TEMP sqlite db. REMOTE delegates to the
// SDK with a mock fetch (no HTTP). Local errors THROW; remote-without-key throws.
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { UltraContext, toDbUrl } from './ultracontext';
import { createLocalClient } from '../clients/local';
import { tempDbUrl, cleanupTempDbs } from '../testing/temp-db';

after(cleanupTempDbs);

// -- typed message body -------------------------------------------------------

// the content-bearing shape the data rows carry (SDK responses are generic over it)
type Msg = { content: string; role?: string };

// -- local helpers ------------------------------------------------------------

// a facade bound to a throwaway local db (tempDbUrl already carries a file: scheme,
// which the facade's toDbUrl passes through unchanged)
function localClient(): UltraContext {
    return new UltraContext({ db: tempDbUrl() });
}

// -- selection rule -----------------------------------------------------------

describe('UltraContext mode selection', () => {
    // no config → local (a local op succeeds without any key/baseUrl)
    it('defaults to local with no config', async () => {
        const uc = new UltraContext({ db: tempDbUrl() });
        const created = await uc.create();
        assert.ok(created.id.length > 0);
    });

    // an apiKey infers remote — first call hits the (mocked) hosted API, not sqlite
    it('infers remote when an apiKey is present', async () => {
        let hit = '';
        const fetchMock = async (url: string | URL): Promise<Response> => {
            hit = String(url);
            return new Response(JSON.stringify({ id: 'ctx_remote', metadata: {}, created_at: 't0' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        };
        const uc = new UltraContext({ apiKey: 'k', baseUrl: 'https://api.test', fetch: fetchMock as typeof fetch });
        const created = await uc.create();
        assert.equal(created.id, 'ctx_remote');
        assert.match(hit, /^https:\/\/api\.test\/contexts$/);
    });

    // explicit mode:'local' wins even WITH a key — never touches the network
    it("forces local with mode:'local' even when an apiKey is present", async () => {
        const fetchMock = async (): Promise<Response> => { throw new Error('network must not be touched'); };
        const uc = new UltraContext({ mode: 'local', apiKey: 'k', db: tempDbUrl(), fetch: fetchMock as typeof fetch });
        const created = await uc.create();
        assert.ok(created.id.length > 0);
    });

    // remote mode without a key → a clear throw on first call (not silent local)
    it('throws on remote without an apiKey', async () => {
        const uc = new UltraContext({ mode: 'remote' });
        await assert.rejects(() => uc.create(), /api key/i);
    });
});

// -- local backend: full verb coverage ----------------------------------------

describe('UltraContext local backend', () => {
    // create → {id, metadata, created_at}; metadata tags the context
    it('creates a context with metadata', async () => {
        const uc = localClient();
        const created = await uc.create({ metadata: { source: 'sdk' } });
        assert.ok(created.id.length > 0);
        assert.equal(created.metadata.source, 'sdk');
        assert.ok(created.created_at);
    });

    // append(id, object) → one message; AppendResponse {data, version}
    it('appends a single message object', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        const res = await uc.append<Msg>(id, { role: 'user', content: 'hi' });
        assert.equal(res.data.length, 1);
        assert.equal(typeof res.version, 'number');
        assert.equal(res.data[0].content, 'hi');
    });

    // append(id, ARRAY) → many messages in one version
    it('appends an array of messages in one version', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        const res = await uc.append<Msg>(id, [{ content: 'a' }, { content: 'b' }]);
        assert.equal(res.data.length, 2);
        assert.equal(res.data[0].index, 0);
        assert.equal(res.data[1].index, 1);
    });

    // get(id) → single-context GetResponse {data, version}
    it('gets a single context by id', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        await uc.append(id, { content: 'one' });
        const got = await uc.get<Msg>(id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'one');
        assert.equal(typeof got.version, 'number');
    });

    // get(id, {history}) → versions[] alongside the data
    it('gets a context with history', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        await uc.append(id, { content: 'x' });
        const got = await uc.get(id, { history: true });
        assert.ok(Array.isArray(got.versions));
    });

    // get() / get({filters}) → list overload: ListResponse {data:[{id,metadata,created_at}]}
    it('lists contexts via the no-id / options overload', async () => {
        const uc = localClient();
        const a = await uc.create({ metadata: { source: 'sdk' } });
        await uc.create({ metadata: { source: 'other' } });

        const all = await uc.get();
        assert.ok(all.data.some((c) => c.id === a.id));

        const filtered = await uc.get({ source: 'sdk' });
        assert.ok(filtered.data.every((c) => c.metadata.source === 'sdk'));
    });

    // a non-subset filter (user_id) is FORWARDED to the local adapter, not dropped —
    // the list narrows to only the matching context (B1: full ListContextsInput parity)
    it('forwards user_id (and other non-source filters) to the local list', async () => {
        const uc = localClient();
        const mine = await uc.create({ metadata: { user_id: 'u-me' } });
        await uc.create({ metadata: { user_id: 'u-other' } });

        const filtered = await uc.get({ user_id: 'u-me' });
        assert.deepEqual(filtered.data.map((c) => c.id), [mine.id]);
        assert.ok(filtered.data.every((c) => c.metadata.user_id === 'u-me'));
    });

    // update(id, {index, ...}) → UpdateResponse {data, version}
    it('updates a message by index', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        await uc.append(id, { content: 'old' });
        const res = await uc.update<Msg>(id, { index: 0, content: 'new' });
        assert.equal(res.data[0].content, 'new');
        assert.equal(typeof res.version, 'number');

        const got = await uc.get<Msg>(id);
        assert.equal(got.data[0].content, 'new');
    });

    // update(id, ARRAY, {metadata}) → batch update, one version
    it('updates many messages with version metadata', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        await uc.append(id, [{ content: 'a' }, { content: 'b' }]);
        const res = await uc.update<Msg>(id, [{ index: 0, content: 'A' }, { index: 1, content: 'B' }], { metadata: { reason: 'edit' } });
        assert.equal(res.data[0].content, 'A');
        assert.equal(res.data[1].content, 'B');
    });

    // delete(id, ids) → SOFT delete; parity surface is {data, version}
    it('soft-deletes messages, surfacing {data, version}', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        await uc.append(id, [{ content: 'keep' }, { content: 'drop' }]);
        const res = await uc.delete<Msg>(id, 1);
        // local parity with remote DeleteResponse: the survivors + a new version
        assert.ok(Array.isArray(res.data));
        assert.equal(res.data.map((m) => m.content).join(','), 'keep');
        assert.equal(typeof res.version, 'number');
    });

    // delete(id, {permanent:true}) → PermanentDeleteResponse {deleted, id}
    it('permanently deletes a whole context', async () => {
        const uc = localClient();
        const { id } = await uc.create();
        await uc.append(id, { content: 'bye' });
        const res = await uc.delete(id, { permanent: true });
        assert.equal(res.deleted, true);
        assert.equal(res.id, id);

        // it no longer reads back
        await assert.rejects(() => uc.get(id));
    });

    // deleteMany(ids) → loops permanent deletes; {results, deleted_count}, per-id errors captured
    it('deletes many contexts, capturing per-id errors', async () => {
        const uc = localClient();
        const a = await uc.create();
        const b = await uc.create();

        const res = await uc.deleteMany([a.id, b.id, 'ctx_missing']);
        assert.equal(res.results.length, 3);

        const ok = res.results.filter((r) => r.deleted);
        assert.equal(ok.length, 2, 'the two real contexts deleted');
        assert.equal(res.deleted_count, 2);

        // the bogus id is recorded as a failed row, not aborting the batch
        const bad = res.results.find((r) => r.id === 'ctx_missing');
        assert.equal(bad?.deleted, false);
        assert.ok(bad?.error);
    });

    // local errors THROW (parity with remote's HTTP-error throw)
    it('throws on a missing context', async () => {
        const uc = localClient();
        await assert.rejects(() => uc.get('ctx_nope'));
    });
});

// -- remote backend: delegates to @ultracontext/js via a mock fetch -----------

describe('UltraContext remote backend', () => {
    // a fetch recorder returning canned JSON keyed by method+path
    function remoteWith(handler: (req: { method: string; url: string; body?: unknown }) => unknown) {
        const calls: Array<{ method: string; url: string; body?: unknown }> = [];
        const fetchMock = async (url: string | URL, init?: RequestInit): Promise<Response> => {
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            const call = { method: init?.method ?? 'GET', url: String(url), body };
            calls.push(call);
            return new Response(JSON.stringify(handler(call)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        };
        const uc = new UltraContext({ apiKey: 'k', baseUrl: 'https://api.test', fetch: fetchMock as typeof fetch });
        return { uc, calls };
    }

    // create → POST /contexts, delegated through the SDK
    it('delegates create to the hosted API', async () => {
        const { uc, calls } = remoteWith(() => ({ id: 'ctx_r', metadata: {}, created_at: 't' }));
        const res = await uc.create({ metadata: { source: 'x' } });
        assert.equal(res.id, 'ctx_r');
        assert.equal(calls[0].method, 'POST');
        assert.match(calls[0].url, /\/contexts$/);
        assert.deepEqual((calls[0].body as { metadata: unknown }).metadata, { source: 'x' });
    });

    // append → POST /contexts/:id, body is the array passthrough
    it('delegates append (array) to the hosted API', async () => {
        const { uc, calls } = remoteWith(() => ({ data: [{ id: 'm', index: 0, metadata: {} }], version: 1 }));
        const res = await uc.append('ctx_r', [{ content: 'a' }, { content: 'b' }]);
        assert.equal(res.version, 1);
        assert.match(calls[0].url, /\/contexts\/ctx_r$/);
        assert.deepEqual(calls[0].body, [{ content: 'a' }, { content: 'b' }]);
    });

    // get(id) → GET /contexts/:id ; get() → GET /contexts (list)
    it('delegates the get single + list overloads', async () => {
        const { uc, calls } = remoteWith((req) =>
            /\/contexts\/ctx_r/.test(req.url)
                ? { data: [{ id: 'm', index: 0, metadata: {} }], version: 1 }
                : { data: [{ id: 'ctx_r', metadata: {}, created_at: 't' }] },
        );
        const single = await uc.get('ctx_r');
        assert.equal(single.version, 1);

        const list = await uc.get({ source: 'cli' });
        assert.equal(list.data[0].id, 'ctx_r');
        assert.match(calls[1].url, /source=cli/);
    });

    // delete soft (ids) → DELETE with {ids}; remote returns {data, version}
    it('delegates a soft delete returning {data, version}', async () => {
        const { uc, calls } = remoteWith(() => ({ data: [{ id: 'm', index: 0, metadata: {} }], version: 2 }));
        const res = await uc.delete('ctx_r', [0]) as { data: unknown[]; version: number };
        assert.equal(res.version, 2);
        assert.equal(calls[0].method, 'DELETE');
        assert.deepEqual((calls[0].body as { ids: unknown }).ids, [0]);
    });

    // delete permanent → DELETE with {permanent:true}; returns {deleted, id}
    it('delegates a permanent delete', async () => {
        const { uc, calls } = remoteWith(() => ({ deleted: true, id: 'ctx_r' }));
        const res = await uc.delete('ctx_r', { permanent: true }) as { deleted: boolean; id: string };
        assert.equal(res.deleted, true);
        assert.deepEqual((calls[0].body as { permanent: boolean }).permanent, true);
    });

    // deleteMany → POST /contexts/delete-many
    it('delegates deleteMany to the batch endpoint', async () => {
        const { uc, calls } = remoteWith(() => ({ results: [{ id: 'a', deleted: true }], deleted_count: 1 }));
        const res = await uc.deleteMany(['a']);
        assert.equal(res.deleted_count, 1);
        assert.match(calls[0].url, /\/contexts\/delete-many$/);
    });
});

// -- delete safety ------------------------------------------------------------

describe('UltraContext delete safety', () => {
    // an EMPTY ids array is soft-delete intent with nothing to delete — it must
    // throw loudly, never drift into the whole-context permanent-wipe branch
    it('rejects delete(id, []) and leaves the context intact', async () => {
        const uc = localClient();
        const ctx = await uc.create();
        await uc.append(ctx.id, { content: 'keep me' });

        await assert.rejects(() => uc.delete(ctx.id, []), /ids/);

        // the context and its message survive the rejected call
        const got = await uc.get<Msg>(ctx.id);
        assert.equal(got.data.length, 1);
        assert.equal(got.data[0].content, 'keep me');
    });

    // defense in depth: the local client itself refuses an empty ids list, and a
    // whole-context wipe requires an EXPLICIT permanent:true — nothing implicit
    it('local client refuses empty ids and implicit permanent deletes', async () => {
        const client = await createLocalClient({ dbUrl: tempDbUrl() });
        const ctx = await client.create({});

        await assert.rejects(() => client.delete({ id: ctx.id, ids: [] }), /ids/);
        await assert.rejects(() => client.delete({ id: ctx.id }), /permanent/);

        // the context is still readable after both rejected calls
        const got = await client.get({ id: ctx.id });
        assert.ok(Array.isArray(got.data));
    });
});

// -- db url normalization -----------------------------------------------------

describe('toDbUrl', () => {
    // bare paths get file:-prefixed; real schemes pass through; a single-letter
    // "scheme" is a Windows drive letter and must be treated as a path
    it('prefixes bare paths, passes schemes, treats drive letters as paths', () => {
        assert.equal(toDbUrl('ultracontext.db'), 'file:ultracontext.db');
        assert.equal(toDbUrl('./dir/my:db.sqlite'), 'file:./dir/my:db.sqlite');
        assert.equal(toDbUrl('file:/x/y.db'), 'file:/x/y.db');
        assert.equal(toDbUrl('libsql://host'), 'libsql://host');
        assert.equal(toDbUrl('C:\\data\\uc.db'), 'file:C:\\data\\uc.db');
    });
});
