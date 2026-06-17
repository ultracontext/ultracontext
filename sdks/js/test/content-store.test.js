import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHybridContentStore, createLocalDirContentStore, createS3ContentStore } from '../src/content-store.js'
import { createPostgresEngine } from '../src/postgres-engine.js'
import { createSqliteEngine } from '../src/sqlite-engine.js'

class ScriptedPool {
    constructor(results = []) {
        this.results = [...results]
        this.calls = []
    }

    async query(text, params = []) {
        this.calls.push({ text, params })
        return this.results.shift() ?? { rows: [] }
    }
}

test('sqlite engine can store large artifacts in a local directory content store', async () => {
    const root = join(tmpdir(), `uc-js-content-${process.pid}-${Date.now()}`)
    const contentStore = createLocalDirContentStore({ root })
    const engine = createSqliteEngine({ path: ':memory:', contentStore, inlineLimit: 4 })

    const ctx = engine.create({ metadata: { app: 'content-store' } })
    const saved = engine.write(ctx.id, 'large.md', 'larger than four bytes', { kind: 'text/markdown' })
    const loaded = engine.read(ctx.id, 'large.md')

    assert.equal(loaded.data, 'larger than four bytes')
    assert.equal(loaded.storage.type, 'ref')
    assert.equal(loaded.storage.driver, 'local-dir')
    assert.ok(existsSync(join(root, loaded.storage.key)))

    engine.remove(ctx.id, 'large.md', { ifVersion: saved.version })
    assert.equal(existsSync(join(root, loaded.storage.key)), false)
})

test('postgres engine can use an injected S3-compatible content store', async () => {
    const objects = new Map()
    const client = {
        async putObject({ Bucket, Key, Body }) {
            objects.set(`${Bucket}/${Key}`, Body)
        },
        async getObject({ Bucket, Key }) {
            return { Body: objects.get(`${Bucket}/${Key}`) }
        },
        async deleteObject({ Bucket, Key }) {
            objects.delete(`${Bucket}/${Key}`)
        }
    }
    const contentStore = createS3ContentStore({
        client,
        bucket: 'uc-test',
        prefix: 'objects'
    })
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
    const externalArtifact = {
        id: 10,
        public_id: 'art_external',
        kind: 'artifact',
        content: {
            path: 'large.md',
            kind: 'text/markdown',
            size: 22,
            sha256: 'hash',
            storage: {
                type: 'ref',
                driver: 's3',
                bucket: 'uc-test',
                key: 'objects/art_external/v0',
                kind: 'text/markdown'
            }
        },
        metadata: {},
        data: null,
        prev: null,
        created_at: '2026-01-01T00:00:01.000Z'
    }
    const pool = new ScriptedPool([
        { rows: [root] },
        { rows: [] },
        { rows: [{ id: 10 }] },
        { rows: [root] },
        { rows: [externalArtifact] },
        { rows: [externalArtifact] }
    ])
    const engine = createPostgresEngine({
        pool,
        contentStore,
        inlineLimit: 4,
        idGenerator: prefix => prefix === 'art' ? 'art_external' : `${prefix}_x`,
        now: () => '2026-01-01T00:00:01.000Z'
    })

    const saved = await engine.save('ctx_root', {
        path: 'large.md',
        kind: 'text/markdown',
        data: 'larger than four bytes'
    })
    const loaded = await engine.load('ctx_root', 'large.md')

    assert.equal(saved.id, 'art_external')
    assert.equal(saved.version, 0)
    assert.equal(loaded.data, 'larger than four bytes')
    assert.equal(loaded.storage.driver, 's3')
    assert.equal(objects.get('uc-test/objects/art_external/v0'), 'larger than four bytes')
})

test('hybrid content store reads through local cache and remote store', async () => {
    const root = join(tmpdir(), `uc-js-hybrid-${process.pid}-${Date.now()}`)
    const cache = createLocalDirContentStore({ root })
    const objects = new Map()
    const remote = createS3ContentStore({
        bucket: 'uc-test',
        prefix: 'objects',
        client: {
            async putObject({ Bucket, Key, Body }) {
                objects.set(`${Bucket}/${Key}`, Body)
            },
            async getObject({ Bucket, Key }) {
                return { Body: objects.get(`${Bucket}/${Key}`) }
            },
            async deleteObject({ Bucket, Key }) {
                objects.delete(`${Bucket}/${Key}`)
            }
        }
    })
    const hybrid = createHybridContentStore({ cache, remote })

    const storage = await hybrid.write({
        artifactId: 'art_cached',
        version: 0,
        data: 'cached remote data',
        kind: 'text/plain'
    })
    assert.equal(storage.driver, 's3')
    assert.equal(cache.read(storage), 'cached remote data')

    cache.delete(storage)
    assert.equal(cache.exists(storage), false)

    const read = await hybrid.read(storage)
    assert.equal(read, 'cached remote data')
    assert.equal(cache.read(storage), 'cached remote data')

    await hybrid.delete(storage)
    assert.equal(cache.exists(storage), false)
    assert.equal(objects.has('uc-test/objects/art_cached/v0'), false)
})
