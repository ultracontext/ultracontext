import { randomBytes } from 'node:crypto'
import { byteLength, inlineContent, shouldStoreExternally } from './content-store.js'

export function createPostgresEngine(options = {}) {
    return new PostgresEngine(options)
}

class PostgresEngine {
    constructor({ pool, idGenerator = id, now: clock = now, contentStore = null, inlineLimit = Infinity } = {}) {
        if (!pool || typeof pool.query !== 'function') {
            throw new Error('createPostgresEngine requires a pool with query(sql, params)')
        }
        this.pool = pool
        this.id = idGenerator
        this.now = clock
        this.contentStore = contentStore
        this.inlineLimit = inlineLimit
    }

    async install() {
        await this.query(`
            CREATE TABLE IF NOT EXISTS nodes (
                id BIGSERIAL PRIMARY KEY,
                public_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('workspace', 'session', 'context', 'message', 'artifact')),
                content JSONB NOT NULL DEFAULT '{}'::jsonb,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                data TEXT,
                prev BIGINT REFERENCES nodes(id),
                parent BIGINT REFERENCES nodes(id) ON DELETE SET NULL,
                owner BIGINT REFERENCES nodes(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL
            );

            CREATE INDEX IF NOT EXISTS nodes_owner_kind ON nodes(owner, kind);
            CREATE INDEX IF NOT EXISTS nodes_public_id ON nodes(public_id);
            CREATE INDEX IF NOT EXISTS nodes_prev ON nodes(prev);
        `)
    }

    async createWorkspace(input = {}) {
        const metadata = input.metadata ?? {}
        const workspaceId = this.id('ws')
        const createdAt = this.now()
        await this.insertNode({
            publicId: workspaceId,
            kind: 'workspace',
            content: metadata,
            metadata,
            createdAt
        })
        return { id: workspaceId, metadata, created_at: createdAt }
    }

    async listWorkspaces() {
        return {
            data: (await this.workspaces()).map(row => ({
                id: row.public_id,
                metadata: row.metadata,
                created_at: row.created_at
            }))
        }
    }

    async createSession(workspaceId, input = {}) {
        const workspace = await this.workspace(workspaceId)
        return (await this.createSessionNodes(workspace, input.metadata ?? {})).session
    }

    async create(input = {}) {
        const workspace = input.workspaceId || input.workspace_id
            ? await this.workspace(input.workspaceId ?? input.workspace_id)
            : await this.ensureDefaultWorkspace()
        return (await this.createSessionNodes(workspace, input.metadata ?? {})).context
    }

