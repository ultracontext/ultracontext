import { UltraContextBase, UltraContextError } from './client.js'
import { loadProjectConfigSync } from './config.js'

export { UltraContextError } from './client.js'

export class UltraContext extends UltraContextBase {
    constructor(config = {}) {
        const transport = createLocalTransport(config)
        super({ transport })
        this.mode = 'local'
        this.path = transport.path
        this.contentDir = transport.contentDir
        this.inlineLimit = transport.inlineLimit
        this.storageDriver = transport.storageDriver
        this.s3 = transport.s3
    }

    static async openProject(options = {}) {
        return openProject(options)
    }
}

export function createLocalClient(config = {}) {
    return new UltraContext(config)
}

export function createClient(options = {}) {
    const config = loadProjectConfigSync(options)
    return new UltraContext({
        path: config.db,
        contentDir: config.contentDir,
        inlineLimit: config.inlineLimit,
        storageDriver: config.storageDriver,
        s3: config.s3,
        native: options.native,
        core: options.core
    })
}

export async function openProject(options = {}) {
    return createClient(options)
}

function createLocalTransport(config) {
    let core = config.core
    const path = config.path ?? config.db ?? 'ultracontext.db'
    const contentDir = config.contentDir
    const inlineLimit = config.inlineLimit
    const storageDriver = config.storageDriver ?? (config.s3 ? 's3' : 'local-dir')
    const s3 = config.s3

    return {
        path,
        contentDir,
        inlineLimit,
        storageDriver,
        s3,
        call(operation, body) {
            if (!core) {
                const native = config.native ?? loadNative()
                core = new native.UltraContextCore(path, nativeOptions({ contentDir, inlineLimit, storageDriver, s3 }))
            }
            const envelope = JSON.parse(core.dispatchJson(operation, JSON.stringify(body)))
            if (envelope.error) {
                throw new UltraContextError(envelope.error.message ?? 'UltraContext request failed', {
                    code: envelope.error.code ?? 'internal',
                    body: envelope
                })
            }
            return envelope.ok
        }
    }
}

function nativeOptions(client) {
    const options = {}
    if (client.storageDriver === 's3' && client.s3 !== undefined) {
        options.s3 = JSON.stringify(client.s3)
    } else if (client.contentDir !== undefined) {
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

    try {
        return require('../native/index.js')
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') {
            throw error
        }
    }

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
