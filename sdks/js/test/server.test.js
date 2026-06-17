import assert from 'node:assert/strict'
import test from 'node:test'
import { createUltraContextHandler } from '../src/server.js'

async function readJson(response) {
    return JSON.parse(await response.text())
}

test('handler dispatches remote protocol calls to the engine', async () => {
    const calls = []
    const engine = {
        async create(input) {
            calls.push(['create', input])
            return { id: 'ctx_abc', metadata: input.metadata, created_at: 'now' }
        },
        async append(contextId, messages) {
            calls.push(['append', contextId, messages])
            return { data: messages, version: 0 }
        },
        async load(contextId, pathOrId, options) {
            calls.push(['load', contextId, pathOrId, options])
            return { id: 'art_abc', path: pathOrId, data: '# Draft' }
        }
    }
    const handler = createUltraContextHandler({ engine })

    const createResponse = await handler(new Request('https://app.test/v2/contexts', {
        method: 'POST',
        body: JSON.stringify({ metadata: { app: 'demo' } })
    }))
    const appendResponse = await handler(new Request('https://app.test/v2/contexts/ctx_abc/messages', {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: 'hi' })
    }))
    const loadResponse = await handler(new Request('https://app.test/v2/contexts/ctx_abc/artifacts/load', {
        method: 'POST',
        body: JSON.stringify({ pathOrId: 'draft.md', version: 0 })
    }))

    assert.equal(createResponse.status, 200)
    assert.equal(appendResponse.status, 200)
    assert.equal(loadResponse.status, 200)
    assert.deepEqual(await readJson(loadResponse), { id: 'art_abc', path: 'draft.md', data: '# Draft' })
    assert.deepEqual(calls, [
        ['create', { metadata: { app: 'demo' } }],
        ['append', 'ctx_abc', [{ role: 'user', content: 'hi' }]],
        ['load', 'ctx_abc', 'draft.md', { version: 0 }]
    ])
})

test('handler serializes domain errors with status mapping', async () => {
    const engine = {
        async get() {
            const error = new Error('Context not found')
            error.code = 'not_found'
            throw error
        }
    }
    const handler = createUltraContextHandler({ engine })

    const response = await handler(new Request('https://app.test/v2/contexts/ctx_missing/get', {
        method: 'POST',
        body: '{}'
    }))

    assert.equal(response.status, 404)
    assert.deepEqual(await readJson(response), {
        error: { code: 'not_found', message: 'Context not found' }
    })
})

test('handler returns invalid_input for unknown routes', async () => {
    const handler = createUltraContextHandler({ engine: {} })

    const response = await handler(new Request('https://app.test/v2/nope', { method: 'POST' }))

    assert.equal(response.status, 404)
    assert.deepEqual(await readJson(response), {
        error: { code: 'not_found', message: 'Route not found' }
    })
})
