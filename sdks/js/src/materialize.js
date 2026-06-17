import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

export async function materializeContext(uc, contextId, directory, options = {}) {
    const prefix = normalizePrefix(options.prefix)
    const artifacts = await uc.load(contextId)
    const written = []
    for (const artifact of artifacts.data ?? artifacts) {
        if (prefix && !artifact.path.startsWith(prefix)) continue
        const loaded = await uc.read(contextId, artifact.id)
        if (loaded.data === null || loaded.data === undefined) continue
        const file = safeJoin(directory, artifact.path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, loaded.data)
        written.push({ path: artifact.path, file, id: artifact.id, version: loaded.version })
    }
    return { data: written }
}

export async function syncDirectoryToContext(uc, contextId, directory, options = {}) {
    const prefix = normalizePrefix(options.prefix)
    const files = await walk(directory)
    const synced = []
    for (const file of files) {
        const path = toPosix(relative(directory, file))
        if (prefix && !path.startsWith(prefix)) continue
        const data = await readFile(file, 'utf8')
        const saved = await uc.write(contextId, path, data, {
            kind: kindForPath(path, options.kindByPath)
        })
        synced.push({ path: saved.path, file, id: saved.id, version: saved.version })
    }
    return { data: synced }
}

async function walk(root) {
    const out = []
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) {
            out.push(...await walk(path))
        } else if (entry.isFile()) {
            out.push(path)
        }
    }
    return out
}

function safeJoin(root, path) {
    if (!path || path.startsWith('/') || path.split('/').some(part => part === '..')) {
        throw new Error(`Invalid materialized path: ${path}`)
    }
    return join(root, ...path.split('/'))
}

function toPosix(path) {
    return path.split(sep).join('/')
}

function normalizePrefix(prefix) {
    if (!prefix) return ''
    return String(prefix).replace(/^\/+|\/+$/g, '')
}

function kindForPath(path, kindByPath) {
    if (typeof kindByPath === 'function') {
        return kindByPath(path)
    }
    if (path.endsWith('.md')) return 'text/markdown'
    if (path.endsWith('.json')) return 'application/json'
    if (path.endsWith('.txt')) return 'text/plain'
    return 'text/plain'
}
