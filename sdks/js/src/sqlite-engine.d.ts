import type { ContentStore, UltraContextEngine } from './types'

export interface SqliteEngineOptions {
    path?: string
    contentStore?: ContentStore | null
    inlineLimit?: number
}

export function createSqliteEngine(options?: SqliteEngineOptions): UltraContextEngine
