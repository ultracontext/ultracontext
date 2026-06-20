import type { ContentStore, UltraContextEngine } from './types'

export interface PostgresPool {
    query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[] } | unknown[] | unknown>
}

export interface PostgresEngineOptions {
    pool: PostgresPool
    idGenerator?: (prefix: string) => string
    now?: () => string
    contentStore?: ContentStore | null
    inlineLimit?: number
}

export function createPostgresEngine(options: PostgresEngineOptions): UltraContextEngine
