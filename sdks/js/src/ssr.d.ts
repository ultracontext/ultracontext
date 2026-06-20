import type { LocalUltraContextOptions, OpenProjectOptions, UltraContext as LocalUltraContext } from './local'
import type { UltraContext as BrowserUltraContext, UltraContextRemoteOptions } from './index'
import type { ContentStore, UltraContextEngine } from './types'
import type { ProjectConfigOptions } from './config'

export { UltraContextError } from './index'

export type BrowserClientOptions = UltraContextRemoteOptions
export type ServerClientOptions = OpenProjectOptions | LocalUltraContextOptions

export function createBrowserClient(config?: BrowserClientOptions): BrowserUltraContext
export function createBrowserClient(baseUrl: string | URL, options?: Omit<BrowserClientOptions, 'baseUrl'>): BrowserUltraContext

export function createServerClient(config?: ServerClientOptions): Promise<LocalUltraContext>
export function createServerClient(baseUrl: string | URL, options?: Omit<BrowserClientOptions, 'baseUrl'>): Promise<BrowserUltraContext>
export function createServerClient(config: BrowserClientOptions & { mode: 'remote' }): Promise<BrowserUltraContext>

export interface UltraContextHandlerOptions extends ProjectConfigOptions {
    basePath?: string
    engine?: UltraContextEngine
    contentStore?: ContentStore
}

export type UltraContextFetchHandler = (request: Request) => Response | Promise<Response>

export interface UltraContextRouteHandlers {
    GET: UltraContextFetchHandler
    POST: UltraContextFetchHandler
    PUT: UltraContextFetchHandler
    PATCH: UltraContextFetchHandler
    DELETE: UltraContextFetchHandler
    OPTIONS: UltraContextFetchHandler
}

export function createRouteHandler(options?: UltraContextHandlerOptions): UltraContextRouteHandlers
export function createHttpHandler(options?: UltraContextHandlerOptions): UltraContextFetchHandler
