import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

// =============================================================================
// SQLITE SCHEMA — local-first mirror of the Postgres schema (apps/postgres)
// JSONB → text json mode · bigserial → integer autoincrement · timestamptz → ISO text
// =============================================================================

const isoNow = () => new Date().toISOString();

export const projects = sqliteTable('projects', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    created_at: text('created_at').notNull().$defaultFn(isoNow),
    public_id: text('public_id'),
});

export const api_keys = sqliteTable('api_keys', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    project_id: integer('project_id').notNull(),
    key_prefix: text('key_prefix').notNull(),
    key_hash: text('key_hash').notNull(),
    name: text('name'),
    last_used_at: text('last_used_at'),
    created_at: text('created_at').notNull().$defaultFn(isoNow),
});

export const nodes = sqliteTable('nodes', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    public_id: text('public_id').notNull(),
    project_id: integer('project_id').notNull(),
    type: text('type').notNull(),
    content: text('content', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    created_at: text('created_at').notNull().$defaultFn(isoNow),
    parent_id: text('parent_id'),
    prev_id: text('prev_id'),
    context_id: text('context_id'),
});

// the events table — the EventStore port's storage. event_id is UNIQUE (the
// atomic dedupe), delivery_state is the outbox, envelope is the exact JSON for
// round-trip fidelity. project_id nullable (no project scoping in v1).
export const events = sqliteTable('events', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    event_id: text('event_id').notNull().unique(),
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    subject: text('subject').notNull(),
    occurred_at: text('occurred_at').notNull(),
    host: text('host').notNull(),
    privacy: text('privacy').notNull(),
    received_at: text('received_at'),
    delivery_state: text('delivery_state').notNull().default('pending'),
    project_id: integer('project_id'),
    envelope: text('envelope').notNull(),
});

export const schema = { projects, api_keys, nodes, events };

// DDL applied on first open (no migration tooling yet — local file or :memory:)
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    public_id TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    parent_id TEXT,
    prev_id TEXT,
    context_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_context_id ON nodes(context_id);
CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project_id, type);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    subject TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    host TEXT NOT NULL,
    privacy TEXT NOT NULL,
    received_at TEXT,
    delivery_state TEXT NOT NULL DEFAULT 'pending',
    project_id INTEGER,
    envelope TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject);
CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at);
`;
