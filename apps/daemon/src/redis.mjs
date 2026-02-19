import Redis from "ioredis";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

export function resolveRedisUrl(env = process.env) {
  const fromRedisEnv = String(env.REDIS_URL ?? "").trim();
  if (fromRedisEnv) return fromRedisEnv;
  return DEFAULT_REDIS_URL;
}

export function createRedisClient(url) {
  return new Redis(url);
}
