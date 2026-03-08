// =============================================================================
// KEY CACHE — optional caching layer for API key lookups
// =============================================================================

export type CachedKey = {
    keyHash: string;
    apiKeyId: number;
    projectId: number;
};

export interface KeyCache {
    get(prefix: string): Promise<CachedKey | null>;
    put(prefix: string, value: CachedKey, ttlSeconds?: number): Promise<void>;
}
