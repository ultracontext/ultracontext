//! On-disk schema: the `nodes` table, FTS index, version guard, and init sequence.

use rusqlite::Connection;

use crate::error::{ErrorCode, UcError, UcResult};
use crate::migrations::{migrate_context_roots, migrate_node_kinds};

// SQLite PRAGMA user_version we stamp on init; bump only on a breaking on-disk change.
pub(crate) const DB_USER_VERSION: i64 = 1;

// Reject a db whose user_version is newer than this build understands.
pub(crate) fn check_user_version(conn: &Connection) -> UcResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > DB_USER_VERSION {
        return Err(UcError::new(
            ErrorCode::IncompatibleDb,
            format!("Database schema version {version} is newer than supported {DB_USER_VERSION}"),
        ));
    }
    Ok(())
}

pub(crate) fn init_schema(conn: &Connection) -> UcResult<()> {
    migrate_node_kinds(conn)?;
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS nodes (
            id         INTEGER PRIMARY KEY,
            public_id  TEXT NOT NULL,
            kind       TEXT NOT NULL CHECK (kind IN ('workspace', 'session', 'context', 'message', 'artifact')),
            content    TEXT NOT NULL DEFAULT '{}',
            metadata   TEXT NOT NULL DEFAULT '{}',
            data       BLOB,
            prev       INTEGER REFERENCES nodes(id),
            parent     INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
            owner      INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS nodes_owner_kind ON nodes(owner, kind);
        CREATE INDEX IF NOT EXISTS nodes_public_id ON nodes(public_id);
        CREATE INDEX IF NOT EXISTS nodes_prev ON nodes(prev);
        ",
    )?;
    // Surface a real error if FTS5 is unavailable instead of silently degrading search.
    conn.execute_batch(
        "
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts
        USING fts5(node_id UNINDEXED, body);
        ",
    )
    .map_err(|error| {
        UcError::new(
            ErrorCode::Internal,
            format!("Failed to create FTS search table: {error}"),
        )
    })?;
    migrate_context_roots(conn)?;
    Ok(())
}
