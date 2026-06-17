import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UltraContext } from '../src/index.js'
import { materializeContext, syncDirectoryToContext } from '../src/materialize.js'
import { createUltraContextHandler } from '../src/server.js'
import { createSqliteEngine } from '../src/sqlite-engine.js'

function localFetch(handler) {
    return async (url, init = {}) => handler(new Request(url, init))
}

test('materializeContext writes artifacts to files and syncDirectoryToContext imports edits', async () => {
    const engine = createSqliteEngine({ path: ':memory:' })
    const handler = createUltraContextHandler({ engine })
    const uc = new UltraContext({
        mode: 'remote',
        baseUrl: 'https://uc.local',
        fetch: localFetch(handler)
    })
    const dir = await mkdtemp(join(tmpdir(), 'uc-materialize-'))

    const ctx = await uc.create({ metadata: { app: 'materialize' } })
    await uc.write(ctx.id, 'notes/draft.md', '# Draft', { kind: 'text/markdown' })

    const materialized = await materializeContext(uc, ctx.id, dir)
    assert.equal(materialized.data[0].path, 'notes/draft.md')
    assert.equal(await readFile(join(dir, 'notes', 'draft.md'), 'utf8'), '# Draft')

    await writeFile(join(dir, 'notes', 'draft.md'), '# Final')
    const synced = await syncDirectoryToContext(uc, ctx.id, dir)
    assert.equal(synced.data[0].path, 'notes/draft.md')

    const read = await uc.read(ctx.id, 'notes/draft.md')
    assert.equal(read.data, '# Final')
    assert.equal(read.version, 1)
})
