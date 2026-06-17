import assert from 'node:assert/strict'
import test from 'node:test'
import { UltraContext } from '../src/index.js'
import { createUltraContextHandler } from '../src/server.js'
import { createSqliteEngine } from '../src/sqlite-engine.js'

function localFetch(handler) {
    return async (url, init = {}) => handler(new Request(url, init))
}

test('remote client can use handler backed by sqlite engine', async () => {
    const engine = createSqliteEngine({ path: ':memory:' })
    const handler = createUltraContextHandler({ engine })
    const uc = new UltraContext({
        mode: 'remote',
        baseUrl: 'https://uc.local',
        fetch: localFetch(handler)
    })

    const ctx = await uc.create({ metadata: { app: 'demo' } })
    await uc.append(ctx.id, [{ role: 'user', content: 'draft this' }])
    const saved = await uc.write(ctx.id, 'draft.md', '# Draft', { kind: 'text/markdown' })
    const read = await uc.read(ctx.id, 'draft.md')
    const moved = await uc.move(ctx.id, 'draft.md', 'final.md', { ifVersion: saved.version })
    const grep = await uc.grep(ctx.id, 'Draft')
    const prefixGrep = await uc.grep(ctx.id, 'Draft', { prefix: 'final' })
    const contexts = await uc.get()

    assert.equal(read.data, '# Draft')
    assert.equal(moved.id, saved.id)
    assert.equal(moved.path, 'final.md')
    assert.equal(grep.data.length, 1)
    assert.equal(grep.data[0].path, 'final.md')
    assert.equal(prefixGrep.data[0].path, 'final.md')
    assert.deepEqual(contexts.data.map(context => context.id), [ctx.id])
})
