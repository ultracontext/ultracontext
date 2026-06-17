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
                kind TEXT NOT NULL CHECK (kind IN ('context', 'message', 'artifact')),
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

    async create(input = {}) {
        const metadata = input.metadata ?? {}
        const rootId = this.id('ctx')
        const createdAt = this.now()
        const root = await this.insertNode({
            publicId: rootId,
            kind: 'context',
            content: {},
            metadata,
            createdAt
        })

        await this.insertNode({
            publicId: this.id('ctx'),
            kind: 'context',
            content: {},
            metadata: { operation: 'create' },
            owner: root.id,
            createdAt: this.now()
        })

        return { id: rootId, metadata, created_at: createdAt }
    }

    async fork(sourceId, options = {}) {
        const sourceRoot = await this.root(sourceId)
        const sourceHeads = await this.heads(sourceRoot.id)
        const sourceHead = sourceHeads[options.version ?? sourceHeads.length - 1]
        if (!sourceHead) {
            throw domainError('not_found', 'Version not found')
        }

        const forkId = this.id('ctx')
        const metadata = options.metadata ?? {}
        const createdAt = this.now()
        const forkRoot = await this.insertNode({
            publicId: forkId,
            kind: 'context',
            content: {},
            metadata,
            parent: sourceRoot.id,
            createdAt
        })
        const forkHead = await this.insertNode({
            publicId: this.id('ctx'),
            kind: 'context',
            content: {},
            metadata: { operation: 'fork', source: sourceId },
            owner: forkRoot.id,
            createdAt: this.now()
        })

        let prev = null
        for (const message of await this.children(sourceHead.id, 'message')) {
            const row = await this.insertNode({
                publicId: this.id('msg'),
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                parent: message.id,
                owner: forkHead.id,
                createdAt: this.now()
            })
            prev = row.id
        }

        for (const artifact of await this.currentArtifacts(sourceRoot.id)) {
            const forkArtifactId = this.id('art')
            const data = await this.readArtifactData(artifact)
            const stored = await this.storeArtifactContent({
                artifactId: forkArtifactId,
                version: 0,
                data,
                kind: artifact.content.kind
            })
            await this.insertNode({
                publicId: forkArtifactId,
                kind: 'artifact',
                content: {
                    ...artifact.content,
                    size: byteLength(data),
                    sha256: fingerprint(String(data)),
                    storage: stored.storage
                },
                metadata: artifact.metadata,
                data: stored.data,
                parent: artifact.id,
                owner: forkRoot.id,
                createdAt: this.now()
            })
        }

        return { id: forkId, metadata, created_at: createdAt }
    }

    async append(contextId, messages) {
        messages = Array.isArray(messages) ? messages : [messages]
        const root = await this.root(contextId)
        const head = await this.currentHead(root.id)
        const existing = await this.children(head.id, 'message')
        let prev = existing.at(-1)?.id ?? null

        for (const message of messages) {
            const row = await this.insertNode({
                publicId: this.id('msg'),
                kind: 'message',
                content: message,
                metadata: message.metadata ?? {},
                prev,
                owner: head.id,
                createdAt: this.now()
            })
            prev = row.id
        }

        return { data: await this.messageViews(head.id), version: await this.version(head.id) }
    }

    async get(contextId, options = {}) {
        const root = await this.root(contextId)
        const heads = await this.heads(root.id)
        const version = options.version ?? heads.length - 1
        const head = heads[version]
        if (!head) {
            throw domainError('not_found', 'Version not found')
        }
        return { id: contextId, data: await this.messageViews(head.id), version }
    }

    async listContexts() {
        return {
            data: (await this.roots()).map(row => ({
                id: row.public_id,
                metadata: row.metadata,
                created_at: row.created_at
            }))
        }
    }

    async update(contextId, updates, options = {}) {
        const root = await this.root(contextId)
        const current = await this.currentHead(root.id)
        const messages = await this.children(current.id, 'message')
        const update = Array.isArray(updates) ? updates[0] : updates
        const targetIndex = update.index ?? messages.findIndex(message => message.public_id === update.id)
        if (targetIndex < 0 || targetIndex >= messages.length) {
            throw domainError('invalid_input', `Index out of range: ${targetIndex}`)
        }

        const newHead = await this.insertNode({
            publicId: this.id('ctx'),
            kind: 'context',
            content: {},
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: root.id,
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

        return { data: await this.messageViews(newHead.id), version: await this.version(newHead.id) }
    }

    async delete(contextId, target, options = {}) {
        if (target?.permanent) {
            const root = await this.root(contextId)
            await this.query('DELETE FROM nodes WHERE id = $1', [root.id])
            return { deleted: true, id: contextId }
        }
        return this.deleteMessages(contextId, Array.isArray(target) ? target : [target], options)
    }

    async deleteMessages(contextId, targets, options = {}) {
        const root = await this.root(contextId)
        const current = await this.currentHead(root.id)
        const messages = await this.children(current.id, 'message')
        const deleteIndexes = new Set(targets.map(target => {
            if (typeof target === 'number') {
                return target
            }
            if (target && typeof target === 'object' && Number.isInteger(target.index)) {
                return target.index
            }
            return messages.findIndex(message => message.public_id === target)
        }))

        const newHead = await this.insertNode({
            publicId: this.id('ctx'),
            kind: 'context',
            content: {},
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: root.id,
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

        return { data: await this.messageViews(newHead.id), version: await this.version(newHead.id) }
    }

    async save(contextId, input) {
        const root = await this.root(contextId)
        const path = normalizePath(input.path)
        const current = input.id
            ? await this.currentArtifactById(root.id, input.id)
            : await this.currentArtifactByPath(root.id, path)

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
            owner: root.id,
            createdAt: this.now()
        })
        return this.artifactMeta(row, version)
    }

    async load(contextId, pathOrId, options = {}) {
        const root = await this.root(contextId)
        const current = pathOrId.startsWith('art_')
            ? await this.currentArtifactById(root.id, pathOrId)
            : await this.currentArtifactByPath(root.id, normalizePath(pathOrId))
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
        const root = await this.root(contextId)
        const rows = await this.currentArtifacts(root.id)
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
        const root = await this.root(contextId)
        const latest = await this.currentArtifactById(root.id, current.id)
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
        const result = await this.search(query)
        result.data = result.data.filter(hit => (
            hit.kind === 'artifact'
            && hit.context_id === contextId
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
        for (const context of await this.roots()) {
            const head = await this.currentHead(context.id)
            for (const message of await this.children(head.id, 'message')) {
                const text = textFromValue(message.content)
                if (text.toLowerCase().includes(needle)) {
                    hits.push({
                        kind: 'message',
                        id: message.public_id,
                        context_id: context.public_id,
                        path: null,
                        snippet: text,
                        metadata: message.metadata,
                        created_at: message.created_at
                    })
                }
            }
            for (const artifact of await this.currentArtifacts(context.id)) {
                const text = await this.readArtifactData(artifact) ?? ''
                if (artifact.content.kind?.startsWith('text/') && text.toLowerCase().includes(needle)) {
                    hits.push({
                        kind: 'artifact',
                        id: artifact.public_id,
                        context_id: context.public_id,
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

    async root(publicId) {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE public_id = $1 AND kind = 'context' AND owner IS NULL
            LIMIT 1
        `, [publicId])
        const row = result.rows[0]
        if (!row) throw domainError('not_found', 'Context not found')
        return decode(row)
    }

    async roots() {
        const result = await this.query(`
            SELECT * FROM nodes
            WHERE kind = 'context' AND owner IS NULL
            ORDER BY created_at DESC, id DESC
        `)
        return result.rows.map(decode)
    }

    async currentHead(rootRowId) {
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
        `, [rootRowId])
        const row = result.rows[0]
        if (!row) throw domainError('internal', 'HEAD not found')
        return decode(row)
    }

    async heads(rootRowId) {
        return this.chain((await this.currentHead(rootRowId)).id)
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

    async currentArtifactByPath(rootRowId, path) {
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
        `, [rootRowId, path])
        return result.rows[0] ? decode(result.rows[0]) : null
    }

    async currentArtifactById(rootRowId, publicId) {
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
        `, [rootRowId, publicId])
        return result.rows[0] ? decode(result.rows[0]) : null
    }

    async currentArtifacts(rootRowId) {
        const result = await this.query(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = $1
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY n.content->>'path' ASC, n.id ASC
        `, [rootRowId])
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
