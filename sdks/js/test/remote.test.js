import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UltraContext, UltraContextError, createClient } from '../src/index.js'
import { createBrowserClient, createServerClient } from '../src/ssr.js'

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

    const created = await uc.sessions.create({ metadata: { app: 'demo' } })

    assert.equal(created.id, 'ses_abc')
    assert.equal(calls[0].url, 'https://uc.example/v2/contexts')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.authorization, 'Bearer uc_test_key')
    assert.deepEqual(JSON.parse(calls[0].init.body), { metadata: { app: 'demo' } })
})

test('createClient accepts Supabase-style base URL shorthand', async () => {
    const calls = []
    const fetch = async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({ data: [] })
    }
    const uc = createClient('https://uc.example', { fetch })

    await uc.sessions.list()

    assert.equal(uc.baseUrl, 'https://uc.example')
    assert.equal(calls[0].url, 'https://uc.example/v2/contexts')
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

    const session = await uc.sessions.get('ses_abc')
    await session.context.append({ role: 'user', content: 'hi' })
    await session.artifacts.create({ path: 'draft.md', kind: 'text/markdown', data: '# Draft' })
    const artifact = await session.artifacts.get('draft.md')

    assert.equal(artifact.data, '# Draft')
    assert.equal(calls[0].url, 'https://uc.example/v2/contexts/ses_abc/messages')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        messages: [{ role: 'user', content: 'hi' }]
    })
    assert.equal(calls[1].url, 'https://uc.example/v2/contexts/ses_abc/artifacts')
    assert.equal(calls[2].url, 'https://uc.example/v2/contexts/ses_abc/artifacts/load')
})

test('remote client supports context window operations', async () => {
    const calls = []
    const fetch = async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/history')) {
            return jsonResponse({
                data: [{ id: 'ctx_v1', session_id: 'ses_abc', version: 1, operation: 'update', created_at: 'now', current: true }]
            })
        }
        return jsonResponse({ context_id: 'ctx_v2', data: [], version: 2 })
    }
    const uc = new UltraContext({ mode: 'remote', baseUrl: 'https://uc.example', fetch })

    const session = await uc.sessions.get('ses_abc')
    const history = await session.context.history()
    await session.context.clear({ metadata: { reason: 'reset' } })
    await session.context.restore('ctx_v1', { metadata: { reason: 'time travel' } })

    assert.equal(history.data[0].id, 'ctx_v1')
    assert.equal(calls[0].url, 'https://uc.example/v2/contexts/ses_abc/history')
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[1].url, 'https://uc.example/v2/contexts/ses_abc/clear')
    assert.deepEqual(JSON.parse(calls[1].init.body), { metadata: { reason: 'reset' } })
    assert.equal(calls[2].url, 'https://uc.example/v2/contexts/ses_abc/restore')
    assert.deepEqual(JSON.parse(calls[2].init.body), {
        contextId: 'ctx_v1',
        metadata: { reason: 'time travel' }
    })
})

test('remote errors preserve UltraContext code', async () => {
    const fetch = async () => jsonResponse(
        { error: { code: 'not_found', message: 'Context not found' } },
        { status: 404 }
    )
    const uc = new UltraContext({ mode: 'remote', baseUrl: 'https://uc.example', fetch })

    await assert.rejects(
        async () => {
            const session = await uc.sessions.get('ctx_missing')
            await session.context.get()
        },
        error => {
            assert.ok(error instanceof UltraContextError)
            assert.equal(error.code, 'not_found')
            assert.equal(error.status, 404)
            assert.equal(error.message, 'Context not found')
            return true
        }
    )
})

test('remote client binds global fetch to avoid browser illegal invocation', async () => {
    const originalFetch = globalThis.fetch
    let receiver
    globalThis.fetch = async function () {
        receiver = this
        return jsonResponse({ data: [] })
    }

    try {
        const uc = new UltraContext({ baseUrl: 'https://uc.example' })
        await uc.sessions.list()
        assert.equal(receiver, globalThis)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('default client rejects local mode and stays browser-safe', () => {
    assert.throws(
        () => new UltraContext({ mode: 'local' }),
        error => {
            assert.ok(error instanceof UltraContextError)
            assert.equal(error.code, 'invalid_input')
            assert.match(error.message, /ultracontext\/local/)
            return true
        }
    )
})

test('runtime entrypoint aliases resolve to the expected clients', async () => {
    const root = await import('ultracontext')
    const browser = await import('ultracontext/browser')
    const local = await import('ultracontext/local')
    const node = await import('ultracontext/node')
    const ssr = await import('ultracontext/ssr')
    const next = await import('ultracontext/next')

    assert.equal(browser.UltraContext, root.UltraContext)
    assert.equal(browser.createClient, root.createClient)
    assert.equal(browser.createBrowserClient, ssr.createBrowserClient)
    assert.equal(node.UltraContext, local.UltraContext)
    assert.equal(node.createClient, local.createClient)
    assert.equal(node.createLocalClient, local.createLocalClient)
    assert.equal(next.createUltraContextNextHandler, ssr.createRouteHandler)
})

test('createBrowserClient returns a browser remote client', async () => {
    const calls = []
    const fetch = async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({ data: [] })
    }
    const uc = createBrowserClient('https://uc.example', { fetch })

    await uc.sessions.list()

    assert.equal(uc.mode, 'remote')
    assert.equal(calls[0].url, 'https://uc.example/v2/contexts')
})

test('createServerClient opens the local project by default', async () => {
    const root = join(tmpdir(), `uc-js-ssr-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            contentDir: '.ultracontext/blobs',
            inlineLimit: 789
        }
    }))

    const uc = await createServerClient({
        projectRoot: root,
        native: {
            UltraContextCore: class {
                constructor(path, options) {
                    this.path = path
                    this.options = options
                }

                dispatchJson() {
                    return JSON.stringify({ ok: { data: [] } })
                }
            }
        }
    })

    assert.equal(uc.mode, 'local')
    assert.equal(uc.path, join(root, '.ultracontext/ultracontext.db'))
    assert.equal(uc.contentDir, join(root, '.ultracontext/blobs'))
    assert.equal(uc.inlineLimit, 789)
    rmSync(root, { recursive: true, force: true })
})
