export type * from './types'
import type { UltraContextClient, UltraContextErrorOptions } from './types'

export class UltraContextError extends Error {
    name: 'UltraContextError'
    code: string
    status?: number
    body?: unknown
    constructor(message: string, options?: UltraContextErrorOptions)
}

export interface UltraContextRemoteOptions {
    mode?: 'remote'
    baseUrl?: string
    apiKey?: string
    fetch?: typeof fetch
    devtools?: boolean | { enabled?: boolean; destroyable?: boolean }
}

export class UltraContext {
    mode: 'remote'
    baseUrl: string
    apiKey?: string
    constructor(config?: UltraContextRemoteOptions)
    constructor(baseUrl: string | URL, options?: Omit<UltraContextRemoteOptions, 'baseUrl'>)
}

export interface UltraContext extends UltraContextClient {}

export function createClient(config?: UltraContextRemoteOptions): UltraContext
export function createClient(baseUrl: string | URL, options?: Omit<UltraContextRemoteOptions, 'baseUrl'>): UltraContext
