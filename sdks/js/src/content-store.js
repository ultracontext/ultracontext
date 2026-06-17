import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function createLocalDirContentStore({ root, prefix = 'artifacts' } = {}) {
    if (!root) {
        throw new Error('createLocalDirContentStore requires root')
    }
    return {
        driver: 'local-dir',
        write({ artifactId, version, data, kind }) {
            const key = contentKey(prefix, artifactId, version)
            const path = safeLocalPath(root, key)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, String(data))
            return { type: 'ref', driver: 'local-dir', key, kind }
        },
        read(storage) {
            return readFileSync(safeLocalPath(root, storage.key), 'utf8')
        },
        exists(storage) {
            return existsSync(safeLocalPath(root, storage.key))
        },
        put(storage, data) {
            const path = safeLocalPath(root, storage.key)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, String(data))
        },
        delete(storage) {
            const path = safeLocalPath(root, storage.key)
            if (existsSync(path)) {
                rmSync(path)
            }
        }
    }
}

export function createS3ContentStore({ client, bucket, prefix = 'artifacts' } = {}) {
    if (!client || typeof client.putObject !== 'function' || typeof client.getObject !== 'function') {
        throw new Error('createS3ContentStore requires a client with putObject/getObject')
    }
    if (!bucket) {
        throw new Error('createS3ContentStore requires bucket')
    }
    return {
        driver: 's3',
        async write({ artifactId, version, data, kind }) {
            const key = contentKey(prefix, artifactId, version)
            await client.putObject({
                Bucket: bucket,
                Key: key,
                Body: String(data),
                ContentType: kind
            })
            return { type: 'ref', driver: 's3', bucket, key, kind }
        },
        async read(storage) {
            const object = await client.getObject({
                Bucket: storage.bucket ?? bucket,
                Key: storage.key
            })
            return bodyToString(object.Body ?? object.body ?? object)
        },
        async delete(storage) {
            if (typeof client.deleteObject !== 'function') return
            await client.deleteObject({
                Bucket: storage.bucket ?? bucket,
                Key: storage.key
            })
        }
    }
}

export function createHybridContentStore({ cache, remote } = {}) {
    if (!cache || typeof cache.read !== 'function' || typeof cache.put !== 'function') {
        throw new Error('createHybridContentStore requires a cache store with read/put')
    }
    if (!remote || typeof remote.write !== 'function' || typeof remote.read !== 'function') {
        throw new Error('createHybridContentStore requires a remote store with write/read')
    }
    return {
        driver: remote.driver,
        async write(input) {
            const storage = await remote.write(input)
            cache.put(storage, input.data)
            return storage
        },
        async read(storage) {
            if (typeof cache.exists === 'function' && cache.exists(storage)) {
                return cache.read(storage)
            }
            try {
                return cache.read(storage)
            } catch {
                const data = await remote.read(storage)
                cache.put(storage, data)
                return data
            }
        },
        async delete(storage) {
            if (typeof cache.delete === 'function') {
                cache.delete(storage)
            }
            if (typeof remote.delete === 'function') {
                await remote.delete(storage)
            }
        }
    }
}

export function shouldStoreExternally(data, inlineLimit) {
    return byteLength(data) > inlineLimit
}

export function inlineContent(data) {
    return {
        storage: { type: 'inline' },
        data: String(data)
    }
}

export function byteLength(data) {
    return Buffer.byteLength(String(data))
}

function contentKey(prefix, artifactId, version) {
    return `${trimSlashes(prefix)}/${artifactId}/v${version}`
}

function safeLocalPath(root, key) {
    if (!key || key.startsWith('/')) {
        throw new Error('Invalid content ref key')
    }
    const parts = key.split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) {
        throw new Error('Invalid content ref key')
    }
    return join(root, ...parts)
}

function trimSlashes(value) {
    return String(value).replace(/^\/+|\/+$/g, '') || 'artifacts'
}

async function bodyToString(body) {
    if (body === undefined || body === null) return ''
    if (typeof body === 'string') return body
    if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
    if (typeof body.text === 'function') return body.text()
    if (typeof body.transformToString === 'function') return body.transformToString()
    if (Symbol.asyncIterator in Object(body)) {
        const chunks = []
        for await (const chunk of body) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
        }
        return Buffer.concat(chunks).toString('utf8')
    }
    return String(body)
}
