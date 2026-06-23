import { UltraContextBase, UltraContextError } from './client.js'
import { maybeAttachDevtools } from './devtools.js'
import { STATUS_BY_CODE } from './status.js'

export { UltraContextError } from './client.js'

// Reverse the canonical code->status map so HTTP statuses map back to error codes.
const CODE_BY_STATUS = Object.fromEntries(
    Object.entries(STATUS_BY_CODE).map(([code, status]) => [status, code])
)

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

            // Parse the body; a non-JSON payload becomes a status-derived error.
            let body
            try {
                body = text ? JSON.parse(text) : null
            } catch {
                throw new UltraContextError('UltraContext returned a non-JSON response', {
                    code: CODE_BY_STATUS[response.status] ?? 'internal',
                    status: response.status,
                    body: text
                })
            }

            // Surface HTTP errors as UltraContextError, deriving code from the JSON body or status.
            if (!response.ok) {
                const error = body?.error ?? body
                throw new UltraContextError(error?.message ?? 'UltraContext request failed', {
                    code: error?.code ?? CODE_BY_STATUS[response.status] ?? 'internal',
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
