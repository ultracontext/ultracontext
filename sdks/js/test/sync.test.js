import assert from 'node:assert/strict'
import test from 'node:test'
import { UltraContext } from '../src/index.js'
import { createUltraContextHandler } from '../src/server.js'
import { createSqliteEngine } from '../src/sqlite-engine.js'

function clientFor(engine) {
    const handler = createUltraContextHandler({ engine })
    return new UltraContext({
        mode: 'remote',
        baseUrl: 'https://uc.local',
        fetch: async (url, init = {}) => handler(new Request(url, init))
    })
}

test('remote client can sync snapshots and incremental changes through sqlite handler', async () => {
    const source = clientFor(createSqliteEngine({ path: ':memory:' }))
    const mirror = clientFor(createSqliteEngine({ path: ':memory:' }))
    const ctx = await source.create({ metadata: { app: 'sync' } })
    await source.append(ctx.id, { content: 'base' })

    const snapshot = await source.exportSnapshot()
    const cursor = snapshot.cursor
    const snapshotImport = await mirror.importSnapshot(snapshot)
    assert.ok(snapshotImport.imported > 0)

    await source.append(ctx.id, { content: 'next' })
    await source.write(ctx.id, 'sync.md', 'synced content', { kind: 'text/markdown' })
    const changes = await source.exportChanges({ since: cursor })
    const imported = await mirror.importChanges(changes)

    assert.ok(changes.cursor > cursor)
    assert.ok(imported.imported > 0)
    assert.equal(imported.conflicts.length, 0)
    assert.equal((await mirror.get(ctx.id)).data[1].content, 'next')
    assert.equal((await mirror.read(ctx.id, 'sync.md')).data, 'synced content')

    const repeated = await mirror.importChanges(changes)
    assert.ok(repeated.skipped > 0)
    assert.equal(repeated.conflicts.length, 0)

    changes.nodes[0].public_id = 'ctx_conflicting'
    const conflict = await mirror.importChanges(changes)
    assert.equal(conflict.conflicts.length, 1)
})
