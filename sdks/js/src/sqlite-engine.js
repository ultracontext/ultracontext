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
                kind TEXT NOT NULL CHECK (kind IN ('context', 'message', 'artifact')),
                content TEXT NOT NULL DEFAULT '{}',
                metadata TEXT NOT NULL DEFAULT '{}',
                data TEXT,
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

    create(input = {}) {
        const metadata = input.metadata ?? {}
        const rootId = id('ctx')
        const createdAt = now()

        this.insertNode({
            publicId: rootId,
            kind: 'context',
            content: {},
            metadata,
            createdAt
        })
        const rootRow = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        this.insertNode({
            publicId: id('ctx'),
            kind: 'context',
            content: {},
            metadata: { operation: 'create' },
            owner: rootRow,
            createdAt: now()
        })

        return { id: rootId, metadata, created_at: createdAt }
    }

    fork(sourceId, options = {}) {
        const sourceRoot = this.root(sourceId)
        const sourceHeads = this.heads(sourceRoot.id)
        const sourceHead = sourceHeads[options.version ?? sourceHeads.length - 1]
        if (!sourceHead) {
            throw domainError('not_found', 'Version not found')
        }

        const forkId = id('ctx')
        const metadata = options.metadata ?? {}
        const createdAt = now()
        this.insertNode({
            publicId: forkId,
            kind: 'context',
            content: {},
            metadata,
            parent: sourceRoot.id,
            createdAt
        })
        const forkRoot = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        this.insertNode({
            publicId: id('ctx'),
            kind: 'context',
            content: {},
            metadata: { operation: 'fork', source: sourceId },
            owner: forkRoot,
            createdAt: now()
        })
        const forkHead = this.db.prepare('SELECT last_insert_rowid() AS id').get().id

        let prev = null
        for (const message of this.children(sourceHead.id, 'message')) {
            this.insertNode({
                publicId: id('msg'),
                kind: 'message',
                content: message.content,
                metadata: message.metadata,
                prev,
                parent: message.id,
                owner: forkHead,
                createdAt: now()
            })
            prev = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        }

        for (const artifact of this.currentArtifacts(sourceRoot.id)) {
            const forkArtifactId = id('art')
            const data = this.readArtifactData(artifact)
            const stored = this.storeArtifactContent({
                artifactId: forkArtifactId,
                version: 0,
                data,
                kind: artifact.content.kind
            })
            this.insertNode({
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
                owner: forkRoot,
                createdAt: now()
            })
        }

        return { id: forkId, metadata, created_at: createdAt }
    }

    append(contextId, messages) {
        messages = Array.isArray(messages) ? messages : [messages]
        const root = this.root(contextId)
        const head = this.currentHead(root.id)
        const existing = this.children(head.id, 'message')
        let prev = existing.at(-1)?.id ?? null

        for (const message of messages) {
            this.insertNode({
                publicId: id('msg'),
                kind: 'message',
                content: message,
                metadata: message.metadata ?? {},
                prev,
                owner: head.id,
                createdAt: now()
            })
            prev = this.db.prepare('SELECT last_insert_rowid() AS id').get().id
        }

        return { data: this.messageViews(head.id), version: this.version(head.id) }
    }

    get(contextId, options = {}) {
        const root = this.root(contextId)
        const heads = this.heads(root.id)
        const version = options.version ?? heads.length - 1
        const head = heads[version]
        if (!head) {
            throw domainError('not_found', 'Version not found')
        }
        return { id: contextId, data: this.messageViews(head.id), version }
    }

    listContexts() {
        return {
            data: this.roots().map(row => ({
                id: row.public_id,
                metadata: row.metadata,
                created_at: row.created_at
            }))
        }
    }

    update(contextId, updates, options = {}) {
        const root = this.root(contextId)
        const current = this.currentHead(root.id)
        const messages = this.children(current.id, 'message')
        const update = Array.isArray(updates) ? updates[0] : updates
        const targetIndex = update.index ?? messages.findIndex(message => message.public_id === update.id)
        if (targetIndex < 0 || targetIndex >= messages.length) {
            throw domainError('invalid_input', `Index out of range: ${targetIndex}`)
        }

        this.insertNode({
            publicId: id('ctx'),
            kind: 'context',
            content: {},
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: root.id,
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

        return { data: this.messageViews(newHead), version: this.version(newHead) }
    }

    delete(contextId, target, options = {}) {
        if (target?.permanent) {
            const root = this.root(contextId)
            this.db.prepare('DELETE FROM nodes WHERE id = ?').run(root.id)
            return { deleted: true, id: contextId }
        }
        return this.deleteMessages(contextId, Array.isArray(target) ? target : [target], options)
    }

    deleteMessages(contextId, targets, options = {}) {
        const root = this.root(contextId)
        const current = this.currentHead(root.id)
        const messages = this.children(current.id, 'message')
        const deleteIndexes = new Set(targets.map(target => {
            if (typeof target === 'number') {
                return target
            }
            if (target && typeof target === 'object' && Number.isInteger(target.index)) {
                return target.index
            }
            return messages.findIndex(message => message.public_id === target)
        }))

        this.insertNode({
            publicId: id('ctx'),
            kind: 'context',
            content: {},
            metadata: options.metadata ?? {},
            prev: current.id,
            owner: root.id,
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

        return { data: this.messageViews(newHead), version: this.version(newHead) }
    }

    save(contextId, input) {
        const root = this.root(contextId)
        const path = normalizePath(input.path)
        const current = input.id
            ? this.currentArtifactById(root.id, input.id)
            : this.currentArtifactByPath(root.id, path)

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
            owner: root.id,
            createdAt: now()
        })

        const row = this.row(this.db.prepare('SELECT last_insert_rowid() AS id').get().id)
        return this.artifactMeta(row)
    }

    load(contextId, pathOrId, options = {}) {
        const root = this.root(contextId)
        const current = pathOrId.startsWith('art_')
            ? this.currentArtifactById(root.id, pathOrId)
            : this.currentArtifactByPath(root.id, normalizePath(pathOrId))
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
        const root = this.root(contextId)
        return { data: this.currentArtifacts(root.id).map(row => this.artifactMeta(row)) }
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
        for (const row of this.chain(this.currentArtifactById(this.root(contextId).id, current.id).id).reverse()) {
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
        const result = this.search(query)
        result.data = result.data.filter(hit => (
            hit.kind === 'artifact'
            && hit.context_id === contextId
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
        for (const context of this.roots()) {
            const head = this.currentHead(context.id)
            for (const message of this.children(head.id, 'message')) {
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
            for (const artifact of this.currentArtifacts(context.id)) {
                const text = this.readArtifactData(artifact) ?? ''
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
        `).run(publicId, kind, JSON.stringify(content), JSON.stringify(metadata), data, prev, parent, owner, createdAt)
    }

    insertNodeWithId({ id: rowId, publicId, kind, content, metadata = {}, data = null, prev = null, parent = null, owner = null, createdAt }) {
        this.db.prepare(`
            INSERT INTO nodes (id, public_id, kind, content, metadata, data, prev, parent, owner, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(rowId, publicId, kind, JSON.stringify(content), JSON.stringify(metadata), data, prev, parent, owner, createdAt)
    }

    root(publicId) {
        const row = this.db.prepare(`
            SELECT * FROM nodes
            WHERE public_id = ? AND kind = 'context' AND owner IS NULL
            LIMIT 1
        `).get(publicId)
        if (!row) throw domainError('not_found', 'Context not found')
        return decode(row)
    }

    roots() {
        return this.db.prepare(`
            SELECT * FROM nodes
            WHERE kind = 'context' AND owner IS NULL
            ORDER BY created_at DESC, id DESC
        `).all().map(decode)
    }

    currentHead(rootRowId) {
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
        `).get(rootRowId)
        if (!row) throw domainError('internal', 'HEAD not found')
        return decode(row)
    }

    heads(rootRowId) {
        return this.chain(this.currentHead(rootRowId).id)
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
            const data = decoded.data ?? (decoded.kind === 'artifact' ? this.readArtifactData(decoded) : null)
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

    currentArtifactByPath(rootRowId, path) {
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
        `).get(rootRowId, path)
        return row ? decode(row) : null
    }

    currentArtifactById(rootRowId, publicId) {
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
        `).get(rootRowId, publicId)
        return row ? decode(row) : null
    }

    currentArtifacts(rootRowId) {
        return this.db.prepare(`
            SELECT n.* FROM nodes n
            WHERE n.kind = 'artifact'
              AND n.owner = ?
              AND NOT EXISTS (
                SELECT 1 FROM nodes child
                WHERE child.kind = 'artifact' AND child.prev = n.id
              )
            ORDER BY json_extract(n.content, '$.path') ASC, n.id ASC
        `).all(rootRowId).map(decode)
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
