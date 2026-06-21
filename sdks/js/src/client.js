export class UltraContextError extends Error {
    constructor(message, options = {}) {
        super(message)
        this.name = 'UltraContextError'
        this.code = options.code ?? 'internal'
        this.status = options.status
        this.body = options.body
    }
}

export class UltraContextBase {
    constructor({ transport }) {
        if (!transport || typeof transport.call !== 'function') {
            throw new UltraContextError('UltraContext requires a transport', { code: 'invalid_input' })
        }
        this.transport = transport
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

    async contextHistory(contextId) {
        return this.#call('context_history', { ctxId: contextId }, `/v2/contexts/${encodeURIComponent(contextId)}/history`, {
            method: 'GET'
        })
    }

    async clearContext(contextId, options = {}) {
        return this.#call('context_clear', { ctxId: contextId, ...options }, `/v2/contexts/${encodeURIComponent(contextId)}/clear`, {
            method: 'POST',
            body: options
        })
    }

    async restoreContext(contextId, restoreContextId, options = {}) {
        return this.#call(
            'context_restore',
            { ctxId: contextId, restoreContextId, ...options },
            `/v2/contexts/${encodeURIComponent(contextId)}/restore`,
            {
                method: 'POST',
                body: { contextId: restoreContextId, ...options }
            }
        )
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

    #call(operation, localBody, remotePath, remoteInit) {
        return this.transport.call(operation, localBody, remotePath, remoteInit)
    }
}

function omit(value, keys) {
    const result = { ...value }
    for (const key of keys) {
        delete result[key]
    }
    return result
}
