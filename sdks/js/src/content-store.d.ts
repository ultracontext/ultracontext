export type * from './types'
import type { ArtifactStorage, ContentStore } from './types'

export interface LocalDirContentStoreOptions {
    root: string
    prefix?: string
}

export interface S3CompatibleClient {
    putObject(input: Record<string, unknown>): Promise<unknown> | unknown
    getObject(input: Record<string, unknown>): Promise<unknown> | unknown
    deleteObject?(input: Record<string, unknown>): Promise<unknown> | unknown
}

export interface S3ContentStoreOptions {
    client: S3CompatibleClient
    bucket: string
    prefix?: string
}

export interface HybridContentStoreOptions {
    cache: ContentStore
    remote: ContentStore
}

export function createLocalDirContentStore(options: LocalDirContentStoreOptions): ContentStore
export function createS3ContentStore(options: S3ContentStoreOptions): ContentStore
export function createHybridContentStore(options: HybridContentStoreOptions): ContentStore
export function shouldStoreExternally(data: unknown, inlineLimit: number): boolean
export function inlineContent(data: unknown): { storage: ArtifactStorage; data: string }
export function byteLength(data: unknown): number
