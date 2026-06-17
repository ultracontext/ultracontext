import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostgresEngine } from '../src/postgres-engine.js'

class ScriptedPool {
    constructor(results = []) {
        this.results = [...results]
        this.calls = []
    }

    async query(text, params = []) {
        this.calls.push({ text, params })
        const result = this.results.shift()
        if (result instanceof Error) {
            throw result
        }
        return result ?? { rows: [] }
    }
}

test('postgres engine installs schema and creates context', async () => {
    const pool = new ScriptedPool([
        { rows: [] },
        { rows: [{ id: 1 }] },
        { rows: [{ id: 2 }] }
    ])
    const ids = ['ctx_root', 'ctx_head']
    const engine = createPostgresEngine({
        pool,
        idGenerator: prefix => ids.shift() ?? `${prefix}_x`,
        now: () => '2026-01-01T00:00:00.000Z'
    })

    await engine.install()
    const ctx = await engine.create({ metadata: { app: 'demo' } })

    assert.equal(ctx.id, 'ctx_root')
    assert.deepEqual(ctx.metadata, { app: 'demo' })
    assert.match(pool.calls[0].text, /CREATE TABLE IF NOT EXISTS nodes/)
    assert.match(pool.calls[1].text, /INSERT INTO nodes/)
    assert.deepEqual(pool.calls[1].params[0], 'ctx_root')
    assert.deepEqual(pool.calls[1].params[3], { app: 'demo' })
})

test('postgres engine saves and loads inline artifacts', async () => {
    const root = {
        id: 1,
        public_id: 'ctx_root',
        kind: 'context',
        content: {},
        metadata: {},
        data: null,
        prev: null,
        created_at: '2026-01-01T00:00:00.000Z'
    }
    const artifact = {
        id: 10,
        public_id: 'art_1',
        kind: 'artifact',
        content: {
            path: 'draft.md',
            kind: 'text/markdown',
            size: 7,
            sha256: 'hash',
            storage: { type: 'inline' }
        },
        metadata: { source: 'test' },
        data: '# Draft',
        prev: null,
        created_at: '2026-01-01T00:00:01.000Z'
    }
    const pool = new ScriptedPool([
        { rows: [root] },
        { rows: [] },
        { rows: [artifact] },
        { rows: [root] },
        { rows: [artifact] },
        { rows: [artifact] }
    ])
    const engine = createPostgresEngine({
        pool,
        idGenerator: () => 'art_1',
        now: () => '2026-01-01T00:00:01.000Z'
    })

    const saved = await engine.save('ctx_root', {
        path: 'draft.md',
        kind: 'text/markdown',
        data: '# Draft',
        metadata: { source: 'test' }
    })
    const loaded = await engine.load('ctx_root', 'draft.md')

    assert.equal(saved.id, 'art_1')
    assert.equal(saved.path, 'draft.md')
    assert.equal(loaded.data, '# Draft')
    assert.equal(loaded.version, 0)
    assert.match(pool.calls[1].text, /content->>'path' = \$2/)
    assert.match(pool.calls[2].text, /RETURNING \*/)
})
