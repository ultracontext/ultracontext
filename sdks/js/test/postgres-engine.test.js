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

test('postgres engine installs schema and creates session context', async () => {
    const pool = new ScriptedPool([
        { rows: [] },
        { rows: [] },
        { rows: [{ id: 1 }] },
        { rows: [{ id: 2 }] },
        { rows: [{ id: 3 }] }
    ])
    const ids = ['ses_run', 'ctx_head']
    const engine = createPostgresEngine({
        pool,
        idGenerator: prefix => ids.shift() ?? `${prefix}_x`,
        now: () => '2026-01-01T00:00:00.000Z'
    })

    await engine.install()
    const ctx = await engine.create({ metadata: { app: 'demo' } })

    assert.equal(ctx.id, 'ses_run')
    assert.deepEqual(ctx.metadata, { app: 'demo' })
    assert.match(pool.calls[0].text, /CREATE TABLE IF NOT EXISTS nodes/)
    assert.match(pool.calls[1].text, /SELECT \* FROM nodes/)
    assert.match(pool.calls[2].text, /INSERT INTO nodes/)
    assert.deepEqual(pool.calls[2].params[0], 'ws_default')
    assert.match(pool.calls[3].text, /INSERT INTO nodes/)
    assert.deepEqual(pool.calls[3].params[0], 'ses_run')
    assert.deepEqual(pool.calls[3].params[3], { app: 'demo' })
})

test('postgres engine saves and loads inline artifacts', async () => {
    const workspace = {
        id: 1,
        public_id: 'ws_project',
        kind: 'workspace',
        content: {},
        metadata: {},
        data: null,
        prev: null,
        created_at: '2026-01-01T00:00:00.000Z'
    }
    const session = {
        id: 2,
        public_id: 'ses_run',
        kind: 'session',
        content: { workspace_id: 'ws_project' },
        metadata: {},
        data: null,
        prev: null,
        owner: 1,
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
        owner: 1,
        created_at: '2026-01-01T00:00:01.000Z'
    }
    const pool = new ScriptedPool([
        { rows: [session] },
        { rows: [workspace] },
        { rows: [] },
        { rows: [artifact] },
        { rows: [artifact] },
        { rows: [session] },
        { rows: [workspace] },
        { rows: [artifact] },
        { rows: [artifact] }
    ])
    const engine = createPostgresEngine({
        pool,
        idGenerator: () => 'art_1',
        now: () => '2026-01-01T00:00:01.000Z'
    })

    const saved = await engine.save('ses_run', {
        path: 'draft.md',
        kind: 'text/markdown',
        data: '# Draft',
        metadata: { source: 'test' }
    })
    const loaded = await engine.load('ses_run', 'draft.md')

    assert.equal(saved.id, 'art_1')
    assert.equal(saved.path, 'draft.md')
    assert.equal(loaded.data, '# Draft')
    assert.equal(loaded.version, 0)
    assert.match(pool.calls[2].text, /content->>'path' = \$2/)
    assert.match(pool.calls[3].text, /RETURNING \*/)
})
