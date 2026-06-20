import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadProjectConfig } from '../src/config.js'
import { UltraContext } from '../src/local.js'

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
