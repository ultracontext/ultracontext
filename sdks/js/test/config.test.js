import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadProjectConfig, loadProjectConfigSync } from '../src/config.js'
import { UltraContext, createClient } from '../src/local.js'

test('loadProjectConfig resolves ultracontext.json relative paths', async () => {
    const root = join(tmpdir(), `uc-js-config-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            contentDir: '.ultracontext/blobs',
            inlineLimit: 123
        }
    }))

    const config = await loadProjectConfig({ projectRoot: root })

    assert.equal(config.projectRoot, root)
    assert.equal(config.db, join(root, '.ultracontext/ultracontext.db'))
    assert.equal(config.contentDir, join(root, '.ultracontext/blobs'))
    assert.equal(config.inlineLimit, 123)
    rmSync(root, { recursive: true, force: true })
})

test('loadProjectConfigSync resolves ultracontext.json relative paths', () => {
    const root = join(tmpdir(), `uc-js-config-sync-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            contentDir: '.ultracontext/blobs',
            inlineLimit: 321
        }
    }))

    const config = loadProjectConfigSync({ projectRoot: root })

    assert.equal(config.projectRoot, root)
    assert.equal(config.db, join(root, '.ultracontext/ultracontext.db'))
    assert.equal(config.contentDir, join(root, '.ultracontext/blobs'))
    assert.equal(config.inlineLimit, 321)
    rmSync(root, { recursive: true, force: true })
})

test('local createClient creates a local client from project config synchronously', () => {
    const root = join(tmpdir(), `uc-js-create-client-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            contentDir: '.ultracontext/blobs',
            inlineLimit: 654
        }
    }))

    const uc = createClient({
        projectRoot: root,
        native: {
            UltraContextCore: class {
                constructor(path, options) {
                    this.path = path
                    this.options = options
                }

                dispatchJson() {
                    return JSON.stringify({ ok: { data: [] } })
                }
            }
        }
    })

    assert.equal(uc.path, join(root, '.ultracontext/ultracontext.db'))
    assert.equal(uc.contentDir, join(root, '.ultracontext/blobs'))
    assert.equal(uc.inlineLimit, 654)
    rmSync(root, { recursive: true, force: true })
})

test('UltraContext.openProject creates a local client from project config', async () => {
    const root = join(tmpdir(), `uc-js-open-project-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            contentDir: '.ultracontext/blobs',
            inlineLimit: 456
        }
    }))

    const uc = await UltraContext.openProject({
        projectRoot: root,
        native: {
            UltraContextCore: class {
                constructor(path, options) {
                    this.path = path
                    this.options = options
                }

                dispatchJson() {
                    return JSON.stringify({ ok: { data: [] } })
                }
            }
        }
    })

    assert.equal(uc.path, join(root, '.ultracontext/ultracontext.db'))
    assert.equal(uc.contentDir, join(root, '.ultracontext/blobs'))
    assert.equal(uc.inlineLimit, 456)
    rmSync(root, { recursive: true, force: true })
})

test('UltraContext.openProject passes S3 content-store config to native core', async () => {
    const root = join(tmpdir(), `uc-js-open-project-s3-${process.pid}-${Date.now()}`)
    let nativeOptions
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            driver: 's3',
            inlineLimit: 789,
            s3: {
                endpoint: 'https://r2.example',
                bucket: 'uc',
                region: 'auto',
                accessKeyId: 'key',
                secretAccessKey: 'secret',
                prefix: 'project-a'
            }
        }
    }))

    const uc = await UltraContext.openProject({
        projectRoot: root,
        native: {
            UltraContextCore: class {
                constructor(_path, options) {
                    nativeOptions = options
                }

                dispatchJson() {
                    return JSON.stringify({ ok: { data: [] } })
                }
            }
        }
    })
    await uc.sessions.list()

    assert.equal(uc.storageDriver, 's3')
    assert.equal(uc.contentDir, undefined)
    assert.equal(uc.inlineLimit, 789)
    assert.equal(nativeOptions.inlineLimit, 789)
    assert.equal(nativeOptions.inline_limit, 789)
    assert.equal(nativeOptions.contentDir, undefined)
    assert.deepEqual(JSON.parse(nativeOptions.s3), {
        endpoint: 'https://r2.example',
        bucket: 'uc',
        region: 'auto',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        prefix: 'project-a'
    })
    rmSync(root, { recursive: true, force: true })
})
