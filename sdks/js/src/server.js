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
        return callEngine(engine, 'search', { query: body.query, ...omit(body, ['query']) })
    }

    if (resource === 'sync' && method === 'POST' && segments.length === 3) {
        const action = segments[2]
        if (action === 'export_snapshot') return callEngine(engine, 'export_snapshot', body)
        if (action === 'import_snapshot') return callEngine(engine, 'import_snapshot', body)
        if (action === 'export_changes') return callEngine(engine, 'export_changes', body)
        if (action === 'import_changes') return callEngine(engine, 'import_changes', body)
    }

    if (resource === 'workspaces') {
        if (method === 'GET' && segments.length === 2) {
            return callEngine(engine, 'list_workspaces', {})
        }

        if (method === 'POST' && segments.length === 2) {
            return callEngine(engine, 'create_workspace', body)
        }

        const workspaceId = contextId
        if (method === 'POST' && action === 'sessions' && segments.length === 4) {
            return callEngine(engine, 'create_session', { workspaceId, ...body })
        }

        throw notFound()
    }

    if (resource !== 'contexts') {
        throw notFound()
    }

    if (method === 'GET' && segments.length === 2) {
        return callEngine(engine, 'list_contexts', {})
    }

    if (method === 'POST' && segments.length === 2) {
        return callEngine(engine, 'create', body)
    }

    if (!contextId) {
        throw notFound()
    }

    if (method === 'POST' && action === 'fork' && segments.length === 4) {
        return callEngine(engine, 'fork', { sourceId: contextId, ...body })
    }

    if (method === 'POST' && action === 'messages' && segments.length === 4) {
        return callEngine(engine, 'append', { ctxId: contextId, messages: asArray(body.messages ?? body) })
    }

    if (method === 'POST' && action === 'get' && segments.length === 4) {
        return callEngine(engine, 'get', { ctxId: contextId, ...body })
    }

    if (method === 'GET' && action === 'history' && segments.length === 4) {
        return callEngine(engine, 'context_history', { ctxId: contextId })
    }

    if (method === 'POST' && action === 'clear' && segments.length === 4) {
        return callEngine(engine, 'context_clear', { ctxId: contextId, ...body })
    }

    if (method === 'POST' && action === 'restore' && segments.length === 4) {
        const restoreContextId = body.contextId ?? body.context_id
        if (!restoreContextId) {
            throw invalidInput('restore requires contextId')
        }
        return callEngine(engine, 'context_restore', { ctxId: contextId, restoreContextId, ...body })
    }

    if (method === 'POST' && action === 'update' && segments.length === 4) {
        return callEngine(engine, 'update', { ctxId: contextId, updates: body.updates, ...omit(body, ['updates']) })
    }

    if (method === 'POST' && action === 'delete' && segments.length === 4) {
        return callEngine(engine, 'delete', { ctxId: contextId, target: body.target, ...omit(body, ['target']) })
    }

    if (action === 'artifacts') {
        if (method === 'GET' && segments.length === 4) {
            return callEngine(engine, 'list_artifacts', { ctxId: contextId })
        }

        if (method === 'POST' && segments.length === 4) {
            return callEngine(engine, 'save', { ctxId: contextId, ...body })
        }

        if (method === 'POST' && nested === 'load' && segments.length === 5) {
            return callEngine(engine, 'load', { ctxId: contextId, pathOrId: body.pathOrId, ...omit(body, ['pathOrId']) })
        }
    }

    if (action === 'files') {
        if (method === 'POST' && nested === 'read' && segments.length === 5) {
            return callEngine(engine, 'file_read', { ctxId: contextId, pathOrId: body.pathOrId, ...omit(body, ['pathOrId']) })
        }

        if (method === 'POST' && nested === 'write' && segments.length === 5) {
            return callEngine(engine, 'file_write', { ctxId: contextId, path: body.path, data: body.data, ...omit(body, ['path', 'data']) })
        }

        if (method === 'POST' && nested === 'move' && segments.length === 5) {
            return callEngine(engine, 'file_move', { ctxId: contextId, fromPathOrId: body.fromPathOrId, toPath: body.toPath, ...omit(body, ['fromPathOrId', 'toPath']) })
        }

        if (method === 'POST' && nested === 'remove' && segments.length === 5) {
            return callEngine(engine, 'file_remove', { ctxId: contextId, pathOrId: body.pathOrId, ...omit(body, ['pathOrId']) })
        }

        if (method === 'POST' && nested === 'glob' && segments.length === 5) {
            return callEngine(engine, 'file_glob', { ctxId: contextId, pattern: body.pattern, ...omit(body, ['pattern']) })
        }

        if (method === 'POST' && nested === 'grep' && segments.length === 5) {
            return callEngine(engine, 'file_grep', { ctxId: contextId, query: body.query, ...omit(body, ['query']) })
        }
    }

    throw notFound()
}

function callEngine(engine, operation, payload) {
    if (typeof engine.dispatch !== 'function') {
        throw invalidInput('UltraContext engine must implement dispatch(operation, payload)')
    }
    return engine.dispatch(operation, payload)
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

function invalidInput(message) {
    const error = new Error(message)
    error.code = 'invalid_input'
    return error
}
