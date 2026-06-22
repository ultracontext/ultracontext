import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UltraContext } from '../src/index.js'
import { createRouteHandler } from '../src/ssr.js'

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

function clientFor(root) {
    const routes = createRouteHandler({ projectRoot: root })
    return new UltraContext({
        mode: 'remote',
        baseUrl: 'https://uc.local',
        fetch: async (url, init = {}) => routes.POST(new Request(url, init))
    })
}

test('remote client can sync snapshots and incremental changes through Rust-backed handler', { skip: !nativePath || !existsSync(nativePath) }, async () => {
    const sourceRoot = createProjectRoot('sync-source')
    const mirrorRoot = createProjectRoot('sync-mirror')
    const source = clientFor(sourceRoot)
    const mirror = clientFor(mirrorRoot)

    try {
        const ctx = await source.sessions.create({ metadata: { app: 'sync' } })
        await ctx.context.append({ content: 'base' })

        const snapshot = await source.sync.exportSnapshot()
        const cursor = snapshot.cursor
        const snapshotImport = await mirror.sync.importSnapshot(snapshot)
        assert.ok(snapshotImport.imported > 0)

        await ctx.context.append({ content: 'next' })
        await ctx.fs.write('sync.md', 'synced content', { kind: 'text/markdown' })
        const changes = await source.sync.exportChanges({ since: cursor })
        const imported = await mirror.sync.importChanges(changes)

        assert.ok(changes.cursor > cursor)
        assert.ok(imported.imported > 0)
        assert.equal(imported.conflicts.length, 0)
        const mirrored = await mirror.sessions.get(ctx.id)
        assert.equal((await mirrored.context.get()).data[1].content, 'next')
        assert.equal((await mirrored.fs.read('sync.md')).data, 'synced content')

        const repeated = await mirror.sync.importChanges(changes)
        assert.ok(repeated.skipped > 0)
        assert.equal(repeated.conflicts.length, 0)

        changes.nodes[0].public_id = 'ctx_conflicting'
        const conflict = await mirror.sync.importChanges(changes)
        assert.equal(conflict.conflicts.length, 1)
    } finally {
        rmSync(sourceRoot, { recursive: true, force: true })
        rmSync(mirrorRoot, { recursive: true, force: true })
    }
})
