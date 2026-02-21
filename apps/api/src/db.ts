import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { bigint, bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import postgres, { type Sql } from 'postgres';

const GLOBAL_DB_REGISTRY_KEY = '__ultracontextPgRegistry';

export const projects = pgTable('projects', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    public_id: text('public_id'),
});

export const api_keys = pgTable('api_keys', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
    key_prefix: text('key_prefix').notNull(),
    key_hash: text('key_hash').notNull(),
    name: text('name'),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const nodes = pgTable('nodes', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    public_id: text('public_id').notNull(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    parent_id: text('parent_id'),
    prev_id: text('prev_id'),
    context_id: text('context_id'),
});

export const schema = {
    projects,
    api_keys,
    nodes,
};

export type ApiDb = PostgresJsDatabase<typeof schema>;
export type NodeRow = typeof nodes.$inferSelect;

type DbRegistry = {
    clients: Map<string, Sql>;
    databases: Map<string, ApiDb>;
};

function resolveDbRegistry(): DbRegistry {
    const globalWithRegistry = globalThis as typeof globalThis & {
        [GLOBAL_DB_REGISTRY_KEY]?: DbRegistry;
    };

    if (!globalWithRegistry[GLOBAL_DB_REGISTRY_KEY]) {
        globalWithRegistry[GLOBAL_DB_REGISTRY_KEY] = {
            clients: new Map<string, Sql>(),
            databases: new Map<string, ApiDb>(),
        };
    }

    return globalWithRegistry[GLOBAL_DB_REGISTRY_KEY]!;
}

export function createDbClient(databaseUrl: string): ApiDb {
    const registry = resolveDbRegistry();
    const existingDb = registry.databases.get(databaseUrl);
    if (existingDb) return existingDb;

    const sqlClient = postgres(databaseUrl, {
        prepare: false,
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10,
    });

    const db = drizzle(sqlClient, { schema });
    registry.clients.set(databaseUrl, sqlClient);
    registry.databases.set(databaseUrl, db);
    return db;
}
