import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { StorageAdapter, NodeRow, NodeInsertRow, ApiKeyRow, ProjectRow, ContextFilters, TransactionOptions } from '@ultracontext/core';
import { schema, nodes, api_keys, projects, SCHEMA_SQL } from './schema';

// =============================================================================
// SQLITE ADAPTER — local-first StorageAdapter over SQLite (file or :memory:).
// Dual-driver: under Bun → bun:sqlite (embeds in `bun --compile`); under Node →
// libsql (native @libsql binding). Same SqliteAdapter, schema, and DDL for both.
// =============================================================================

// drizzle's driver-agnostic SQLite db — both libsql ('async') and bun:sqlite
// ('sync') produce a compatible BaseSQLiteDatabase, so the adapter is identical.
type SqliteDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;

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

// -- adapter ------------------------------------------------------------------

export class SqliteAdapter implements StorageAdapter {
    constructor(private db: SqliteDb) {}

    // -- nodes: queries -------------------------------------------------------

    async findNodesByContextId(contextId: string): Promise<Partial<NodeRow>[]> {
        return this.db
            .select({ public_id: nodes.public_id, prev_id: nodes.prev_id })
            .from(nodes)
            .where(eq(nodes.context_id, contextId));
    }

    async findContextBranches(contextId: string) {
        return this.db
            .select({ public_id: nodes.public_id, prev_id: nodes.prev_id, created_at: nodes.created_at })
            .from(nodes)
            .where(and(eq(nodes.context_id, contextId), eq(nodes.type, 'context')));
    }

    async findVersions(contextId: string) {
        return this.db
            .select({ public_id: nodes.public_id, created_at: nodes.created_at, metadata: nodes.metadata })
            .from(nodes)
            .where(and(eq(nodes.context_id, contextId), eq(nodes.type, 'context')))
            .orderBy(asc(nodes.created_at));
    }

    async findNonContextNodes(contextId: string): Promise<NodeRow[]> {
        return this.db
            .select()
            .from(nodes)
            .where(and(eq(nodes.context_id, contextId), ne(nodes.type, 'context'))) as Promise<NodeRow[]>;
    }

    async findRootContext(projectId: number, publicId: string) {
        const rows = await this.db
            .select({ public_id: nodes.public_id })
            .from(nodes)
            .where(and(eq(nodes.project_id, projectId), eq(nodes.public_id, publicId), eq(nodes.type, 'context'), isNull(nodes.context_id)))
            .limit(1);
        return rows[0] ?? null;
    }

    async findRootContextByPublicId(publicId: string) {
        const rows = await this.db
            .select({ public_id: nodes.public_id })
            .from(nodes)
            .where(and(eq(nodes.public_id, publicId), eq(nodes.type, 'context'), isNull(nodes.context_id)))
            .limit(1);
        return rows[0] ?? null;
    }

    async listRootContexts(projectId: number, limit: number, filters?: ContextFilters) {
        const conditions = [eq(nodes.project_id, projectId), eq(nodes.type, 'context'), isNull(nodes.context_id)];

        // metadata filters via json_extract (SQLite equivalent of Postgres JSONB containment)
        if (filters?.source) conditions.push(sql`json_extract(${nodes.metadata}, '$.source') = ${filters.source}`);
        if (filters?.user_id) conditions.push(sql`json_extract(${nodes.metadata}, '$.user_id') = ${filters.user_id}`);
        if (filters?.host) conditions.push(sql`json_extract(${nodes.metadata}, '$.host') = ${filters.host}`);
        if (filters?.project_path) conditions.push(sql`json_extract(${nodes.metadata}, '$.project_path') = ${filters.project_path}`);
        if (filters?.session_id) conditions.push(sql`json_extract(${nodes.metadata}, '$.session_id') = ${filters.session_id}`);

        // timestamp range filters (created_at is ISO text — lexical order matches chronological)
        if (filters?.after) conditions.push(gt(nodes.created_at, filters.after));
        if (filters?.before) conditions.push(lt(nodes.created_at, filters.before));

        return this.db
            .select({ public_id: nodes.public_id, metadata: nodes.metadata, created_at: nodes.created_at })
            .from(nodes)
            .where(and(...conditions))
            .orderBy(desc(nodes.created_at))
            .limit(limit);
    }

    // -- nodes: mutations -----------------------------------------------------

    async insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]> {
        const rows = Array.isArray(values) ? values : [values];
        return this.db
            .insert(nodes)
            .values(rows as any)
            .returning({
                public_id: nodes.public_id,
                content: nodes.content,
                metadata: nodes.metadata,
                created_at: nodes.created_at,
            });
    }

    async deleteNodesByContextId(projectId: number, contextId: string) {
        await this.db.delete(nodes).where(and(eq(nodes.project_id, projectId), eq(nodes.context_id, contextId)));
    }

    async deleteNodeByPublicId(projectId: number, publicId: string) {
        await this.db.delete(nodes).where(and(eq(nodes.project_id, projectId), eq(nodes.public_id, publicId)));
    }

    async clearParentReferences(projectId: number, parentId: string) {
        await this.db
            .update(nodes)
            .set({ parent_id: null })
            .where(and(eq(nodes.project_id, projectId), eq(nodes.parent_id, parentId)));
    }

    async clearParentReferencesBulk(projectId: number, parentIds: string[]) {
        if (parentIds.length === 0) return;
        await this.db
            .update(nodes)
            .set({ parent_id: null })
            .where(and(eq(nodes.project_id, projectId), inArray(nodes.parent_id, parentIds)));
    }

    // -- api keys -------------------------------------------------------------

    async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
        const rows = await this.db
            .select({ id: api_keys.id, project_id: api_keys.project_id, key_hash: api_keys.key_hash })
            .from(api_keys)
            .where(eq(api_keys.key_prefix, prefix))
            .limit(1);
        return (rows[0] as ApiKeyRow) ?? null;
    }

    async insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }) {
        await this.db.insert(api_keys).values(values);
    }

    async updateApiKeyLastUsedAt(id: number, lastUsedAt: string) {
        await this.db
            .update(api_keys)
            .set({ last_used_at: lastUsedAt })
            .where(eq(api_keys.id, id));
    }

    // -- projects -------------------------------------------------------------

    // look up an existing project by name (local-first reuses a single 'local' row)
    async findProjectByName(name: string): Promise<ProjectRow | null> {
        const rows = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.name, name)).limit(1);
        return rows[0] ?? null;
    }

    async insertProject(name: string): Promise<ProjectRow | null> {
        const rows = await this.db.insert(projects).values({ name }).returning({ id: projects.id });
        return rows[0] ?? null;
    }

    async deleteProject(id: number) {
        await this.db.delete(projects).where(eq(projects.id, id));
    }

    // -- transactions ---------------------------------------------------------

    // SQLite serializes writes by default — isolationLevel is accepted for API
    // parity and ignored. The async callback runs inside a real BEGIN/COMMIT.
    // libsql (async): transaction() awaits the callback and returns a Promise.
    // bun:sqlite (sync): the callback's ops are synchronous, so the BEGIN/COMMIT
    // body completes before any yield; transaction() returns the pending Promise
    // which we await here. Both collapse to the same Promise<T> at the await.
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, _options?: TransactionOptions): Promise<T> {
        const run = (tx: unknown) => fn(new SqliteAdapter(tx as SqliteDb));
        return await (this.db.transaction as (cb: typeof run) => Promise<T> | T)(run);
    }
}
