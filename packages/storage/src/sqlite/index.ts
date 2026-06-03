import { SCHEMA_SQL, schema } from './schema';
import { SqliteAdapter } from './adapter';
import type { SqliteDb } from './adapter';

// =============================================================================
// SQLITE DRIVER FACTORY — local-first StorageAdapter over SQLite (file/:memory:).
// Dual-driver: under Bun → bun:sqlite (embeds in `bun --compile`); under Node →
// libsql (native @libsql binding). Both yield the SAME driver-agnostic
// SqliteAdapter (./adapter), which carries every query — so the browser build
// can reuse that class WITHOUT pulling in these node/bun-only drivers.
// =============================================================================

// re-export the driver-agnostic adapter so this module's public surface is
// unchanged: `import { SqliteAdapter } from '@ultracontext/storage/sqlite'`.
export { SqliteAdapter } from './adapter';
export type { SqliteDb } from './adapter';

// -- runtime detection --------------------------------------------------------

// true inside the Bun runtime (incl. the `bun --compile` standalone binary)
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

// -- url handling -------------------------------------------------------------

// bun:sqlite + drizzle/bun-sqlite want a plain fs path, not a libsql `file:`
// url. ':memory:' passes through unchanged; 'file:/p/uc.db' → '/p/uc.db'.
function toBunPath(url: string): string {
    return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

// -- client + schema bootstrap ------------------------------------------------

// open a SQLite adapter (url: 'file:/path/uc.db' or ':memory:'), apply DDL once.
// the driver is picked at runtime via dynamic import so Node never loads
// bun:sqlite and Bun never requires the @libsql native binding.
export async function createSqliteAdapter(url: string): Promise<SqliteAdapter> {
    const db = isBun ? await createBunDb(url) : await createLibsqlDb(url);
    return new SqliteAdapter(db);
}

// -- libsql driver (Node) -----------------------------------------------------

// Node path — libsql client + drizzle's async wrapper. executeMultiple applies
// the whole DDL script in one call.
async function createLibsqlDb(url: string): Promise<SqliteDb> {
    const { drizzle } = await import('drizzle-orm/libsql');
    const { createClient } = await import('@libsql/client');

    const client = createClient({ url });
    await client.executeMultiple(SCHEMA_SQL);
    return drizzle(client, { schema }) as unknown as SqliteDb;
}

// -- bun:sqlite driver (Bun / compiled binary) --------------------------------

// Bun path — drizzle's bun-sqlite wrapper over a native bun:sqlite Database.
// Both modules embed cleanly in `bun --compile`. DDL goes through the raw
// Database (run() executes a multi-statement script). The adapter's async
// transaction callback is fine here: bun:sqlite ops are synchronous, so the
// whole BEGIN/COMMIT body runs before any real microtask yield.
async function createBunDb(url: string): Promise<SqliteDb> {
    const { drizzle } = await import('drizzle-orm/bun-sqlite');
    // bun:sqlite is a Bun built-in — no @types/bun installed (would clash with
    // @types/node globals), and Node never reaches this branch. Suppress the
    // module-resolution error; it resolves at runtime under Bun.
    // @ts-expect-error — built-in module, only present under the Bun runtime
    const { Database } = await import('bun:sqlite');

    const client = new Database(toBunPath(url));
    client.run(SCHEMA_SQL);
    return drizzle(client, { schema }) as unknown as SqliteDb;
}
