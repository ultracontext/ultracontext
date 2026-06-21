export type * from './types'
import type { UltraContextClient, UltraContextErrorOptions } from './types'
import type { ProjectConfigOptions, S3ProjectConfig } from './config'

export class UltraContextError extends Error {
    name: 'UltraContextError'
    code: string
    status?: number
    body?: unknown
    constructor(message: string, options?: UltraContextErrorOptions)
}

export interface UltraContextNativeBinding {
    UltraContextCore: new (path: string, options?: Record<string, unknown>) => {
        dispatchJson(operation: string, payload: string): string
    }
}

export interface LocalUltraContextOptions {
    path?: string
    db?: string
    contentDir?: string
    inlineLimit?: number
    storageDriver?: 'local-dir' | 's3' | 'inline' | string
    s3?: S3ProjectConfig
    native?: UltraContextNativeBinding
    core?: {
        dispatchJson(operation: string, payload: string): string
    }
}

export interface OpenProjectOptions extends ProjectConfigOptions {
    native?: UltraContextNativeBinding
    core?: {
        dispatchJson(operation: string, payload: string): string
    }
}

export class UltraContext {
    mode: 'local'
    path: string
    contentDir?: string
    inlineLimit?: number
    storageDriver?: string
    s3?: S3ProjectConfig
    constructor(config?: LocalUltraContextOptions)
    static openProject(options?: OpenProjectOptions): Promise<UltraContext>
}

export interface UltraContext extends UltraContextClient {}

export function createLocalClient(config?: LocalUltraContextOptions): UltraContext
export function openProject(options?: OpenProjectOptions): Promise<UltraContext>
