import type { UltraContextEngine } from './types'
export { createServerClient } from './ssr'

export interface UltraContextServerOptions {
    engine: UltraContextEngine
}

export type UltraContextFetchHandler = (request: Request) => Response | Promise<Response>

export function createUltraContextHandler(options: UltraContextServerOptions): UltraContextFetchHandler
