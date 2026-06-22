import assert from 'node:assert/strict'
import test from 'node:test'
import { UltraContext, UltraContextError } from '../src/local.js'

class FakeCore {
    constructor(path) {
        this.path = path
        this.calls = []
    }

    dispatchJson(operation, payload) {
        const body = JSON.parse(payload)
        this.calls.push({ operation, body })
        if (operation === 'create') {
            return JSON.stringify({
                ok: {
                    id: 'ses_local',
                    metadata: body.metadata,
                    created_at: 'now'
                }
            })
        }
        if (operation === 'file_write') {
            return JSON.stringify({
                ok: {
                    id: 'art_local',
                    path: body.path,
                    kind: body.kind ?? 'text/plain',
                    version: 0
                }
            })
        }
        return JSON.stringify({
            error: { code: 'not_found', message: 'missing' }
        })
    }
}

test('local client dispatches to injected native core', async () => {
    let core
    const native = {
        UltraContextCore: class extends FakeCore {
            constructor(path) {
                super(path)
                core = this
            }
        }
    }
    const uc = new UltraContext({ path: '/tmp/uc-js.db', native })

    const ctx = await uc.sessions.create({ metadata: { app: 'demo' } })
    const artifact = await ctx.fs.write('draft.md', '# Draft', { kind: 'text/markdown' })

    assert.equal(core.path, '/tmp/uc-js.db')
    assert.equal(ctx.id, 'ses_local')
    assert.equal(artifact.id, 'art_local')
    assert.deepEqual(core.calls[0], {
        operation: 'create',
        body: { metadata: { app: 'demo' } }
    })
    assert.equal(core.calls[1].operation, 'file_write')
    assert.equal(core.calls[1].body.ctxId, 'ses_local')
    assert.equal(core.calls[1].body.path, 'draft.md')
})

test('local client preserves native error envelope', async () => {
    const uc = new UltraContext({
        native: { UltraContextCore: FakeCore }
    })

    await assert.rejects(
        async () => {
            const session = await uc.sessions.get('ctx_missing')
            await session.context.get()
        },
        error => {
            assert.ok(error instanceof UltraContextError)
            assert.equal(error.code, 'not_found')
            assert.equal(error.message, 'missing')
            return true
        }
    )
})
