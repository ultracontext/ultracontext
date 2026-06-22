import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UltraContext, UltraContextError } from '../src/index.js'
import { UltraContext as LocalUltraContext } from '../src/local.js'
import { createRouteHandler } from '../src/ssr.js'

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sdk-parity.json', import.meta.url), 'utf8'))

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

const hasNative = Boolean(nativePath && existsSync(nativePath))

function localFetch(handler) {
    return async (url, init = {}) => handler(new Request(url, init))
}

function createProjectRoot(name) {
    const root = join(tmpdir(), `uc-js-${name}-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, '.ultracontext'), { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            contentDir: '.ultracontext/blobs',
            inlineLimit: 64 * 1024
        }
    }))
    return root
}

async function runSharedFixture(uc, { legacyContextId = false } = {}) {
    const ctx = await uc.sessions.create({ metadata: fixture.metadata })
    assert.match(ctx.id, legacyContextId ? /^(ses|ctx)_/ : /^ses_/)

    const appended = await ctx.context.append(fixture.messages)
    assert.equal(appended.version, 0)
    assert.equal(appended.data.length, 2)

    const updated = await ctx.context.update(fixture.message_update)
    assert.equal(updated.version, 1)
    assert.equal(updated.data[1].content, 'fixture draft ready!')
    const updatedContextId = updated.context_id

    const history = await ctx.context.history()
    assert.deepEqual(history.data.map(entry => entry.operation), ['create', 'update'])
    assert.equal(history.data[1].id, updatedContextId)

    const cleared = await ctx.context.clear({ metadata: { reason: 'reset window' } })
    assert.equal(cleared.version, 2)
    assert.equal(cleared.data.length, 0)

    const restored = await ctx.context.restore(updatedContextId, { metadata: { reason: 'time travel' } })
    assert.equal(restored.version, 3)
    assert.equal(restored.data[1].content, 'fixture draft ready!')

    const fork = await ctx.fork({ version: 0, metadata: { suite: 'fork' } })
    const forked = await fork.context.get({ version: 0 })
    assert.equal(forked.data[1].content, 'fixture draft ready')

    const written = await ctx.fs.write(
        fixture.artifact.path,
        fixture.artifact.initial,
        { kind: fixture.artifact.kind }
    )
    assert.equal(written.version, 0)

    await assert.rejects(
        () => ctx.fs.write(fixture.artifact.path, fixture.artifact.final, {
            kind: fixture.artifact.kind,
            ifVersion: written.version + 1
        }),
        error => error instanceof UltraContextError && error.code === 'conflict'
    )

    const saved = await ctx.artifacts.create({
        id: written.id,
        path: fixture.artifact.renamed_path,
        kind: fixture.artifact.kind,
        data: fixture.artifact.final,
        ifVersion: written.version
    })
    assert.equal(saved.id, written.id)
    assert.equal(saved.version, 1)

    const old = await ctx.fs.read(written.id, { version: 0 })
    assert.equal(old.path, fixture.artifact.path)
    assert.equal(old.data, fixture.artifact.initial)

    const files = await ctx.artifacts.list()
    assert.equal(files.data[0].path, fixture.artifact.renamed_path)

    const listed = await ctx.fs.glob('notes/*.md')
    assert.equal(listed.data.length, 1)

    const grep = await ctx.fs.grep(fixture.search_query, { prefix: 'notes' })
    assert.equal(grep.data[0].kind, 'artifact')

    const search = await uc.search.query(fixture.search_query)
    assert.ok(search.data.some(hit => hit.kind === 'message'))

    await ctx.fs.remove(fixture.artifact.renamed_path, { ifVersion: saved.version })
    await assert.rejects(
        () => ctx.fs.read(fixture.artifact.renamed_path),
        error => error instanceof UltraContextError && error.code === 'not_found'
    )

    await assert.rejects(
        async () => {
            const missing = await uc.sessions.get(fixture.missing_context)
            await missing.context.get()
        },
        error => error instanceof UltraContextError && error.code === 'not_found'
    )
}

test('shared sdk parity fixture passes through JS remote handler backed by Rust core', { skip: !hasNative }, async () => {
    const root = createProjectRoot('shared-remote')
    const routes = createRouteHandler({ projectRoot: root })
    const uc = new UltraContext({
        mode: 'remote',
        baseUrl: 'https://uc.local',
        fetch: localFetch(routes.POST)
    })

    try {
        await runSharedFixture(uc)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('shared sdk parity fixture passes through JS local native', { skip: !hasNative }, async () => {
    const dbPath = join(tmpdir(), `uc-js-shared-${process.pid}-${Date.now()}.db`)
    const uc = new LocalUltraContext({ path: dbPath })

    await runSharedFixture(uc, { legacyContextId: true })
})
