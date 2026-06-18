import assert from 'node:assert/strict'
import test from 'node:test'
import { UltraContext, UltraContextError } from '../src/index.js'

function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' }
    })
}

test('remote client sends fetch-only context requests', async () => {
    const calls = []
    const fetch = async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({ id: 'ses_abc', metadata: { app: 'demo' }, created_at: 'now' })
    }
    const uc = new UltraContext({
        mode: 'remote',
        apiKey: 'uc_test_key',
        baseUrl: 'https://uc.example',
        fetch
    })

    const created = await uc.create({ metadata: { app: 'demo' } })

    assert.equal(created.id, 'ses_abc')
    assert.equal(calls[0].url, 'https://uc.example/v2/contexts')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.authorization, 'Bearer uc_test_key')
    assert.deepEqual(JSON.parse(calls[0].init.body), { metadata: { app: 'demo' } })
})

test('remote client supports messages and artifacts', async () => {
    const calls = []
    const fetch = async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/messages')) {
            return jsonResponse({ data: [{ content: 'hi' }], version: 0 })
        }
        if (url.endsWith('/artifacts/load')) {
            return jsonResponse({ id: 'art_abc', path: 'draft.md', data: '# Draft', version: 0 })
        }
        return jsonResponse({ id: 'art_abc', path: 'draft.md', kind: 'text/markdown', version: 0 })
    }
    const uc = new UltraContext({ mode: 'remote', baseUrl: 'https://uc.example', fetch })

    await uc.append('ses_abc', { role: 'user', content: 'hi' })
    await uc.save('ses_abc', { path: 'draft.md', kind: 'text/markdown', data: '# Draft' })
    const artifact = await uc.load('ses_abc', 'draft.md')

    assert.equal(artifact.data, '# Draft')
    assert.equal(calls[0].url, 'https://uc.example/v2/contexts/ses_abc/messages')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        messages: [{ role: 'user', content: 'hi' }]
    })
    assert.equal(calls[1].url, 'https://uc.example/v2/contexts/ses_abc/artifacts')
    assert.equal(calls[2].url, 'https://uc.example/v2/contexts/ses_abc/artifacts/load')
})

test('remote errors preserve UltraContext code', async () => {
    const fetch = async () => jsonResponse(
        { error: { code: 'not_found', message: 'Context not found' } },
        { status: 404 }
    )
    const uc = new UltraContext({ mode: 'remote', baseUrl: 'https://uc.example', fetch })

    await assert.rejects(
        () => uc.get('ctx_missing'),
        error => {
            assert.ok(error instanceof UltraContextError)
            assert.equal(error.code, 'not_found')
            assert.equal(error.status, 404)
            assert.equal(error.message, 'Context not found')
            return true
        }
    )
})
