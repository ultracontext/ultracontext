import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { expandHome } from "./utils.mjs";

const DEFAULT_DB_PATH = "~/.ultracontext/daemon.db";

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseNumber(value, fallback = 0) {
  const num = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(num) ? num : fallback;
}

function parseBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function resolveDbPath(env = process.env) {
  return expandHome(env.ULTRACONTEXT_DB_FILE ?? DEFAULT_DB_PATH);
}

export function createStore({ dbPath = resolveDbPath(process.env) } = {}) {
  const resolvedPath = path.resolve(dbPath);
  ensureParentDir(resolvedPath);

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_events (
      event_hash TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS file_offsets (
      file_key TEXT PRIMARY KEY,
      offset_value INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS daemon_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS context_cache (
      cache_key TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);

  const stmt = {
    markSeen: db.prepare(`
      INSERT OR IGNORE INTO seen_events (event_hash, expires_at)
      VALUES (?, ?)
    `),
    deleteSeenIfExpired: db.prepare(`
      DELETE FROM seen_events
      WHERE event_hash = ? AND expires_at <= unixepoch()
    `),
    cleanupSeen: db.prepare(`
      DELETE FROM seen_events
      WHERE expires_at <= unixepoch()
    `),
    getSeen: db.prepare(`
      SELECT event_hash
      FROM seen_events
      WHERE event_hash = ? AND expires_at > unixepoch()
      LIMIT 1
    `),
    getOffset: db.prepare(`
      SELECT offset_value
      FROM file_offsets
      WHERE file_key = ?
      LIMIT 1
    `),
    setOffset: db.prepare(`
      INSERT INTO file_offsets (file_key, offset_value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(file_key) DO UPDATE SET
        offset_value = excluded.offset_value,
        updated_at = unixepoch()
    `),
    getConfig: db.prepare(`
      SELECT value
      FROM daemon_config
      WHERE key = ?
      LIMIT 1
    `),
    setConfig: db.prepare(`
      INSERT INTO daemon_config (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = unixepoch()
    `),
    deleteConfig: db.prepare(`
      DELETE FROM daemon_config
      WHERE key = ?
    `),
    getAllConfig: db.prepare(`
      SELECT key, value
      FROM daemon_config
    `),
    getContextCache: db.prepare(`
      SELECT context_id
      FROM context_cache
      WHERE cache_key = ?
      LIMIT 1
    `),
    setContextCache: db.prepare(`
      INSERT INTO context_cache (cache_key, context_id, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(cache_key) DO UPDATE SET
        context_id = excluded.context_id,
        updated_at = unixepoch()
    `),
  };

  const markEventSeenTxn = db.transaction((eventHash, ttlSeconds) => {
    stmt.deleteSeenIfExpired.run(eventHash);
    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(parseNumber(ttlSeconds, 60), 1);
    const result = stmt.markSeen.run(eventHash, expiresAt);
    return result.changes === 1;
  });

  return {
    dbPath: resolvedPath,
    markEventSeen(eventHash, ttlSeconds) {
      return markEventSeenTxn(String(eventHash ?? ""), ttlSeconds);
    },
    isEventSeen(eventHash) {
      return Boolean(stmt.getSeen.get(String(eventHash ?? "")));
    },
    cleanupExpired() {
      stmt.cleanupSeen.run();
    },
    getOffset(fileKey) {
      const row = stmt.getOffset.get(String(fileKey ?? ""));
      return row ? parseNumber(row.offset_value, 0) : 0;
    },
    setOffset(fileKey, value) {
      stmt.setOffset.run(String(fileKey ?? ""), parseNumber(value, 0));
    },
    getConfig(key) {
      const row = stmt.getConfig.get(String(key ?? ""));
      return row ? String(row.value ?? "") : null;
    },
    setConfig(key, value) {
      stmt.setConfig.run(String(key ?? ""), String(value ?? ""));
    },
    deleteConfig(key) {
      stmt.deleteConfig.run(String(key ?? ""));
    },
    getAllConfig() {
      const out = {};
      for (const row of stmt.getAllConfig.all()) {
        out[String(row.key)] = String(row.value ?? "");
      }
      return out;
    },
    getConfigBool(key, fallback = false) {
      return parseBool(this.getConfig(key), fallback);
    },
    getConfigInt(key, fallback = 0) {
      return parseNumber(this.getConfig(key), fallback);
    },
    getContextCache(cacheKey) {
      const row = stmt.getContextCache.get(String(cacheKey ?? ""));
      return row ? String(row.context_id ?? "") : "";
    },
    setContextCache(cacheKey, contextId) {
      stmt.setContextCache.run(String(cacheKey ?? ""), String(contextId ?? ""));
    },
    close() {
      db.close();
    },
  };
}
