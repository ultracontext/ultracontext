import Redis from "ioredis";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

export function resolveRedisUrl(env = process.env) {
  const fromPrimaryRedisEnv = String(env.REDIS_URL ?? "").trim();
  if (fromPrimaryRedisEnv) return fromPrimaryRedisEnv;
  const fromLegacyStateStoreEnv = String(env.STATE_STORE_URL ?? "").trim();
  if (fromLegacyStateStoreEnv) return fromLegacyStateStoreEnv;
  const fromLegacyCacheEnv = String(env.CACHE_URL ?? "").trim();
  if (fromLegacyCacheEnv) return fromLegacyCacheEnv;
  return DEFAULT_REDIS_URL;
}

export function createRedisClient(url) {
  return new Redis(url);
}
