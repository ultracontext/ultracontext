import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRouteHandler } from '../src/ssr.js'
import { createUltraContextNextHandler } from '../src/next.js'

async function readJson(response) {
    return JSON.parse(await response.text())
}

test('createRouteHandler rewrites app route prefix to protocol route', async () => {
    const calls = []
    const routes = createRouteHandler({
        engine: {
            async dispatch(operation, payload) {
                calls.push([operation, payload])
                return { id: 'ses_route', metadata: payload.metadata, created_at: 'now' }
            }
        }
    })

    const response = await routes.POST(new Request('https://app.test/api/ultracontext/v2/contexts', {
        method: 'POST',
        body: JSON.stringify({ metadata: { app: 'route' } })
    }))

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
        id: 'ses_route',
        metadata: { app: 'route' },
        created_at: 'now'
    })
    assert.deepEqual(calls, [['create', { metadata: { app: 'route' } }]])
})

test('createUltraContextNextHandler aliases the route handler for Next apps', async () => {
    const routes = createUltraContextNextHandler({
        engine: {
            async dispatch() {
                return { data: [] }
            }
        }
    })

    const response = await routes.GET(new Request('https://app.test/api/ultracontext/v2/contexts'))

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), { data: [] })
})

test('createRouteHandler opens a project from ultracontext.json', async () => {
    const root = join(tmpdir(), `uc-route-project-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, '.ultracontext'), { recursive: true })
    writeFileSync(join(root, 'ultracontext.json'), JSON.stringify({
        db: '.ultracontext/ultracontext.db',
        storage: {
            contentDir: '.ultracontext/blobs',
            inlineLimit: 64
        }
    }))

    const routes = createRouteHandler({
        projectRoot: root,
        core: {
            dispatchJson(operation, payload) {
                assert.equal(operation, 'create')
                assert.deepEqual(JSON.parse(payload), { metadata: { app: 'route-project' } })
                return JSON.stringify({
                    ok: {
                        id: 'ses_route_project',
                        metadata: { app: 'route-project' },
                        created_at: 'now'
                    }
                })
            }
        }
    })
    const response = await routes.POST(new Request('https://app.test/api/ultracontext/v2/contexts', {
        method: 'POST',
        body: JSON.stringify({ metadata: { app: 'route-project' } })
    }))
    const body = await readJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.id, 'ses_route_project')
    assert.deepEqual(body.metadata, { app: 'route-project' })
    rmSync(root, { recursive: true, force: true })
})
