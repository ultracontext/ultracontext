import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { byteLength, inlineContent, shouldStoreExternally } from './content-store.js'

export function createSqliteEngine({ path = ':memory:', contentStore = null, inlineLimit = Infinity } = {}) {
    return new SqliteEngine({ path, contentStore, inlineLimit })
}

class SqliteEngine {
    constructor({ path, contentStore, inlineLimit }) {
        this.contentStore = contentStore
        this.inlineLimit = inlineLimit
        this.db = new DatabaseSync(path)
        this.db.exec(`
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS nodes (
                id INTEGER PRIMARY KEY,
                public_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('workspace', 'session', 'context', 'message', 'artifact')),
                content TEXT NOT NULL DEFAULT '{}',
                metadata TEXT NOT NULL DEFAULT '{}',
                data BLOB,
                prev INTEGER REFERENCES nodes(id),
                parent INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
                owner INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS nodes_owner_kind ON nodes(owner, kind);
            CREATE INDEX IF NOT EXISTS nodes_public_id ON nodes(public_id);
            CREATE INDEX IF NOT EXISTS nodes_prev ON nodes(prev);
        `)
    }

    createWorkspace(input = {}) {
        const metadata = input.metadata ?? {}
        const workspaceId = id('ws')
        const createdAt = now()
        this.insertNode({
            publicId: workspaceId,
            kind: 'workspace',
            content: metadata,
            metadata,
            createdAt
        })
        return { id: workspaceId, metadata, created_at: createdAt }
    }

    listWorkspaces() {
        return {
            data: this.workspaces().map(row => ({
                id: row.public_id,
                metadata: row.metadata,
                created_at: row.created_at
            }))
        }
    }

    createSession(workspaceId, input = {}) {
        const workspace = this.workspace(workspaceId)
        return this.createSessionNodes(workspace, input.metadata ?? {}).session
    }

    create(input = {}) {
        const workspace = input.workspaceId || input.workspace_id
            ? this.workspace(input.workspaceId ?? input.workspace_id)
            : this.ensureDefaultWorkspace()
        return this.createSessionNodes(workspace, input.metadata ?? {}).context
    }

    createSessionNodes(workspace, metadata) {
        const sessionId = id('ses')
        const contextId = id('ctx')
        const createdAt = now()

        this.insertNode({
            publicId: sessionId,
            kind: 'session',
            content: {
                workspace_id: workspace.public_id,
                initial_context_id: contextId
            },
            metadata,
            owner: workspace.id,
            createdAt
        })
        const sessionRow = this.row(this.db.prepare('SELECT last_insert_rowid() AS id').get().id)
        this.insertNode({
            publicId: contextId,
            kind: 'context',
            content: {
                role: 'head',
                operation: 'create',
                projection: false,
                workspace_id: workspace.public_id,
                session_id: sessionRow.public_id
            },
            metadata: { operation: 'create' },
            owner: sessionRow.id,
            createdAt: now()
        })

        return {
            session: {
                id: sessionRow.public_id,
                workspace_id: workspace.public_id,
                context_id: contextId,
                metadata,
                created_at: createdAt
            },
            context: { id: sessionRow.public_id, metadata, created_at: createdAt },
            sessionRow
        }
    }

    fork(sourceId, options = {}) {
        const sourceSession = this.resolveSession(sourceId)
        const workspace = this.workspaceForSession(sourceSession)
        const sourceHeads = this.heads(sourceSession.id)
        const sourceHead = sourceHeads[options.version ?? sourceHeads.length - 1]
        if (!sourceHead) {
            throw domainError('not_found', 'Version not found')
        }

        const created = this.createSessionNodes(workspace, options.metadata ?? {})
        const session = created.sessionRow

        let prev = null
        for (const message of this.contextMessages(sourceSession, sourceHead)) {
            this.insertNode({
                publicId: id('msg'),
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                parent: message.id,
                owner: session.id,
                createdAt: now()
            })
            prev = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        }

        return created.context
    }

