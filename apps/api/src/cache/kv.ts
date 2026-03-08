import type { CachedKey, KeyCache } from './types';

// =============================================================================
// KV KEY CACHE — Cloudflare Workers KV implementation
// =============================================================================

const DEFAULT_TTL = 3600;

export class KvKeyCache implements KeyCache {
    constructor(private kv: KVNamespace) {}

    async get(prefix: string): Promise<CachedKey | null> {
        const raw = await this.kv.get(`key:${prefix}`);
        if (!raw) return null;
        return JSON.parse(raw) as CachedKey;
    }

    async put(prefix: string, value: CachedKey, ttlSeconds = DEFAULT_TTL): Promise<void> {
        await this.kv.put(`key:${prefix}`, JSON.stringify(value), {
            expirationTtl: ttlSeconds,
        });
    }
}
