import { UltraContextBase, UltraContextError } from './client.js'
import { maybeAttachDevtools } from './devtools.js'

export { UltraContextError } from './client.js'

export class UltraContext extends UltraContextBase {
    constructor(config = {}, options = {}) {
        const normalized = normalizeRemoteConfig(config, options)
        const transport = createRemoteTransport(normalized)
        super({ transport })
        this.mode = 'remote'
        this.baseUrl = transport.baseUrl
        this.apiKey = normalized.apiKey
        maybeAttachDevtools(this, { mode: 'remote', db: this.baseUrl }, normalized.devtools)
    }
}

export function createClient(config = {}, options = {}) {
    return new UltraContext(config, options)
}

function createRemoteTransport(config) {
    if (config.mode === 'local') {
        throw new UltraContextError(
            'local mode is Node-only; import from ultracontext/local instead',
            { code: 'invalid_input' }
        )
    }

    const fetchImpl = config.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
        throw new UltraContextError('UltraContext remote client requires fetch', {
            code: 'invalid_input'
        })
    }
    const fetchBound = fetchImpl === globalThis.fetch && typeof fetchImpl.bind === 'function'
        ? fetchImpl.bind(globalThis)
        : fetchImpl

    const baseUrl = (config.baseUrl ?? 'https://api.ultracontext.ai').replace(/\/+$/, '')
    const apiKey = config.apiKey

    return {
        baseUrl,
        async call(_operation, _localBody, remotePath, remoteInit) {
            const headers = {
                'content-type': 'application/json'
            }
            if (apiKey) {
                headers.authorization = `Bearer ${apiKey}`
            }

            const request = {
                method: remoteInit.method,
                headers
            }
            if (remoteInit.body !== undefined) {
                request.body = JSON.stringify(remoteInit.body)
            }

            const response = await fetchBound(`${baseUrl}${remotePath}`, request)
            const text = await response.text()
            const body = text ? JSON.parse(text) : null

            if (!response.ok) {
                const error = body?.error ?? body
                throw new UltraContextError(error?.message ?? 'UltraContext request failed', {
                    code: error?.code ?? 'internal',
                    status: response.status,
                    body
                })
            }

            return body
        }
    }
}

function normalizeRemoteConfig(config, options) {
    if (typeof config === 'string' || config instanceof URL) {
        return { ...options, baseUrl: String(config) }
    }
    return { ...config }
}
