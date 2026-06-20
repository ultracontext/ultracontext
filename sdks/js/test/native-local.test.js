import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UltraContext } from '../src/local.js'

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

test('local client can use built native binding', { skip: !nativePath || !existsSync(nativePath) }, async () => {
    const dbPath = join(tmpdir(), `uc-js-native-${process.pid}-${Date.now()}.db`)
    const uc = new UltraContext({ path: dbPath })

    const ctx = await uc.create({ metadata: { app: 'native-test' } })
    const written = await uc.write(ctx.id, 'draft.md', '# Draft', { kind: 'text/markdown' })
    const read = await uc.read(ctx.id, 'draft.md')

    assert.match(ctx.id, /^ses_/)
    assert.match(written.id, /^art_/)
    assert.equal(read.data, '# Draft')
})

test('local client can use local-dir content store options', { skip: !nativePath || !existsSync(nativePath) }, async () => {
    const suffix = `${process.pid}-${Date.now()}`
    const dbPath = join(tmpdir(), `uc-js-native-content-${suffix}.db`)
    const contentDir = join(tmpdir(), `uc-js-native-content-${suffix}`)
    const uc = new UltraContext({
        path: dbPath,
        contentDir,
        inlineLimit: 4
    })

    const ctx = await uc.create({ metadata: { app: 'native-content-test' } })
    await uc.write(ctx.id, 'large.md', 'larger than four bytes', { kind: 'text/markdown' })
    const read = await uc.read(ctx.id, 'large.md')

    assert.equal(read.data, 'larger than four bytes')
    assert.equal(read.storage.type, 'ref')
    assert.equal(read.storage.driver, 'local-dir')
    assert.ok(existsSync(join(contentDir, read.storage.key)))
})