    append(contextId, messages) {
        messages = Array.isArray(messages) ? messages : [messages]
        const session = this.resolveSession(contextId)
        const head = this.currentHead(session.id)
        const existing = this.children(session.id, 'message')
        let prev = existing.at(-1)?.id ?? null
        let projectedPrev = this.children(head.id, 'message').at(-1)?.id ?? null
        const projectIntoHead = head.content.projection === true

        for (const message of messages) {
            this.insertNode({
                publicId: id('msg'),
                kind: 'message',
                content: message,
                metadata: message.metadata ?? {},
                prev,
                owner: session.id,
                createdAt: now()
            })
            const rowId = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
            prev = rowId

            if (projectIntoHead) {
                this.insertNode({
                    publicId: id('msg'),
                    kind: 'message',
                    content: message,
                    metadata: message.metadata ?? {},
                    prev: projectedPrev,
                    parent: rowId,
                    owner: head.id,
                    createdAt: now()
                })
                projectedPrev = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
            }
        }

        return { context_id: head.public_id, data: this.contextMessageViews(session, head), version: this.version(head.id) }
    }

    get(contextId, options = {}) {
        const session = this.resolveSession(contextId)
        const heads = this.heads(session.id)
        const version = options.version ?? heads.length - 1
        const head = heads[version]
        if (!head) {
            throw domainError('not_found', 'Version not found')
        }
        return { id: contextId, context_id: head.public_id, data: this.contextMessageViews(session, head), version }
    }

    contextHistory(contextId) {
        const session = this.resolveSession(contextId)
        const heads = this.heads(session.id)
        return {
            data: heads.map((head, version) => ({
                id: head.public_id,
                session_id: session.public_id,
                version,
                operation: head.content.operation ?? 'unknown',
                created_at: head.created_at,
                current: version === heads.length - 1
            }))
        }
    }

    listContexts() {
        return {
            data: this.sessions().map(row => ({
                id: row.public_id,
                metadata: row.metadata,
                created_at: row.created_at
            }))
        }
    }

    update(contextId, updates, options = {}) {
        const session = this.resolveSession(contextId)
        const current = this.currentHead(session.id)
        const messages = this.contextMessages(session, current)
        const update = Array.isArray(updates) ? updates[0] : updates
        const targetIndex = update.index ?? messages.findIndex(message => message.public_id === update.id)
        if (targetIndex < 0 || targetIndex >= messages.length) {
            throw domainError('invalid_input', `Index out of range: ${targetIndex}`)
        }

        const newContextId = id('ctx')
        this.insertNode({
            publicId: newContextId,
            kind: 'context',
            content: { role: 'head', operation: 'update', projection: true },
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: session.id,
            createdAt: now()
        })
        const newHead = this.db.prepare('SELECT last_insert_rowid() AS id').get().id

        let prev = null
        for (const [index, message] of messages.entries()) {
            const nextContent = index === targetIndex
                ? { ...message.content, ...omit(update, ['id', 'index']) }
                : message.content
            this.insertNode({
                publicId: index === targetIndex ? id('msg') : message.public_id,
                kind: 'message',
                content: nextContent,
                metadata: message.metadata,
                prev,
                parent: index === targetIndex ? message.id : null,
                owner: newHead,
                createdAt: now()
            })
            prev = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        }

        return { context_id: newContextId, data: this.messageViews(newHead), version: this.version(newHead) }
    }

    delete(contextId, target, options = {}) {
        if (target?.permanent) {
            const session = this.resolveSession(contextId)
            this.db.prepare('DELETE FROM nodes WHERE id = ?').run(session.id)
            return { deleted: true, id: contextId }
        }
        return this.deleteMessages(contextId, Array.isArray(target) ? target : [target], options)
    }

