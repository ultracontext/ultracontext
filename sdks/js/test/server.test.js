import assert from 'node:assert/strict'
import test from 'node:test'
import { createUltraContextHandler } from '../src/server.js'

async function readJson(response) {
    return JSON.parse(await response.text())
}

test('handler dispatches remote protocol calls to the engine', async () => {
    const calls = []
    const engine = {
        async dispatch(operation, payload) {
            calls.push([operation, payload])
            if (operation === 'create') {
                return { id: 'ses_abc', metadata: payload.metadata, created_at: 'now' }
            }
            if (operation === 'append') {
                return { data: payload.messages, version: 0 }
            }
            if (operation === 'context_history') {
                return { data: [{ id: 'ctx_v1', session_id: payload.ctxId, version: 1, operation: 'update', created_at: 'now', current: true }] }
            }
            if (operation === 'context_clear') {
                return { context_id: 'ctx_v2', data: [], version: 2 }
            }
            if (operation === 'context_restore') {
                return { context_id: 'ctx_v3', data: [], version: 3 }
            }
            if (operation === 'load') {
                return { id: 'art_abc', path: payload.pathOrId, data: '# Draft' }
            }
            throw new Error(`unexpected operation ${operation}`)
        }
    }
    const handler = createUltraContextHandler({ engine })

    const createResponse = await handler(new Request('https://app.test/v2/contexts', {
        method: 'POST',
        body: JSON.stringify({ metadata: { app: 'demo' } })
    }))
    const appendResponse = await handler(new Request('https://app.test/v2/contexts/ses_abc/messages', {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: 'hi' })
    }))
    const loadResponse = await handler(new Request('https://app.test/v2/contexts/ses_abc/artifacts/load', {
        method: 'POST',
        body: JSON.stringify({ pathOrId: 'draft.md', version: 0 })
    }))
    const historyResponse = await handler(new Request('https://app.test/v2/contexts/ses_abc/history'))
    const clearResponse = await handler(new Request('https://app.test/v2/contexts/ses_abc/clear', {
        method: 'POST',
        body: JSON.stringify({ metadata: { reason: 'reset' } })
    }))
    const restoreResponse = await handler(new Request('https://app.test/v2/contexts/ses_abc/restore', {
        method: 'POST',
        body: JSON.stringify({ contextId: 'ctx_v1', metadata: { reason: 'time travel' } })
    }))

    assert.equal(createResponse.status, 200)
    assert.equal(appendResponse.status, 200)
    assert.equal(loadResponse.status, 200)
    assert.equal(historyResponse.status, 200)
    assert.equal(clearResponse.status, 200)
    assert.equal(restoreResponse.status, 200)
    assert.deepEqual(await readJson(loadResponse), { id: 'art_abc', path: 'draft.md', data: '# Draft' })
    assert.deepEqual(calls, [
        ['create', { metadata: { app: 'demo' } }],
        ['append', { ctxId: 'ses_abc', messages: [{ role: 'user', content: 'hi' }] }],
        ['load', { ctxId: 'ses_abc', pathOrId: 'draft.md', version: 0 }],
        ['context_history', { ctxId: 'ses_abc' }],
        ['context_clear', { ctxId: 'ses_abc', metadata: { reason: 'reset' } }],
        ['context_restore', { ctxId: 'ses_abc', restoreContextId: 'ctx_v1', contextId: 'ctx_v1', metadata: { reason: 'time travel' } }]
    ])
})

test('handler serializes domain errors with status mapping', async () => {
    const engine = {
        async dispatch() {
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
    const handler = createUltraContextHandler({ engine: { dispatch: async () => ({}) } })

    const response = await handler(new Request('https://app.test/v2/nope', { method: 'POST' }))

    assert.equal(response.status, 404)
    assert.deepEqual(await readJson(response), {
        error: { code: 'not_found', message: 'Route not found' }
    })
})
