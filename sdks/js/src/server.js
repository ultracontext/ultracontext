const STATUS_BY_CODE = {
    not_found: 404,
    invalid_input: 400,
    conflict: 409,
    busy: 503,
    incompatible_db: 500,
    internal: 500
}

export { createServerClient } from './ssr.js'

export function createUltraContextHandler({ engine }) {
    if (!engine) {
        throw new Error('createUltraContextHandler requires an engine')
    }

    return async function ultraContextHandler(request) {
        if (request.method === 'OPTIONS') {
            return json(null, 204)
        }

        try {
            const url = new URL(request.url)
            const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
            const body = await readBody(request)
            const result = await dispatch(engine, request.method, segments, body)
            return json(result)
        } catch (error) {
            const code = error.code ?? 'internal'
            const status = error.status ?? STATUS_BY_CODE[code] ?? 500
            return json({ error: { code, message: error.message ?? 'Internal error' } }, status)
        }
    }
}

async function dispatch(engine, method, segments, body) {
    const [version, resource, contextId, action, nested] = segments

    if (version !== 'v2') {
        throw notFound()
    }

    if (method === 'POST' && resource === 'search' && segments.length === 2) {
        return engine.search(body.query, omit(body, ['query']))
    }

    if (resource === 'sync' && method === 'POST' && segments.length === 3) {
        const action = segments[2]
        if (action === 'export_snapshot') return engine.exportSnapshot(body)
        if (action === 'import_snapshot') return engine.importSnapshot(body)
        if (action === 'export_changes') return engine.exportChanges(body)
        if (action === 'import_changes') return engine.importChanges(body)
    }

    if (resource === 'workspaces') {
        if (method === 'GET' && segments.length === 2) {
            return engine.listWorkspaces()
        }

        if (method === 'POST' && segments.length === 2) {
            return engine.createWorkspace(body)
        }

        const workspaceId = contextId
        if (method === 'POST' && action === 'sessions' && segments.length === 4) {
            return engine.createSession(workspaceId, body)
        }

        throw notFound()
    }

    if (resource !== 'contexts') {
        throw notFound()
    }

    if (method === 'GET' && segments.length === 2) {
        return engine.listContexts()
    }

    if (method === 'POST' && segments.length === 2) {
        return engine.create(body)
    }

    if (!contextId) {
        throw notFound()
    }

    if (method === 'POST' && action === 'fork' && segments.length === 4) {
        return engine.fork(contextId, body)
    }

    if (method === 'POST' && action === 'messages' && segments.length === 4) {
        return engine.append(contextId, asArray(body.messages ?? body))
    }

    if (method === 'POST' && action === 'get' && segments.length === 4) {
        return engine.get(contextId, body)
    }

    if (method === 'POST' && action === 'update' && segments.length === 4) {
        return engine.update(contextId, body.updates, omit(body, ['updates']))
    }

    if (method === 'POST' && action === 'delete' && segments.length === 4) {
        return engine.delete(contextId, body.target, omit(body, ['target']))
    }

    if (action === 'artifacts') {
        if (method === 'GET' && segments.length === 4) {
            return engine.listArtifacts(contextId)
        }

        if (method === 'POST' && segments.length === 4) {
            return engine.save(contextId, body)
        }

        if (method === 'POST' && nested === 'load' && segments.length === 5) {
            return engine.load(contextId, body.pathOrId, omit(body, ['pathOrId']))
        }
    }

    if (action === 'files') {
        if (method === 'POST' && nested === 'read' && segments.length === 5) {
            return engine.read(contextId, body.pathOrId, omit(body, ['pathOrId']))
        }

        if (method === 'POST' && nested === 'write' && segments.length === 5) {
            return engine.write(contextId, body.path, body.data, omit(body, ['path', 'data']))
        }

        if (method === 'POST' && nested === 'move' && segments.length === 5) {
            return engine.move(contextId, body.fromPathOrId, body.toPath, omit(body, ['fromPathOrId', 'toPath']))
        }

        if (method === 'POST' && nested === 'remove' && segments.length === 5) {
            return engine.remove(contextId, body.pathOrId, omit(body, ['pathOrId']))
        }

        if (method === 'POST' && nested === 'glob' && segments.length === 5) {
            return engine.glob(contextId, body.pattern, omit(body, ['pattern']))
        }

        if (method === 'POST' && nested === 'grep' && segments.length === 5) {
            return engine.grep(contextId, body.query, omit(body, ['query']))
        }
    }

    throw notFound()
}

async function readBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD') {
        return {}
    }

    const text = await request.text()
    if (!text) {
        return {}
    }

    try {
        return JSON.parse(text)
    } catch {
        const error = new Error('Request body must be valid JSON')
        error.code = 'invalid_input'
        throw error
    }
}

function json(body, status = 200) {
    const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization'
    }

    if (status === 204) {
        return new Response(null, { status, headers })
    }

    headers['content-type'] = 'application/json'
    return new Response(JSON.stringify(body), { status, headers })
}

function omit(value, keys) {
    const result = { ...value }
    for (const key of keys) {
        delete result[key]
    }
    return result
}

function asArray(value) {
    return Array.isArray(value) ? value : [value]
}

function notFound() {
    const error = new Error('Route not found')
    error.code = 'not_found'
    return error
}