    deleteMessages(contextId, targets, options = {}) {
        const session = this.resolveSession(contextId)
        const current = this.currentHead(session.id)
        const messages = this.contextMessages(session, current)
        const deleteIndexes = new Set(targets.map(target => {
            if (typeof target === 'number') {
                return target
            }
            if (target && typeof target === 'object' && Number.isInteger(target.index)) {
                return target.index
            }
            return messages.findIndex(message => message.public_id === target)
        }))

        const newContextId = id('ctx')
        this.insertNode({
            publicId: newContextId,
            kind: 'context',
            content: { role: 'head', operation: 'delete', projection: true },
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: session.id,
            createdAt: now()
        })
        const newHead = this.db.prepare('SELECT last_insert_rowid() AS id').get().id

        let prev = null
        for (const [index, message] of messages.entries()) {
            if (deleteIndexes.has(index)) continue
            this.insertNode({
                publicId: message.public_id,
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                owner: newHead,
                createdAt: now()
            })
            prev = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        }

        return { context_id: newContextId, data: this.messageViews(newHead), version: this.version(newHead) }
    }

    clear(contextId, options = {}) {
        const session = this.resolveSession(contextId)
        const current = this.currentHead(session.id)
        const newContextId = id('ctx')
        this.insertNode({
            publicId: newContextId,
            kind: 'context',
            content: { role: 'head', operation: 'clear', projection: true },
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: session.id,
            createdAt: now()
        })
        const newHead = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        return { context_id: newContextId, data: [], version: this.version(newHead) }
    }

    restore(contextId, restoreContextId, options = {}) {
        const session = this.resolveSession(contextId)
        const current = this.currentHead(session.id)
        const source = this.contextHeadByPublicId(session.id, restoreContextId)
        const messages = this.contextMessages(session, source)
        const newContextId = id('ctx')
        this.insertNode({
            publicId: newContextId,
            kind: 'context',
            content: {
                role: 'head',
                operation: 'restore',
                projection: true,
                restored_from: restoreContextId
            },
            metadata: options.metadata ?? {},
            prev: current.id,
            parent: source.id,
            owner: session.id,
            createdAt: now()
        })
        const newHead = this.db.prepare('SELECT last_insert_rowid() AS id').get().id

        let prev = null
        for (const message of messages) {
            this.insertNode({
                publicId: message.public_id,
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                parent: message.id,
                owner: newHead,
                createdAt: now()
            })
            prev = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        }

        return { context_id: newContextId, data: this.messageViews(newHead), version: this.version(newHead) }
    }

    save(contextId, input) {
        const session = this.resolveSession(contextId)
        const workspace = this.workspaceForSession(session)
        const path = normalizePath(input.path)
        const current = input.id
            ? this.currentArtifactById(workspace.id, input.id)
            : this.currentArtifactByPath(workspace.id, path)

        if (input.ifVersion !== undefined) {
            if (!current || this.artifactVersion(current.id) !== input.ifVersion) {
                throw domainError('conflict', 'Artifact version conflict')
            }
        }

        const data = input.data ?? ''
        const version = current ? this.artifactVersion(current.id) + 1 : 0
        const stored = this.storeArtifactContent({
            artifactId: current?.public_id ?? id('art'),
            version,
            data,
            kind: input.kind ?? 'text/plain'
        })
        const content = {
            path,
            kind: input.kind ?? 'text/plain',
            size: byteLength(data),
            sha256: fingerprint(String(data)),
            storage: stored.storage
        }

        this.insertNode({
            publicId: current?.public_id ?? stored.artifactId,
            kind: 'artifact',
            content,
            metadata: input.metadata ?? {},
            data: stored.data,
            prev: current?.id ?? null,
            parent: current?.id ?? null,
            owner: workspace.id,
            createdAt: now()
        })

        const row = this.row(this.db.prepare('SELECT last_insert_rowid() AS id').get().id)
        return this.artifactMeta(row)
    }

    load(contextId, pathOrId, options = {}) {
        const session = this.resolveSession(contextId)
        const workspace = this.workspaceForSession(session)
        const current = pathOrId.startsWith('art_')
            ? this.currentArtifactById(workspace.id, pathOrId)
            : this.currentArtifactByPath(workspace.id, normalizePath(pathOrId))
        if (!current) {
            throw domainError('not_found', 'Artifact not found')
        }
        const chain = this.chain(current.id)
        const version = options.version ?? chain.length - 1
        const row = chain[version]
        if (!row) {
            throw domainError('not_found', 'Artifact version not found')
        }
        return this.artifactData(row, version)
    }

