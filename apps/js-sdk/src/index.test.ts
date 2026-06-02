// =============================================================================
// index.test — smoke coverage for the UltraContext SDK client. We inject a fake
// fetch so we can assert the client constructs and shapes the right request
// (url, method, auth header, JSON body) without any network. Light by design.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UltraContext, UltraContextHttpError } from './index';

// -- fake fetch ---------------------------------------------------------------

// a captured call: the url + the RequestInit the client passed
type Call = { url: string; init: RequestInit };

// build a fake fetch that records the call and returns a canned JSON response
function fakeFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];

    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof fetch;

    return { fetch: fetchFn, calls };
}

// -- construction -------------------------------------------------------------

describe('UltraContext', () => {
    // the client constructs and normalizes a trailing-slash baseUrl
    it('constructs and trims a trailing slash off baseUrl', async () => {
        const { fetch, calls } = fakeFetch({ data: [], version: 1 });
        const uc = new UltraContext({ apiKey: 'sk_test', baseUrl: 'https://api.example.com/', fetch });

        await uc.append('ctx_1', { role: 'user', content: 'hi' });

        // no doubled slash between the trimmed base and the path
        assert.equal(calls[0].url, 'https://api.example.com/contexts/ctx_1');
    });

    // -- request shaping ------------------------------------------------------

    // append POSTs to the context path with the bearer auth + JSON body
    it('shapes an append request (method, auth, body)', async () => {
        const { fetch, calls } = fakeFetch({ data: [{ id: 'm1', index: 0, metadata: {} }], version: 2 });
        const uc = new UltraContext({ apiKey: 'sk_live', baseUrl: 'https://api.example.com', fetch });

        const res = await uc.append('ctx_42', { role: 'user', content: 'remember this' });

        const { url, init } = calls[0];
        assert.equal(url, 'https://api.example.com/contexts/ctx_42');
        assert.equal(init.method, 'POST');

        // bearer auth carries the api key
        const headers = init.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer sk_live');
        assert.equal(headers['Content-Type'], 'application/json');

        // the body is the JSON-serialized message
        assert.deepEqual(JSON.parse(init.body as string), { role: 'user', content: 'remember this' });

        // the parsed response surfaces back to the caller
        assert.equal(res.version, 2);
    });

    // -- error mapping --------------------------------------------------------

    // a non-2xx response surfaces a typed UltraContextHttpError with the status
    it('throws UltraContextHttpError on a failed response', async () => {
        const { fetch } = fakeFetch({ error: 'nope' }, 404);
        const uc = new UltraContext({ apiKey: 'sk_test', baseUrl: 'https://api.example.com', fetch });

        await assert.rejects(
            () => uc.append('missing', { role: 'user', content: 'x' }),
            (err: unknown) => err instanceof UltraContextHttpError && err.status === 404,
        );
    });
});
