export class UltraContextError extends Error {
    constructor(message, options = {}) {
        super(message)
        this.name = 'UltraContextError'
        this.code = options.code ?? 'internal'
        this.status = options.status
        this.body = options.body
    }
}

export class UltraContext {
    constructor(config = {}) {
        this.mode = config.mode ?? (config.apiKey ? 'remote' : 'local')
        this.apiKey = config.apiKey
        this.baseUrl = (config.baseUrl ?? 'https://api.ultracontext.ai').replace(/\/+$/, '')
        this.fetch = config.fetch ?? globalThis.fetch
        this.path = config.path ?? 'ultracontext.db'
        this.contentDir = config.contentDir
        this.inlineLimit = config.inlineLimit
        this.native = config.native
        this.core = config.core

        if (this.mode === 'remote' && typeof this.fetch !== 'function') {
            throw new UltraContextError('remote mode requires fetch', { code: 'invalid_input' })
        }
    }

    async createWorkspace(input = {}) {
        const body = { metadata: input.metadata ?? input ?? {} }
        return this.#call('create_workspace', body, '/v2/workspaces', { method: 'POST', body })
    }

    async listWorkspaces() {
        return this.#call('list_workspaces', {}, '/v2/workspaces', { method: 'GET' })
    }

    async createSession(workspaceId, input = {}) {
        const body = { metadata: input.metadata ?? input ?? {} }
        return this.#call('create_session', { workspaceId, ...body }, `/v2/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
            method: 'POST',
            body
        })
    }

    async create(input = {}) {
        const workspaceId = input.workspaceId ?? input.workspace_id
        const metadata = input.metadata ?? omit(input ?? {}, ['workspaceId', 'workspace_id'])
        const body = { metadata }
        if (workspaceId) body.workspaceId = workspaceId
        return this.#call('create', body, '/v2/contexts', { method: 'POST', body })
    }

    async fork(sourceId, options = {}) {
        return this.#call('fork', { sourceId, ...options }, `/v2/contexts/${encodeURIComponent(sourceId)}/fork`, {
            method: 'POST',
            body: options
        })
    }

    async append(contextId, messages) {
        const bodyMessages = Array.isArray(messages) ? messages : [messages]
        return this.#call('append', { ctxId: contextId, messages: bodyMessages }, `/v2/contexts/${encodeURIComponent(contextId)}/messages`, {
            method: 'POST',
            body: { messages: bodyMessages }
        })
    }

    async get(contextId, options = {}) {
        if (contextId === undefined) {
            return this.#call('list_contexts', {}, '/v2/contexts', { method: 'GET' })
        }

        return this.#call('get', { ctxId: contextId, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/get`, {
            method: 'POST',
            body: options
        })
    }

    async update(contextId, updates, options = {}) {
        return this.#call('update', { ctxId: contextId, updates, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/update`, {
            method: 'POST',
            body: { updates, ...options }
        })
    }

    async delete(contextId, target, options = {}) {
        return this.#call('delete', { ctxId: contextId, target, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/delete`, {
            method: 'POST',
            body: { target, ...options }
        })
    }

    async search(query, options = {}) {
        return this.#call('search', { query, ...options }, '/v2/search', {
            method: 'POST',
            body: { query, ...options }
        })
    }

    async save(contextId, input) {
        return this.#call('save', { ctxId: contextId, ...input }, `/v2/contexts/${encodeURIComponent(contextId)}/artifacts`, {
            method: 'POST',
            body: input
        })
    }

    async load(contextId, pathOrId, options = {}) {
        if (pathOrId === undefined) {
            return this.#call('list_artifacts', { ctxId: contextId }, `/v2/contexts/${encodeURIComponent(contextId)}/artifacts`, {
                method: 'GET'
            })
        }

        return this.#call('load', { ctxId: contextId, pathOrId, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/artifacts/load`, {
            method: 'POST',
            body: { pathOrId, ...options }
        })
    }

    async read(contextId, pathOrId, options = {}) {
        return this.#call('file_read', { ctxId: contextId, pathOrId, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/files/read`, {
            method: 'POST',
            body: { pathOrId, ...options }
        })
    }

    async write(contextId, pathOrId, data, options = {}) {
        return this.#call('file_write', { ctxId: contextId, path: pathOrId, data, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/files/write`, {
            method: 'POST',
            body: { path: pathOrId, data, ...options }
        })
    }

    async move(contextId, fromPathOrId, toPath, options = {}) {
        return this.#call('file_move', { ctxId: contextId, fromPathOrId, toPath, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/files/move`, {
            method: 'POST',
            body: { fromPathOrId, toPath, ...options }
        })
    }

    async remove(contextId, pathOrId, options = {}) {
        return this.#call('file_remove', { ctxId: contextId, pathOrId, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/files/remove`, {
            method: 'POST',
            body: { pathOrId, ...options }
        })
    }

    async glob(contextId, pattern, options = {}) {
        return this.#call('file_glob', { ctxId: contextId, pattern, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/files/glob`, {
            method: 'POST',
            body: { pattern, ...options }
        })
    }

    async grep(contextId, query, options = {}) {
        return this.#call('file_grep', { ctxId: contextId, query, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/files/grep`, {
            method: 'POST',
            body: { query, ...options }
        })
    }

    async exportSnapshot() {
        return this.#call('export_snapshot', {}, '/v2/sync/export_snapshot', {
            method: 'POST',
            body: {}
        })
    }

    async importSnapshot(snapshot) {
        return this.#call('import_snapshot', snapshot, '/v2/sync/import_snapshot', {
            method: 'POST',
            body: snapshot
        })
    }

    async exportChanges(options = {}) {
        return this.#call('export_changes', options, '/v2/sync/export_changes', {
            method: 'POST',
            body: options
        })
    }

    async importChanges(changes) {
        return this.#call('import_changes', changes, '/v2/sync/import_changes', {
            method: 'POST',
            body: changes
        })
    }

    async #call(operation, localBody, remotePath, remoteInit) {
        if (this.mode === 'local') {
            return this.#callLocal(operation, localBody)
        }
        return this.#request(remotePath, remoteInit)
    }

    #callLocal(operation, body) {
        const envelope = JSON.parse(this.#nativeCore().dispatchJson(operation, JSON.stringify(body)))
        if (envelope.error) {
            throw new UltraContextError(envelope.error.message ?? 'UltraContext request failed', {
                code: envelope.error.code ?? 'internal',
                body: envelope
            })
        }
        return envelope.ok
    }

    #nativeCore() {
        if (this.core) {
            return this.core
        }

        const native = this.native ?? loadNative()
        this.core = new native.UltraContextCore(this.path, nativeOptions(this))
        return this.core
    }

    async #request(path, init) {
        if (this.mode !== 'remote') {
            throw new UltraContextError('local JS native mode is not implemented yet', {
                code: 'invalid_input'
            })
        }

        const headers = {
            'content-type': 'application/json'
        }
        if (this.apiKey) {
            headers.authorization = `Bearer ${this.apiKey}`
        }

        const request = {
            method: init.method,
            headers
        }
        if (init.body !== undefined) {
            request.body = JSON.stringify(init.body)
        }

        const response = await this.fetch(`${this.baseUrl}${path}`, request)
        const text = await response.text()
        const body = text ? JSON.parse(text) : null

        if (!response.ok) {
            const error = body?.error ?? body
            throw new UltraContextError(error?.message ?? `UltraContext request failed`, {
                code: error?.code ?? 'internal',
                status: response.status,
                body
            })
        }

        return body
    }
}

