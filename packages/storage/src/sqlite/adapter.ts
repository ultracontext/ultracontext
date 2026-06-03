import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { StorageAdapter, NodeRow, NodeInsertRow, ApiKeyRow, ProjectRow, ContextFilters, TransactionOptions } from '@ultracontext/core';
import type { EventStore, EventRow, EventListFilters, DeliveryCounts } from '@ultracontext/core';
import { schema, nodes, api_keys, projects, events } from './schema';

// =============================================================================
// SQLITE ADAPTER (driver-agnostic) — the StorageAdapter over ANY drizzle SQLite
// db (libsql async, or the sync sqlite flavors). PURE drizzle queries, ZERO
// driver imports (no native sqlite, no node builtins) so the browser build can
// reuse this class without dragging in node-only drivers. The driver factory
// (createSqliteAdapter) lives in ./index, which re-exports this class.
// =============================================================================

// drizzle's driver-agnostic SQLite db — the async (libsql) and sync (embedded)
// flavors all produce a compatible BaseSQLiteDatabase, so the adapter is identical.
export type SqliteDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;

// -- adapter ------------------------------------------------------------------

export class SqliteAdapter implements StorageAdapter, EventStore {
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

    // -- events (EventStore port) ---------------------------------------------

    // insert one event row. ON CONFLICT(event_id) DO NOTHING maps the UNIQUE
    // violation to inserted:false across ALL drivers (libsql/bun/sql.js) without
    // a try/catch or message-sniffing — an empty .returning() means a dupe.
    async insertEvent(row: EventRow): Promise<{ inserted: boolean }> {
        const inserted = await this.db
            .insert(events)
            .values(row)
            .onConflictDoNothing({ target: events.event_id })
            .returning({ event_id: events.event_id });
        return { inserted: inserted.length > 0 };
    }

    // newest-LAST tail slice: filter, order oldest→newest, cap to the newest
    // `limit` rows (so callers reverse for chronological output).
    async listEvents(filters: EventListFilters): Promise<EventRow[]> {
        const conditions = [];
        if (filters.committed) conditions.push(eq(events.delivery_state, 'committed'));
        if (filters.kind) conditions.push(eq(events.kind, filters.kind));
        if (filters.source) conditions.push(eq(events.source, filters.source));
        if (filters.subject) conditions.push(eq(events.subject, filters.subject));

        // grab the newest `limit` rows (occurred_at DESC, id DESC tiebreak)…
        const rows = await this.db
            .select()
            .from(events)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(desc(events.occurred_at), desc(events.id))
            .limit(filters.limit);

        // …then reverse so the result is newest-LAST (oldest-of-tail first)
        return rows.reverse() as EventRow[];
    }

    // pending rows, oldest first (occurred_at ASC, id ASC), optionally capped
    async pendingEvents(limit?: number): Promise<EventRow[]> {
        const query = this.db
            .select()
            .from(events)
            .where(eq(events.delivery_state, 'pending'))
            .orderBy(asc(events.occurred_at), asc(events.id));
        const rows = await (limit === undefined ? query : query.limit(limit));
        return rows as EventRow[];
    }

    // flip a pending row to 'sent' (delivered to the hub)
    async markDelivered(eventId: string): Promise<void> {
        await this.db.update(events).set({ delivery_state: 'sent' }).where(eq(events.event_id, eventId));
    }

    // counts grouped by delivery_state (one grouped scan, zero-filled)
    async countByDeliveryState(): Promise<DeliveryCounts> {
        const rows = await this.db
            .select({ state: events.delivery_state, n: sql<number>`count(*)` })
            .from(events)
            .groupBy(events.delivery_state);

        const counts: DeliveryCounts = { committed: 0, pending: 0, sent: 0 };
        for (const { state, n } of rows) counts[state as keyof DeliveryCounts] = Number(n);
        return counts;
    }

    // -- transactions ---------------------------------------------------------

    // SQLite serializes writes by default — isolationLevel is accepted for API
    // parity and ignored. The async callback runs inside a real BEGIN/COMMIT.
    // The libsql (async) flavor awaits the callback and returns a Promise. The
    // sync flavors run the callback's ops synchronously, so the BEGIN/COMMIT body
    // completes before any yield; transaction() returns the pending Promise which
    // we await here. All flavors collapse to Promise<T> at the await.
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, _options?: TransactionOptions): Promise<T> {
        const run = (tx: unknown) => fn(new SqliteAdapter(tx as SqliteDb));
        return await (this.db.transaction as (cb: typeof run) => Promise<T> | T)(run);
    }
}
