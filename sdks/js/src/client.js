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
        this.workspaces = new WorkspacesApi(this)
        this.sessions = new SessionsApi(this)
        this.artifacts = new WorkspaceArtifactsApi(this)
        this.fs = new FileSystemApi(this)
        this.search = new SearchApi(this)
        this.sync = new SyncApi(this)
    }

    _call(operation, localBody, remotePath, remoteInit) {
        return this.transport.call(operation, localBody, remotePath, remoteInit)
    }
}

class WorkspacesApi {
    constructor(client) {
        this.client = client
    }

    async create(input = {}) {
        const body = { metadata: input.metadata ?? input ?? {} }
        return this.client._call('create_workspace', body, '/v2/workspaces', { method: 'POST', body })
    }

    async list() {
        return this.client._call('list_workspaces', {}, '/v2/workspaces', { method: 'GET' })
    }
}

class SessionsApi {
    constructor(client) {
        this.client = client
    }

    async create(input = {}) {
        const workspaceId = input.workspaceId ?? input.workspace_id
        const metadata = input.metadata ?? omit(input ?? {}, ['workspaceId', 'workspace_id'])
        if (workspaceId) {
            const body = { metadata }
            const summary = await this.client._call(
                'create_session',
                { workspaceId, ...body },
                `/v2/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
                { method: 'POST', body }
            )
            return new SessionHandle(this.client, summary)
        }

        const body = { metadata }
        const summary = await this.client._call('create', body, '/v2/contexts', { method: 'POST', body })
        return new SessionHandle(this.client, summary)
    }

    async get(id) {
        if (!id) throw new UltraContextError('Missing session id', { code: 'invalid_input' })
        return new SessionHandle(this.client, { id })
    }

    async list() {
        return this.client._call('list_contexts', {}, '/v2/contexts', { method: 'GET' })
    }

    async delete(id) {
        return this.client._call('delete_context', { ctxId: id }, `/v2/contexts/${encodeURIComponent(id)}/delete`, {
            method: 'POST',
            body: { target: { permanent: true } }
        })
    }

    async fork(sourceId, options = {}) {
        const summary = await this.client._call(
            'fork',
            { sourceId, ...options },
            `/v2/contexts/${encodeURIComponent(sourceId)}/fork`,
            { method: 'POST', body: options }
        )
        return new SessionHandle(this.client, summary)
    }
}

class SessionHandle {
    constructor(client, summary) {
        this.client = client
        Object.assign(this, summary)
        this.context = new SessionContextApi(client, this.id)
        this.artifacts = new SessionArtifactsApi(client, this.id)
        this.fs = new SessionFileSystemApi(client, this.id)
    }

    async delete() {
        return this.client.sessions.delete(this.id)
    }

    async fork(options = {}) {
        return this.client.sessions.fork(this.id, options)
    }

    toJSON() {
        const { client: _client, context: _context, artifacts: _artifacts, fs: _fs, ...summary } = this
        return summary
    }
}

class SessionContextApi {
    constructor(client, sessionId) {
        this.client = client
        this.sessionId = sessionId
    }

    async current(options = {}) {
        return this.client._call('get', { ctxId: this.sessionId, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/get`, {
            method: 'POST',
            body: options
        })
    }

    async get(options = {}) {
        return this.current(options)
    }

    async list(options = {}) {
        const current = await this.current(options)
        return { data: current.data ?? [], context_id: current.context_id, version: current.version }
    }

    async append(entries) {
        const messages = Array.isArray(entries) ? entries : [entries]
        return this.client._call('append', { ctxId: this.sessionId, messages }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/messages`, {
            method: 'POST',
            body: { messages }
        })
    }

    async update(update, options = {}) {
        return this.client._call('update', { ctxId: this.sessionId, updates: update, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/update`, {
            method: 'POST',
            body: { updates: update, ...options }
        })
    }

    async delete(target, options = {}) {
        return this.client._call('delete_messages', { ctxId: this.sessionId, target, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/delete`, {
            method: 'POST',
            body: { target, ...options }
        })
    }

    async clear(options = {}) {
        return this.client._call('context_clear', { ctxId: this.sessionId, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/clear`, {
            method: 'POST',
            body: options
        })
    }

    async history() {
        return this.client._call('context_history', { ctxId: this.sessionId }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/history`, {
            method: 'GET'
        })
    }

    async restore(contextId, options = {}) {
        return this.client._call(
            'context_restore',
            { ctxId: this.sessionId, restoreContextId: contextId, ...options },
            `/v2/contexts/${encodeURIComponent(this.sessionId)}/restore`,
            {
                method: 'POST',
                body: { contextId, ...options }
            }
        )
    }
}

class SessionArtifactsApi {
    constructor(client, sessionId) {
        this.client = client
        this.sessionId = sessionId
    }

    async create(input) {
        return this.client._call('save', { ctxId: this.sessionId, ...input }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/artifacts`, {
            method: 'POST',
            body: input
        })
    }

    async list() {
        return this.client._call('list_artifacts', { ctxId: this.sessionId }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/artifacts`, {
            method: 'GET'
        })
    }

    async get(pathOrId, options = {}) {
        return this.client._call('load', { ctxId: this.sessionId, pathOrId, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/artifacts/load`, {
            method: 'POST',
            body: { pathOrId, ...options }
        })
    }

    async update(pathOrId, data, options = {}) {
        return this.client._call('file_write', { ctxId: this.sessionId, path: pathOrId, data, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/write`, {
            method: 'POST',
            body: { path: pathOrId, data, ...options }
        })
    }

    async delete(pathOrId, options = {}) {
        return this.client._call('file_remove', { ctxId: this.sessionId, pathOrId, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/remove`, {
            method: 'POST',
            body: { pathOrId, ...options }
        })
    }
}

class WorkspaceArtifactsApi {
    constructor(client) {
        this.client = client
    }

    session(sessionId) {
        return new SessionArtifactsApi(this.client, sessionId)
    }
}

class FileSystemApi {
    constructor(client) {
        this.client = client
    }

    session(sessionId) {
        return new SessionFileSystemApi(this.client, sessionId)
    }
}

class SessionFileSystemApi {
    constructor(client, sessionId) {
        this.client = client
        this.sessionId = sessionId
    }

    async list(options = {}) {
        return this.client._call('file_list', { ctxId: this.sessionId, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files`, {
            method: 'GET'
        })
    }

    async read(pathOrId, options = {}) {
        return this.client._call('file_read', { ctxId: this.sessionId, pathOrId, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/read`, {
            method: 'POST',
            body: { pathOrId, ...options }
        })
    }

    async write(path, data, options = {}) {
        return this.client._call('file_write', { ctxId: this.sessionId, path, data, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/write`, {
            method: 'POST',
            body: { path, data, ...options }
        })
    }

    async move(fromPathOrId, toPath, options = {}) {
        return this.client._call('file_move', { ctxId: this.sessionId, fromPathOrId, toPath, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/move`, {
            method: 'POST',
            body: { fromPathOrId, toPath, ...options }
        })
    }

    async remove(pathOrId, options = {}) {
        return this.client._call('file_remove', { ctxId: this.sessionId, pathOrId, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/remove`, {
            method: 'POST',
            body: { pathOrId, ...options }
        })
    }

    async glob(pattern, options = {}) {
        return this.client._call('file_glob', { ctxId: this.sessionId, pattern, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/glob`, {
            method: 'POST',
            body: { pattern, ...options }
        })
    }

    async grep(query, options = {}) {
        return this.client._call('file_grep', { ctxId: this.sessionId, query, ...options }, `/v2/contexts/${encodeURIComponent(this.sessionId)}/files/grep`, {
            method: 'POST',
            body: { query, ...options }
        })
    }
}

class SyncApi {
    constructor(client) {
        this.client = client
    }

    async exportSnapshot() {
        return this.client._call('export_snapshot', {}, '/v2/sync/export_snapshot', {
            method: 'POST',
            body: {}
        })
    }

    async importSnapshot(snapshot) {
        return this.client._call('import_snapshot', snapshot, '/v2/sync/import_snapshot', {
            method: 'POST',
            body: snapshot
        })
    }

    async exportChanges(options = {}) {
        return this.client._call('export_changes', options, '/v2/sync/export_changes', {
            method: 'POST',
            body: options
        })
    }

    async importChanges(changes) {
        return this.client._call('import_changes', changes, '/v2/sync/import_changes', {
            method: 'POST',
            body: changes
        })
    }
}

class SearchApi {
    constructor(client) {
        this.client = client
    }

    async query(query, options = {}) {
        return this.client._call('search', { query, ...options }, '/v2/search', {
            method: 'POST',
            body: { query, ...options }
        })
    }
}

function omit(value, keys) {
    const result = { ...value }
    for (const key of keys) {
        delete result[key]
    }
    return result
}