    async createSessionNodes(workspace, metadata) {
        const sessionId = this.id('ses')
        const contextId = this.id('ctx')
        const createdAt = this.now()
        const sessionRow = await this.insertNode({
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

        await this.insertNode({
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
            createdAt: this.now()
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

    async fork(sourceId, options = {}) {
        const sourceSession = await this.resolveSession(sourceId)
        const workspace = await this.workspaceForSession(sourceSession)
        const sourceHeads = await this.heads(sourceSession.id)
        const sourceHead = sourceHeads[options.version ?? sourceHeads.length - 1]
        if (!sourceHead) {
            throw domainError('not_found', 'Version not found')
        }

        const created = await this.createSessionNodes(workspace, options.metadata ?? {})
        const session = created.sessionRow

        let prev = null
        for (const message of await this.contextMessages(sourceSession, sourceHead)) {
            const row = await this.insertNode({
                publicId: this.id('msg'),
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                parent: message.id,
                owner: session.id,
                createdAt: this.now()
            })
            prev = row.id
        }

        return created.context
    }

    async append(contextId, messages) {
        messages = Array.isArray(messages) ? messages : [messages]
        const session = await this.resolveSession(contextId)
        const head = await this.currentHead(session.id)
        const existing = await this.children(session.id, 'message')
        let prev = existing.at(-1)?.id ?? null
        let projectedPrev = (await this.children(head.id, 'message')).at(-1)?.id ?? null
        const projectIntoHead = head.content.projection === true

        for (const message of messages) {
            const row = await this.insertNode({
                publicId: this.id('msg'),
                kind: 'message',
                content: message,
                metadata: message.metadata ?? {},
                prev,
                owner: session.id,
                createdAt: this.now()
            })
            prev = row.id

            if (projectIntoHead) {
                const projected = await this.insertNode({
                    publicId: this.id('msg'),
                    kind: 'message',
                    content: message,
                    metadata: message.metadata ?? {},
                    prev: projectedPrev,
                    parent: row.id,
                    owner: head.id,
                    createdAt: this.now()
                })
                projectedPrev = projected.id
            }
        }

        return { context_id: head.public_id, data: await this.contextMessageViews(session, head), version: await this.version(head.id) }
    }

    async get(contextId, options = {}) {
        const session = await this.resolveSession(contextId)
        const heads = await this.heads(session.id)
        const version = options.version ?? heads.length - 1
        const head = heads[version]
        if (!head) {
            throw domainError('not_found', 'Version not found')
        }
        return { id: contextId, context_id: head.public_id, data: await this.contextMessageViews(session, head), version }
    }

    async contextHistory(contextId) {
        const session = await this.resolveSession(contextId)
        const heads = await this.heads(session.id)
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

    async listContexts() {
        return {
            data: (await this.sessions()).map(row => ({
                id: row.public_id,
                metadata: row.metadata,
                created_at: row.created_at
            }))
        }
    }

    async update(contextId, updates, options = {}) {
        const session = await this.resolveSession(contextId)
        const current = await this.currentHead(session.id)
        const messages = await this.contextMessages(session, current)
        const update = Array.isArray(updates) ? updates[0] : updates
        const targetIndex = update.index ?? messages.findIndex(message => message.public_id === update.id)
        if (targetIndex < 0 || targetIndex >= messages.length) {
            throw domainError('invalid_input', `Index out of range: ${targetIndex}`)
        }

        const newContextId = this.id('ctx')
        const newHead = await this.insertNode({
            publicId: newContextId,
            kind: 'context',
            content: { role: 'head', operation: 'update', projection: true },
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: session.id,
            createdAt: this.now()
        })

        let prev = null
        for (const [index, message] of messages.entries()) {
            const nextContent = index === targetIndex
                ? { ...message.content, ...omit(update, ['id', 'index']) }
                : message.content
            const row = await this.insertNode({
                publicId: index === targetIndex ? this.id('msg') : message.public_id,
                kind: 'message',
                content: nextContent,
                metadata: message.metadata,
                prev,
                parent: index === targetIndex ? message.id : null,
                owner: newHead.id,
                createdAt: this.now()
            })
            prev = row.id
        }

        return { context_id: newContextId, data: await this.messageViews(newHead.id), version: await this.version(newHead.id) }
    }

    async delete(contextId, target, options = {}) {
        if (target?.permanent) {
            const session = await this.resolveSession(contextId)
            await this.query('DELETE FROM nodes WHERE id = $1', [session.id])
            return { deleted: true, id: contextId }
        }
        return this.deleteMessages(contextId, Array.isArray(target) ? target : [target], options)
    }

    async deleteMessages(contextId, targets, options = {}) {
        const session = await this.resolveSession(contextId)
        const current = await this.currentHead(session.id)
        const messages = await this.contextMessages(session, current)
        const deleteIndexes = new Set(targets.map(target => {
            if (typeof target === 'number') {
                return target
            }
            if (target && typeof target === 'object' && Number.isInteger(target.index)) {
                return target.index
            }
            return messages.findIndex(message => message.public_id === target)
        }))

        const newContextId = this.id('ctx')
        const newHead = await this.insertNode({
            publicId: newContextId,
            kind: 'context',
            content: { role: 'head', operation: 'delete', projection: true },
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: session.id,
            createdAt: this.now()
        })

        let prev = null
        for (const [index, message] of messages.entries()) {
            if (deleteIndexes.has(index)) continue
            const row = await this.insertNode({
                publicId: message.public_id,
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                owner: newHead.id,
                createdAt: this.now()
            })
            prev = row.id
        }

        return { context_id: newContextId, data: await this.messageViews(newHead.id), version: await this.version(newHead.id) }
    }

    async clear(contextId, options = {}) {
        const session = await this.resolveSession(contextId)
        const current = await this.currentHead(session.id)
        const newContextId = this.id('ctx')
        const newHead = await this.insertNode({
            publicId: newContextId,
            kind: 'context',
            content: { role: 'head', operation: 'clear', projection: true },
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: session.id,
            createdAt: this.now()
        })
        return { context_id: newContextId, data: [], version: await this.version(newHead.id) }
    }

    async restore(contextId, restoreContextId, options = {}) {
        const session = await this.resolveSession(contextId)
        const current = await this.currentHead(session.id)
        const source = await this.contextHeadByPublicId(session.id, restoreContextId)
        const messages = await this.contextMessages(session, source)
        const newContextId = this.id('ctx')
        const newHead = await this.insertNode({
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
            createdAt: this.now()
        })

        let prev = null
        for (const message of messages) {
            const row = await this.insertNode({
                publicId: message.public_id,
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                parent: message.id,
                owner: newHead.id,
                createdAt: this.now()
            })
            prev = row.id
        }

        return { context_id: newContextId, data: await this.messageViews(newHead.id), version: await this.version(newHead.id) }
    }

    async save(contextId, input) {
        const session = await this.resolveSession(contextId)
        const workspace = await this.workspaceForSession(session)
        const path = normalizePath(input.path)
        const current = input.id
            ? await this.currentArtifactById(workspace.id, input.id)
            : await this.currentArtifactByPath(workspace.id, path)

        if (input.ifVersion !== undefined) {
            if (!current || await this.artifactVersion(current.id) !== input.ifVersion) {
                throw domainError('conflict', 'Artifact version conflict')
            }
        }

        const data = input.data ?? ''
        const version = current ? await this.artifactVersion(current.id) + 1 : 0
        const artifactId = current?.public_id ?? this.id('art')
        const stored = await this.storeArtifactContent({
            artifactId,
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

        const row = await this.insertNode({
            publicId: artifactId,
            kind: 'artifact',
            content,
            metadata: input.metadata ?? {},
            data: stored.data,
            prev: current?.id ?? null,
            parent: current?.id ?? null,
            owner: workspace.id,
            createdAt: this.now()
        })
        return this.artifactMeta(row, version)
    }

    async load(contextId, pathOrId, options = {}) {
        const session = await this.resolveSession(contextId)
        const workspace = await this.workspaceForSession(session)
        const current = pathOrId.startsWith('art_')
            ? await this.currentArtifactById(workspace.id, pathOrId)
            : await this.currentArtifactByPath(workspace.id, normalizePath(pathOrId))
        if (!current) {
            throw domainError('not_found', 'Artifact not found')
        }
        const chain = await this.chain(current.id)
        const version = options.version ?? chain.length - 1
        const row = chain[version]
        if (!row) {
            throw domainError('not_found', 'Artifact version not found')
        }
        return this.artifactData(row, version)
    }

    async listArtifacts(contextId) {
        const session = await this.resolveSession(contextId)
        const workspace = await this.workspaceForSession(session)
        const rows = await this.currentArtifacts(workspace.id)
        return { data: await Promise.all(rows.map(row => this.artifactMeta(row))) }
    }

    async read(contextId, pathOrId, options = {}) {
        return this.load(contextId, pathOrId, options)
    }

    async write(contextId, path, data, options = {}) {
        return this.save(contextId, { path, data, ...options })
    }

    async move(contextId, fromPathOrId, toPath, options = {}) {
        const current = await this.load(contextId, fromPathOrId)
        return this.save(contextId, {
            id: current.id,
            path: toPath,
            kind: current.kind,
            data: current.data,
            metadata: current.metadata,
            ifVersion: options.ifVersion
        })
    }

    async remove(contextId, pathOrId, options = {}) {
        const current = await this.load(contextId, pathOrId)
        if (options.ifVersion !== undefined && current.version !== options.ifVersion) {
            throw domainError('conflict', 'Artifact version conflict')
        }
        const session = await this.resolveSession(contextId)
        const workspace = await this.workspaceForSession(session)
        const latest = await this.currentArtifactById(workspace.id, current.id)
        for (const row of (await this.chain(latest.id)).reverse()) {
            await this.deleteArtifactData(row)
            await this.query('DELETE FROM nodes WHERE id = $1', [row.id])
        }
        return { deleted: true, id: current.id }
    }

    async glob(contextId, pattern) {
        const prefix = pattern.replace(/\*\*?\/?.*$/, '')
        return { data: (await this.listArtifacts(contextId)).data.filter(file => file.path.startsWith(prefix)) }
    }

    async grep(contextId, query, options = {}) {
        const prefix = options.prefix ? normalizePrefix(options.prefix) : null
        const session = await this.resolveSession(contextId)
        const result = await this.search(query)
        result.data = result.data.filter(hit => (
            hit.kind === 'artifact'
            && hit.context_id === session.public_id
            && (!prefix || hit.path?.startsWith(prefix))
        ))
        return result
    }

    async search(query) {
        const needle = query.trim().toLowerCase()
        if (!needle) {
            throw domainError('invalid_input', 'Search query is empty')
        }
        const hits = []
        for (const session of await this.sessions()) {
            const head = await this.currentHead(session.id)
            for (const message of await this.contextMessages(session, head)) {
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
            const workspace = await this.workspaceForSession(session)
            for (const artifact of await this.currentArtifacts(workspace.id)) {
                const text = await this.readArtifactData(artifact) ?? ''
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
        return { data: hits.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) }
    }

    async exportSnapshot() {
        return {
            schema: 'ultracontext.snapshot.v1',
            cursor: await this.cursor(),
            nodes: await this.exportNodes()
        }
    }

    async exportChanges({ since = 0 } = {}) {
        return {
            schema: 'ultracontext.changes.v1',
            since,
            cursor: await this.cursor(),
            nodes: await this.exportNodes(since)
        }
    }

    async importSnapshot(snapshot) {
        if (snapshot?.schema !== 'ultracontext.snapshot.v1') {
            throw domainError('invalid_input', 'Unsupported snapshot schema')
        }
        return this.importNodes(snapshot.nodes ?? [])
    }

    async importChanges(changes) {
        if (changes?.schema !== 'ultracontext.changes.v1') {
            throw domainError('invalid_input', 'Unsupported changes schema')
        }
        return this.importNodes(changes.nodes ?? [])
    }

    async insertNode({ publicId, kind, content, metadata = {}, data = null, prev = null, parent = null, owner = null, createdAt }) {
        const result = await this.query(`
            INSERT INTO nodes (public_id, kind, content, metadata, data, prev, parent, owner, created_at)
            VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)
            RETURNING *
        `, [publicId, kind, content, metadata, data, prev, parent, owner, createdAt])
        return decode({
            public_id: publicId,
            kind,
            content,
            metadata,
            data,
            prev,
            parent,
            owner,
            created_at: createdAt,
            ...result.rows[0]
        })
    }

    async insertNodeWithId({ id: rowId, publicId, kind, content, metadata = {}, data = null, prev = null, parent = null, owner = null, createdAt }) {
        await this.query(`
            INSERT INTO nodes (id, public_id, kind, content, metadata, data, prev, parent, owner, created_at)
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)
        `, [rowId, publicId, kind, content, metadata, data, prev, parent, owner, createdAt])
    }

    async ensureDefaultWorkspace() {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE public_id = 'ws_default' AND kind = 'workspace'
            LIMIT 1
        `)
        if (result.rows[0]) return decode(result.rows[0])

        return this.insertNode({
            publicId: 'ws_default',
            kind: 'workspace',
            content: { name: 'default', default: true },
            metadata: { name: 'default', default: true },
            createdAt: this.now()
        })
    }

    async workspace(publicId) {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE public_id = $1 AND kind = 'workspace'
            LIMIT 1
        `, [publicId])
        const row = result.rows[0]
        if (!row) throw domainError('not_found', 'Workspace not found')
        return decode(row)
    }

    async workspaces() {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE kind = 'workspace'
            ORDER BY created_at ASC, id ASC
        `)
        return result.rows.map(decode)
    }

    async session(publicId) {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE public_id = $1 AND kind = 'session'
            LIMIT 1
        `, [publicId])
        return result.rows[0] ? decode(result.rows[0]) : null
    }

    async resolveSession(publicId) {
        const direct = await this.session(publicId)
        if (direct) return direct

        const result = await this.query(`
            SELECT session.* FROM nodes context
            JOIN nodes session ON session.id = context.owner
            WHERE context.public_id = $1
              AND context.kind = 'context'
              AND session.kind = 'session'
            LIMIT 1
        `, [publicId])
        const row = result.rows[0]
        if (!row) throw domainError('not_found', 'Session not found')
        return decode(row)
    }

    async workspaceForSession(session) {
        const result = await this.query(`
            SELECT workspace.* FROM nodes session
            JOIN nodes workspace ON workspace.id = session.owner
            WHERE session.id = $1
              AND session.kind = 'session'
              AND workspace.kind = 'workspace'
            LIMIT 1
        `, [session.id])
        const row = result.rows[0]
        if (!row) throw domainError('internal', 'Workspace not found for session')
        return decode(row)
    }

    async sessions() {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE kind = 'session'
            ORDER BY created_at DESC, id DESC
        `)
        return result.rows.map(decode)
    }

    async currentHead(sessionRowId) {
        const result = await this.query(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'context'
              AND n.owner = $1
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'context' AND child.prev = n.id
              )
            ORDER BY n.id DESC
            LIMIT 1
        `, [sessionRowId])
        const row = result.rows[0]
        if (!row) throw domainError('internal', 'HEAD not found')
        return decode(row)
    }

    async heads(sessionRowId) {
        return this.chain((await this.currentHead(sessionRowId)).id)
    }

    async contextHeadByPublicId(sessionRowId, publicId) {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE kind = 'context' AND owner = $1 AND public_id = $2
            LIMIT 1
        `, [sessionRowId, publicId])
        const row = result.rows[0]
        if (!row) throw domainError('not_found', 'Context snapshot not found')
        return decode(row)
    }

    async children(owner, kind) {
        const result = await this.query(`
            SELECT * FROM nodes WHERE owner = $1 AND kind = $2
        `, [owner, kind])
        return orderByPrev(result.rows.map(decode))
    }

    async messageViews(headRowId) {
        return (await this.children(headRowId, 'message')).map((row, index) => ({
            id: row.public_id,
            index,
            ...row.content,
            metadata: row.metadata,
            created_at: row.created_at
        }))
    }

    async contextMessages(session, head) {
        if (head.content.projection !== true) {
            return this.children(session.id, 'message')
        }
        return this.children(head.id, 'message')
    }

    async contextMessageViews(session, head) {
        return (await this.contextMessages(session, head)).map((row, index) => ({
            id: row.public_id,
            index,
            ...row.content,
            metadata: row.metadata,
            created_at: row.created_at
        }))
    }

    async version(headRowId) {
        return (await this.chain(headRowId)).length - 1
    }

    async row(rowId) {
        const result = await this.query('SELECT * FROM nodes WHERE id = $1', [rowId])
        const row = result.rows[0]
        if (!row) throw domainError('internal', 'Node not found')
        return decode(row)
    }

    async cursor() {
        const result = await this.query('SELECT COALESCE(MAX(id), 0) AS cursor FROM nodes')
        return Number(result.rows[0]?.cursor ?? 0)
    }

    async exportNodes(since = null) {
        const result = since === null || since === undefined
            ? await this.query('SELECT * FROM nodes ORDER BY id ASC')
            : await this.query('SELECT * FROM nodes WHERE id > $1 ORDER BY id ASC', [since])
        return Promise.all(result.rows.map(async row => {
            const decoded = decode(row)
            const data = decoded.data ?? (decoded.kind === 'artifact' ? await this.readArtifactData(decoded) : null)
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
        }))
    }

    async importNodes(nodes) {
        let imported = 0
        let skipped = 0
        const conflicts = []
        for (const node of nodes) {
            const existing = await this.query('SELECT * FROM nodes WHERE id = $1 LIMIT 1', [node.id])
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
            if (existing.rows[0]) {
                if (sameImportedNode(decode(existing.rows[0]), candidate)) {
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
            await this.insertNodeWithId(candidate)
            imported += 1
        }
        return { imported, skipped, conflicts }
    }

    async chain(rowId) {
        const rows = []
        let cursor = rowId
        while (cursor) {
            const row = await this.row(cursor)
            rows.push(row)
            cursor = row.prev
        }
        return rows.reverse()
    }

    async currentArtifactByPath(ownerRowId, path) {
        const result = await this.query(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = $1
              AND n.content->>'path' = $2
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY n.id DESC
            LIMIT 1
        `, [ownerRowId, path])
        return result.rows[0] ? decode(result.rows[0]) : null
    }

    async currentArtifactById(ownerRowId, publicId) {
        const result = await this.query(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = $1
              AND n.public_id = $2
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY n.id DESC
            LIMIT 1
        `, [ownerRowId, publicId])
        return result.rows[0] ? decode(result.rows[0]) : null
    }

    async currentArtifacts(ownerRowId) {
        const result = await this.query(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = $1
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY n.content->>'path' ASC, n.id ASC
        `, [ownerRowId])
        return result.rows.map(decode)
    }

    async artifactVersion(rowId) {
        return (await this.chain(rowId)).length - 1
    }

    async query(text, params = []) {
        return this.pool.query(text, params)
    }

    async artifactMeta(row, version) {
        return {
            id: row.public_id,
            path: row.content.path,
            kind: row.content.kind,
            size: row.content.size,
            version: version ?? await this.artifactVersion(row.id),
            created_at: row.created_at
        }
    }

    async artifactData(row, version) {
        return {
            ...await this.artifactMeta(row, version),
            metadata: row.metadata,
            storage: row.content.storage ?? { type: 'inline' },
            data: await this.readArtifactData(row)
        }
    }

    async storeArtifactContent({ artifactId, version, data, kind }) {
        if (!shouldStoreExternally(data, this.inlineLimit)) {
            return { artifactId, ...inlineContent(data) }
        }
        if (!this.contentStore) {
            throw domainError('invalid_input', 'Artifact exceeds inline content limit and no content store is configured')
        }
        return {
            artifactId,
            storage: await this.contentStore.write({ artifactId, version, data, kind }),
            data: null
        }
    }

    async readArtifactData(row) {
        if (row.data !== null && row.data !== undefined) {
            return row.data
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

    async deleteArtifactData(row) {
        const storage = row.content.storage
        if (storage?.type !== 'ref' || !this.contentStore || this.contentStore.driver !== storage.driver) {
            return
        }
        await this.contentStore.delete(storage)
    }
}

function decode(row) {
    return {
        ...row,
        content: decodeJson(row.content),
        metadata: decodeJson(row.metadata),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
    }
}

function decodeJson(value) {
    if (value === undefined || value === null) return {}
    if (typeof value === 'string') return JSON.parse(value || '{}')
    return value
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
        && (existing.data ?? null) === (candidate.data ?? null)
        && (existing.prev ?? null) === (candidate.prev ?? null)
        && (existing.parent ?? null) === (candidate.parent ?? null)
        && (existing.owner ?? null) === (candidate.owner ?? null)
        && existing.created_at === candidate.createdAt
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
