import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UltraContext, UltraContextError } from '../src/index.js'
import { UltraContext as LocalUltraContext } from '../src/local.js'
import { createUltraContextHandler } from '../src/server.js'
import { createSqliteEngine } from '../src/sqlite-engine.js'

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/v2-alpha.json', import.meta.url), 'utf8'))

function localFetch(handler) {
    return async (url, init = {}) => handler(new Request(url, init))
}

async function runSharedFixture(uc, { legacyContextId = false } = {}) {
    const ctx = await uc.create({ metadata: fixture.metadata })
    assert.match(ctx.id, legacyContextId ? /^(ses|ctx)_/ : /^ses_/)

    const appended = await uc.append(ctx.id, fixture.messages)
    assert.equal(appended.version, 0)
    assert.equal(appended.data.length, 2)

    const updated = await uc.update(ctx.id, fixture.message_update)
    assert.equal(updated.version, 1)
    assert.equal(updated.data[1].content, 'fixture draft ready!')
    const updatedContextId = updated.context_id

    const history = await uc.contextHistory(ctx.id)
    assert.deepEqual(history.data.map(entry => entry.operation), ['create', 'update'])
    assert.equal(history.data[1].id, updatedContextId)

    const cleared = await uc.clearContext(ctx.id, { metadata: { reason: 'reset window' } })
    assert.equal(cleared.version, 2)
    assert.equal(cleared.data.length, 0)

    const restored = await uc.restoreContext(ctx.id, updatedContextId, { metadata: { reason: 'time travel' } })
    assert.equal(restored.version, 3)
    assert.equal(restored.data[1].content, 'fixture draft ready!')

    const fork = await uc.fork(ctx.id, { version: 0, metadata: { suite: 'fork' } })
    const forked = await uc.get(fork.id, { version: 0 })
    assert.equal(forked.data[1].content, 'fixture draft ready')

    const written = await uc.write(
        ctx.id,
        fixture.artifact.path,
        fixture.artifact.initial,
        { kind: fixture.artifact.kind }
    )
    assert.equal(written.version, 0)

    await assert.rejects(
        () => uc.write(ctx.id, fixture.artifact.path, fixture.artifact.final, {
            kind: fixture.artifact.kind,
            ifVersion: written.version + 1
        }),
        error => error instanceof UltraContextError && error.code === 'conflict'
    )

    const saved = await uc.save(ctx.id, {
        id: written.id,
        path: fixture.artifact.renamed_path,
        kind: fixture.artifact.kind,
        data: fixture.artifact.final,
        ifVersion: written.version
    })
    assert.equal(saved.id, written.id)
    assert.equal(saved.version, 1)

    const old = await uc.read(ctx.id, written.id, { version: 0 })
    assert.equal(old.path, fixture.artifact.path)
    assert.equal(old.data, fixture.artifact.initial)

    const files = await uc.load(ctx.id)
    assert.equal(files.data[0].path, fixture.artifact.renamed_path)

    const listed = await uc.glob(ctx.id, 'notes/*.md')
    assert.equal(listed.data.length, 1)

    const grep = await uc.grep(ctx.id, fixture.search_query, { prefix: 'notes' })
    assert.equal(grep.data[0].kind, 'artifact')

    const search = await uc.search(fixture.search_query)
    assert.ok(search.data.some(hit => hit.kind === 'message'))

    await uc.remove(ctx.id, fixture.artifact.renamed_path, { ifVersion: saved.version })
    await assert.rejects(
        () => uc.read(ctx.id, fixture.artifact.renamed_path),
        error => error instanceof UltraContextError && error.code === 'not_found'
    )

    await assert.rejects(
        () => uc.get(fixture.missing_context),
        error => error instanceof UltraContextError && error.code === 'not_found'
    )
}

test('shared v2 alpha fixture passes through JS remote handler', async () => {
    const engine = createSqliteEngine({ path: ':memory:' })
    const handler = createUltraContextHandler({ engine })
    const uc = new UltraContext({
        mode: 'remote',
        baseUrl: 'https://uc.local',
        fetch: localFetch(handler)
    })

    await runSharedFixture(uc)
})

const triple = {
    'darwin:arm64': 'darwin-arm64',
    'darwin:x64': 'darwin-x64',
    'linux:x64': 'linux-x64-gnu',
    'linux:arm64': 'linux-arm64-gnu',
    'win32:x64': 'win32-x64-msvc'
}[`${process.platform}:${process.arch}`]

const nativePath = triple
    ? new URL(`../native/index.${triple}.node`, import.meta.url)
    : null

test('shared v2 alpha fixture passes through JS local native', { skip: !nativePath || !existsSync(nativePath) }, async () => {
    const dbPath = join(tmpdir(), `uc-js-shared-${process.pid}-${Date.now()}.db`)
    const uc = new LocalUltraContext({ path: dbPath })

    await runSharedFixture(uc, { legacyContextId: true })
})
