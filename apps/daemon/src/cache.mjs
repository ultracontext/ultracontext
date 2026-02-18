import Redis from "ioredis";

const DEFAULT_CACHE_URL = "redis://127.0.0.1:6379";

export function resolveCacheUrl(env = process.env) {
  const fromStateStoreEnv = String(env.STATE_STORE_URL ?? "").trim();
  if (fromStateStoreEnv) return fromStateStoreEnv;
  const fromCacheEnv = String(env.CACHE_URL ?? "").trim();
  if (fromCacheEnv) return fromCacheEnv;
  const fromRedisEnv = String(env.REDIS_URL ?? "").trim();
  if (fromRedisEnv) return fromRedisEnv;
  return DEFAULT_CACHE_URL;
}

export function createCacheClient(url) {
  return new Redis(url);
}