function nativeOptions(client) {
    const options = {}
    if (client.contentDir !== undefined) {
        options.contentDir = client.contentDir
        options.content_dir = client.contentDir
    }
    if (client.inlineLimit !== undefined) {
        options.inlineLimit = client.inlineLimit
        options.inline_limit = client.inlineLimit
    }
    return Object.keys(options).length ? options : undefined
}

function loadNative() {
    const getBuiltinModule = globalThis.process?.getBuiltinModule
    if (typeof getBuiltinModule !== 'function') {
        throw new UltraContextError('local JS native mode requires Node.js native module support', {
            code: 'invalid_input'
        })
    }

    const { createRequire } = getBuiltinModule('module')
    const require = createRequire(import.meta.url)
    const candidates = [
        '../native/index.darwin-arm64.node',
        '../native/index.darwin-x64.node',
        '../native/index.linux-x64-gnu.node',
        '../native/index.linux-arm64-gnu.node',
        '../native/index.win32-x64-msvc.node',
        '../native/index.node',
        '../ultracontext.darwin-arm64.node',
        '../ultracontext.darwin-x64.node',
        '../ultracontext.linux-x64-gnu.node',
        '../ultracontext.linux-arm64-gnu.node',
        '../ultracontext.win32-x64-msvc.node',
        '../ultracontext.node'
    ]

    for (const candidate of candidates) {
        try {
            return require(candidate)
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') {
                throw error
            }
        }
    }

    throw new UltraContextError('local JS native binding is not installed', {
        code: 'invalid_input'
    })
}
