import { createClient, UltraContextError } from './index.js'
import { createLocalDirContentStore } from './content-store.js'
import { loadProjectConfig } from './config.js'
import { createUltraContextHandler } from './server.js'
import { createSqliteEngine } from './sqlite-engine.js'

export { UltraContextError } from './index.js'

export function createBrowserClient(config = {}, options = {}) {
    return createClient(config, options)
}

export async function createServerClient(config = {}, options = {}) {
    if (isRemoteConfig(config)) {
        return createClient(config, options)
    }

    const { openProject } = await import('./local.js')
    return openProject(config)
}

function isRemoteConfig(config) {
    if (typeof config === 'string' || config instanceof URL) return true
    return config?.mode === 'remote' || config?.baseUrl !== undefined
}

export function createRouteHandler(options = {}) {
    let handlerPromise = null
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    const routes = {}

    for (const method of methods) {
        routes[method] = async request => {
            const handler = await getHandler()
            return handler(rewriteRequest(request, options.basePath ?? '/api/ultracontext'))
        }
    }

    return routes

    async function getHandler() {
        if (!handlerPromise) {
            handlerPromise = createHandler(options)
        }
        return handlerPromise
    }
}

export function createHttpHandler(options = {}) {
    let handlerPromise = null
    return async request => {
        if (!handlerPromise) {
            handlerPromise = createHandler(options)
        }
        const handler = await handlerPromise
        return handler(rewriteRequest(request, options.basePath))
    }
}

async function createHandler(options) {
    if (options.engine) {
        if (typeof options.engine.install === 'function') {
            await options.engine.install()
        }
        return createUltraContextHandler({ engine: options.engine })
    }

    const project = await loadProjectConfig(options)
    const contentStore = options.contentStore ?? createLocalDirContentStore({
        root: project.contentDir,
        inlineLimit: project.inlineLimit
    })
    const engine = createSqliteEngine({
        path: project.db,
        contentStore,
        inlineLimit: project.inlineLimit
    })
    if (typeof engine.install === 'function') {
        await engine.install()
    }
    return createUltraContextHandler({ engine })
}

function rewriteRequest(request, basePath) {
    if (!basePath) return request

    const url = new URL(request.url)
    const normalized = basePath.replace(/\/+$/, '')
    if (url.pathname === normalized) {
        url.pathname = '/'
    } else if (url.pathname.startsWith(`${normalized}/`)) {
        url.pathname = url.pathname.slice(normalized.length)
    }
    return new Request(url, request)
}