    listArtifacts(contextId) {
        const session = this.resolveSession(contextId)
        const workspace = this.workspaceForSession(session)
        return { data: this.currentArtifacts(workspace.id).map(row => this.artifactMeta(row)) }
    }

    read(contextId, pathOrId, options = {}) {
        return this.load(contextId, pathOrId, options)
    }

    write(contextId, path, data, options = {}) {
        return this.save(contextId, { path, data, ...options })
    }

    move(contextId, fromPathOrId, toPath, options = {}) {
        const current = this.load(contextId, fromPathOrId)
        return this.save(contextId, {
            id: current.id,
            path: toPath,
            kind: current.kind,
            data: current.data,
            metadata: current.metadata,
            ifVersion: options.ifVersion
        })
    }

    remove(contextId, pathOrId, options = {}) {
        const current = this.load(contextId, pathOrId)
        if (options.ifVersion !== undefined && current.version !== options.ifVersion) {
            throw domainError('conflict', 'Artifact version conflict')
        }
        const session = this.resolveSession(contextId)
        const workspace = this.workspaceForSession(session)
        for (const row of this.chain(this.currentArtifactById(workspace.id, current.id).id).reverse()) {
            this.deleteArtifactData(row)
            this.db.prepare('DELETE FROM nodes WHERE id = ?').run(row.id)
        }
        return { deleted: true, id: current.id }
    }

    glob(contextId, pattern) {
        const prefix = pattern.replace(/\*\*?\/?.*$/, '')
        return { data: this.listArtifacts(contextId).data.filter(file => file.path.startsWith(prefix)) }
    }

    grep(contextId, query, options = {}) {
        const prefix = options.prefix ? normalizePrefix(options.prefix) : null
        const session = this.resolveSession(contextId)
        const result = this.search(query)
        result.data = result.data.filter(hit => (
            hit.kind === 'artifact'
            && hit.context_id === session.public_id
            && (!prefix || hit.path?.startsWith(prefix))
        ))
        return result
    }

    search(query) {
        const needle = query.trim().toLowerCase()
        if (!needle) {
            throw domainError('invalid_input', 'Search query is empty')
        }
        const hits = []
        for (const session of this.sessions()) {
            const head = this.currentHead(session.id)
            for (const message of this.contextMessages(session, head)) {
                const text = textFromValue(message.content)
                if (text.toLowerCase().includes(needle)) {
                    hits.push({
                        kind: 'message',
                        id: message.public_id,
                        context_id: session.public_id,
                        path: null,
                        snippet: text,
                        metadata: message.metadata,
                        created_at: message.created_at
                    })
                }
            }
            const workspace = this.workspaceForSession(session)
            for (const artifact of this.currentArtifacts(workspace.id)) {
                const text = this.readArtifactData(artifact) ?? ''
                if (artifact.content.kind?.startsWith('text/') && text.toLowerCase().includes(needle)) {
                    hits.push({
                        kind: 'artifact',
                        id: artifact.public_id,
                        context_id: session.public_id,
                        path: artifact.content.path,
                        snippet: text,
                        metadata: artifact.metadata,
                        created_at: artifact.created_at
                    })
                }
            }
        }
        return { data: hits.sort((a, b) => b.created_at.localeCompare(a.created_at)) }
    }

    exportSnapshot() {
        return {
            schema: 'ultracontext.snapshot.v1',
            cursor: this.cursor(),
            nodes: this.exportNodes()
        }
    }

    exportChanges({ since = 0 } = {}) {
        return {
            schema: 'ultracontext.changes.v1',
            since,
            cursor: this.cursor(),
            nodes: this.exportNodes(since)
        }
    }

    importSnapshot(snapshot) {
        if (snapshot?.schema !== 'ultracontext.snapshot.v1') {
            throw domainError('invalid_input', 'Unsupported snapshot schema')
        }
        return this.importNodes(snapshot.nodes ?? [])
    }

    importChanges(changes) {
        if (changes?.schema !== 'ultracontext.changes.v1') {
            throw domainError('invalid_input', 'Unsupported changes schema')
        }
        return this.importNodes(changes.nodes ?? [])
    }

    insertNode({ publicId, kind, content, metadata = {}, data = null, prev = null, parent = null, owner = null, createdAt }) {
        this.db.prepare(`
            INSERT INTO nodes (public_id, kind, content, metadata, data, prev, parent, owner, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(publicId, kind, JSON.stringify(content), JSON.stringify(metadata), dataToBuffer(data), prev, parent, owner, createdAt)
    }

    insertNodeWithId({ id: rowId, publicId, kind, content, metadata = {}, data = null, prev = null, parent = null, owner = null, createdAt }) {
        this.db.prepare(`
            INSERT INTO nodes (id, public_id, kind, content, metadata, data, prev, parent, owner, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(rowId, publicId, kind, JSON.stringify(content), JSON.stringify(metadata), dataToBuffer(data), prev, parent, owner, createdAt)
    }

    ensureDefaultWorkspace() {
        const existing = this.db.prepare(`
            SELECT * FROM nodes
            WHERE public_id = 'ws_default' AND kind = 'workspace'
            LIMIT 1
        `).get()
        if (existing) return decode(existing)

        const createdAt = now()
        this.insertNode({
            publicId: 'ws_default',
            kind: 'workspace',
            content: { name: 'default', default: true },
            metadata: { name: 'default', default: true },
            createdAt
        })
        return this.row(this.db.prepare('SELECT last_insert_rowid() AS id').get().id)
    }

    workspace(publicId) {
        const row = this.db.prepare(`
            SELECT * FROM nodes
            WHERE public_id = ? AND kind = 'workspace'
            LIMIT 1
        `).get(publicId)
        if (!row) throw domainError('not_found', 'Workspace not found')
        return decode(row)
    }

    workspaces() {
        return this.db.prepare(`
            SELECT * FROM nodes
            WHERE kind = 'workspace'
            ORDER BY created_at ASC, id ASC
        `).all().map(decode)
    }

    session(publicId) {
        const row = this.db.prepare(`
            SELECT * FROM nodes
            WHERE public_id = ? AND kind = 'session'
            LIMIT 1
        `).get(publicId)
        return row ? decode(row) : null
    }

    resolveSession(publicId) {
        const direct = this.session(publicId)
        if (direct) return direct

        const row = this.db.prepare(`
            SELECT session.* FROM nodes context
            JOIN nodes session ON session.id = context.owner
            WHERE context.public_id = ?
              AND context.kind = 'context'
              AND session.kind = 'session'
            LIMIT 1
        `).get(publicId)
        if (!row) throw domainError('not_found', 'Session not found')
        return decode(row)
    }

    workspaceForSession(session) {
        const row = this.db.prepare(`
            SELECT workspace.* FROM nodes session
            JOIN nodes workspace ON workspace.id = session.owner
            WHERE session.id = ?
              AND session.kind = 'session'
              AND workspace.kind = 'workspace'
            LIMIT 1
        `).get(session.id)
        if (!row) throw domainError('internal', 'Workspace not found for session')
        return decode(row)
    }

    sessions() {
        return this.db.prepare(`
            SELECT * FROM nodes
            WHERE kind = 'session'
            ORDER BY created_at DESC, id DESC
        `).all().map(decode)
    }

    currentHead(sessionRowId) {
        const row = this.db.prepare(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'context'
              AND n.owner = ?
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'context' AND child.prev = n.id
              )
            ORDER BY n.id DESC
            LIMIT 1
        `).get(sessionRowId)
        if (!row) throw domainError('internal', 'HEAD not found')
        return decode(row)
    }

    heads(sessionRowId) {
        return this.chain(this.currentHead(sessionRowId).id)
    }

    contextHeadByPublicId(sessionRowId, publicId) {
        const row = this.db.prepare(`
            SELECT * FROM nodes
            WHERE kind = 'context' AND owner = ? AND public_id = ?
            LIMIT 1
        `).get(sessionRowId, publicId)
        if (!row) throw domainError('not_found', 'Context snapshot not found')
        return decode(row)
    }

    children(owner, kind) {
        return orderByPrev(this.db.prepare(`
            SELECT * FROM nodes WHERE owner = ? AND kind = ?
        `).all(owner, kind).map(decode))
    }

    messageViews(headRowId) {
        return this.children(headRowId, 'message').map((row, index) => ({
            id: row.public_id,
            index,
            ...row.content,
            metadata: row.metadata,
            created_at: row.created_at
        }))
    }

    contextMessages(session, head) {
        if (head.content.projection !== true) {
            return this.children(session.id, 'message')
        }
        return this.children(head.id, 'message')
    }

    contextMessageViews(session, head) {
        return this.contextMessages(session, head).map((row, index) => ({
            id: row.public_id,
            index,
            ...row.content,
            metadata: row.metadata,
            created_at: row.created_at
        }))
    }

    version(headRowId) {
        return this.chain(headRowId).length - 1
    }

    row(rowId) {
        const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(rowId)
        if (!row) throw domainError('internal', 'Node not found')
        return decode(row)
    }

    cursor() {
        return this.db.prepare('SELECT COALESCE(MAX(id), 0) AS cursor FROM nodes').get().cursor
    }

    exportNodes(since = null) {
        const rows = (since === null || since === undefined)
            ? this.db.prepare('SELECT * FROM nodes ORDER BY id ASC').all()
            : this.db.prepare('SELECT * FROM nodes WHERE id > ? ORDER BY id ASC').all(since)
        return rows.map(row => {
            const decoded = decode(row)
            const data = decoded.data !== null && decoded.data !== undefined
                ? dataToString(decoded.data)
                : (decoded.kind === 'artifact' ? this.readArtifactData(decoded) : null)
            return {
                id: decoded.id,
                public_id: decoded.public_id,
                kind: decoded.kind,
                content: decoded.content,
                metadata: decoded.metadata,
                data,
                prev: decoded.prev,
                parent: decoded.parent,
                owner: decoded.owner,
                created_at: decoded.created_at
            }
        })
    }

    importNodes(nodes) {
        let imported = 0
        let skipped = 0
        const conflicts = []
        for (const node of nodes) {
            const existing = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id)
            const content = node.kind === 'artifact' && node.data !== null && node.data !== undefined
                ? { ...node.content, storage: { type: 'inline' } }
                : node.content
            const candidate = {
                id: node.id,
                publicId: node.public_id,
                kind: node.kind,
                content,
                metadata: node.metadata ?? {},
                data: node.data === undefined ? null : node.data,
                prev: node.prev ?? null,
                parent: node.parent ?? null,
                owner: node.owner ?? null,
                createdAt: node.created_at
            }
            if (existing) {
                if (sameImportedNode(decode(existing), candidate)) {
                    skipped += 1
                } else {
                    conflicts.push({
                        id: node.id,
                        public_id: node.public_id,
                        kind: node.kind,
                        reason: 'node_id_conflict'
                    })
                }
                continue
            }
            this.insertNodeWithId(candidate)
            imported += 1
        }
        return { imported, skipped, conflicts }
    }

    chain(rowId) {
        const rows = []
        let cursor = rowId
        while (cursor) {
            const row = this.row(cursor)
            rows.push(row)
            cursor = row.prev
        }
        return rows.reverse()
    }

    currentArtifactByPath(ownerRowId, path) {
        const row = this.db.prepare(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = ?
              AND json_extract(n.content, '$.path') = ?
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY n.id DESC
            LIMIT 1
        `).get(ownerRowId, path)
        return row ? decode(row) : null
    }

    currentArtifactById(ownerRowId, publicId) {
        const row = this.db.prepare(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = ?
              AND n.public_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY n.id DESC
            LIMIT 1
        `).get(ownerRowId, publicId)
        return row ? decode(row) : null
    }

    currentArtifacts(ownerRowId) {
        return this.db.prepare(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = ?
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY json_extract(n.content, '$.path') ASC, n.id ASC
        `).all(ownerRowId).map(decode)
    }

    artifactVersion(rowId) {
        return this.chain(rowId).length - 1
    }

    artifactMeta(row) {
        return {
            id: row.public_id,
            path: row.content.path,
            kind: row.content.kind,
            size: row.content.size,
            version: this.artifactVersion(row.id),
            created_at: row.created_at
        }
    }

    artifactData(row, version) {
        return {
            ...this.artifactMeta(row),
            version,
            metadata: row.metadata,
            storage: row.content.storage ?? { type: 'inline' },
            data: this.readArtifactData(row)
        }
    }

    storeArtifactContent({ artifactId, version, data, kind }) {
        if (!shouldStoreExternally(data, this.inlineLimit)) {
            return { artifactId, ...inlineContent(data) }
        }
        if (!this.contentStore) {
            throw domainError('invalid_input', 'Artifact exceeds inline content limit and no content store is configured')
        }
        return {
            artifactId,
            storage: this.contentStore.write({ artifactId, version, data, kind }),
            data: null
        }
    }

    readArtifactData(row) {
        if (row.data !== null && row.data !== undefined) {
            return dataToString(row.data)
        }
        const storage = row.content.storage
        if (storage?.type !== 'ref') {
            return null
        }
        if (!this.contentStore || this.contentStore.driver !== storage.driver) {
            return null
        }
        return this.contentStore.read(storage)
    }

    deleteArtifactData(row) {
        const storage = row.content.storage
        if (storage?.type !== 'ref' || !this.contentStore || this.contentStore.driver !== storage.driver) {
            return
        }
        this.contentStore.delete(storage)
    }
}

function decode(row) {
    return {
        ...row,
        content: JSON.parse(row.content || '{}'),
        metadata: JSON.parse(row.metadata || '{}')
    }
}

function orderByPrev(rows) {
    const out = []
    let prev = null
    while (rows.length) {
        const index = rows.findIndex(row => row.prev === prev)
        if (index === -1) {
            rows.sort((a, b) => a.id - b.id)
            out.push(...rows)
            break
        }
        const [row] = rows.splice(index, 1)
        out.push(row)
        prev = row.id
    }
    return out
}

function sameImportedNode(existing, candidate) {
    return existing.public_id === candidate.publicId
        && existing.kind === candidate.kind
        && JSON.stringify(existing.content) === JSON.stringify(candidate.content)
        && JSON.stringify(existing.metadata) === JSON.stringify(candidate.metadata)
        && dataToString(existing.data) === dataToString(candidate.data)
        && (existing.prev ?? null) === (candidate.prev ?? null)
        && (existing.parent ?? null) === (candidate.parent ?? null)
        && (existing.owner ?? null) === (candidate.owner ?? null)
        && existing.created_at === candidate.createdAt
}

function dataToBuffer(data) {
    if (data === null || data === undefined) return null
    if (Buffer.isBuffer(data)) return data
    if (data instanceof Uint8Array) return Buffer.from(data)
    return Buffer.from(String(data))
}

function dataToString(data) {
    if (data === null || data === undefined) return null
    if (Buffer.isBuffer(data)) return data.toString('utf8')
    if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8')
    return String(data)
}

function normalizePath(path) {
    if (!path || path.startsWith('/')) throw domainError('invalid_input', 'Invalid artifact path')
    const parts = []
    for (const part of path.split('/')) {
        if (!part || part === '.') continue
        if (part === '..') throw domainError('invalid_input', 'Invalid artifact path')
        parts.push(part)
    }
    if (!parts.length) throw domainError('invalid_input', 'Invalid artifact path')
    return parts.join('/')
}

function normalizePrefix(prefix) {
    const trimmed = prefix.replace(/\/+$/, '')
    return trimmed ? normalizePath(trimmed) : ''
}

function textFromValue(value) {
    if (value === null || value === undefined) return ''
    if (Array.isArray(value)) return value.map(textFromValue).join(' ')
    if (typeof value === 'object') return Object.values(value).map(textFromValue).join(' ')
    return String(value)
}

function id(prefix) {
    return `${prefix}_${randomBytes(12).toString('hex')}`
}

function now() {
    return new Date().toISOString()
}

function fingerprint(text) {
    let hash = 0x811c9dc5
    for (const char of text) {
        hash ^= char.charCodeAt(0)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
}

function omit(value, keys) {
    const out = { ...value }
    for (const key of keys) delete out[key]
    return out
}

function domainError(code, message) {
    const error = new Error(message)
    error.code = code
    return error
}
