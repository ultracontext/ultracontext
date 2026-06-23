//! Idempotent on-open migrations: widen node kinds, lift legacy context roots to
//! workspace/session, and stamp the head `role` shape onto older context nodes.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::error::UcResult;
use crate::idtime::{now_iso, public_id};
use crate::nodes::{NodeRow, node_by_rowid, ordered_children, row_from_sql, workspace_for_session};

pub(crate) fn migrate_node_kinds(conn: &Connection) -> UcResult<()> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(sql) = sql else {
        return Ok(());
    };
    if sql.contains("'workspace'") && sql.contains("'session'") {
        return Ok(());
    }

    conn.execute_batch(
        "
        PRAGMA foreign_keys = OFF;

        ALTER TABLE nodes RENAME TO nodes_old;

        CREATE TABLE nodes (
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

        INSERT INTO nodes (id, public_id, kind, content, metadata, data, prev, parent, owner, created_at)
        SELECT id, public_id, kind, content, metadata, data, prev, parent, owner, created_at
        FROM nodes_old;

        DROP TABLE nodes_old;

        PRAGMA foreign_keys = ON;
        ",
    )?;
    Ok(())
}

pub(crate) fn migrate_context_roots(conn: &Connection) -> UcResult<()> {
    migrate_orphan_context_roots(conn)?;
    flatten_session_context_roots(conn)?;
    Ok(())
}

fn migrate_orphan_context_roots(conn: &Connection) -> UcResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE kind = 'context' AND owner IS NULL
         ORDER BY id ASC",
    )?;
    let roots = stmt
        .query_map([], row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for root in roots {
        let workspace_id = public_id("ws");
        let created_at = now_iso();

        conn.execute(
            "INSERT INTO nodes (public_id, kind, content, metadata, owner, created_at)
             VALUES (?1, 'workspace', ?2, ?3, NULL, ?4)",
            params![
                workspace_id,
                json!({
                    "migrated_from_context": root.public_id
                })
                .to_string(),
                json!({
                    "migrated_from_context": root.public_id
                })
                .to_string(),
                created_at
            ],
        )?;
        let workspace_rowid = conn.last_insert_rowid();

        conn.execute(
            "UPDATE nodes
             SET kind = 'session', owner = ?1, content = ?2
             WHERE id = ?3",
            params![
                workspace_rowid,
                json!({
                    "workspace_id": workspace_id,
                    "migrated_from": "legacy-context-root",
                    "legacy_context_id": root.public_id
                })
                .to_string(),
                root.rowid
            ],
        )?;

        conn.execute(
            "UPDATE nodes
             SET owner = ?1
             WHERE kind = 'artifact' AND owner = ?2",
            params![workspace_rowid, root.rowid],
        )?;

        let heads = ordered_children(conn, root.rowid, "context")?;
        for head in heads {
            mark_context_head(
                conn,
                &head,
                ContextHeadMark {
                    owner: root.rowid,
                    prev: None,
                    workspace_id: &workspace_id,
                    session_id: &root.public_id,
                    default_projection: true,
                    default_operation: "migrated",
                },
            )?;
        }

        if ordered_children(conn, root.rowid, "context")?.is_empty() {
            let context_id = public_id("ctx");
            conn.execute(
                "INSERT INTO nodes (public_id, kind, content, metadata, owner, created_at)
                 VALUES (?1, 'context', ?2, ?3, ?4, ?5)",
                params![
                    context_id,
                    json!({
                        "role": "head",
                        "operation": "migrated",
                        "projection": false,
                        "workspace_id": workspace_id,
                        "session_id": root.public_id
                    })
                    .to_string(),
                    json!({"operation": "migrated"}).to_string(),
                    root.rowid,
                    created_at
                ],
            )?;
        }
    }

    Ok(())
}

fn flatten_session_context_roots(conn: &Connection) -> UcResult<()> {
    let mut stmt = conn.prepare(
        "SELECT ctx.id, ctx.public_id, ctx.content, ctx.metadata, ctx.data, ctx.prev, ctx.created_at, ctx.owner
         FROM nodes ctx
         JOIN nodes session ON session.id = ctx.owner
         WHERE ctx.kind = 'context'
           AND session.kind = 'session'
           AND json_extract(ctx.content, '$.role') = 'root'
         ORDER BY ctx.id ASC",
    )?;
    let roots = stmt
        .query_map([], |row| {
            let content_text: String = row.get(2)?;
            let metadata_text: String = row.get(3)?;
            Ok((
                NodeRow {
                    rowid: row.get(0)?,
                    public_id: row.get(1)?,
                    content: serde_json::from_str(&content_text).unwrap_or_else(|_| json!({})),
                    metadata: serde_json::from_str(&metadata_text).unwrap_or_else(|_| json!({})),
                    data: row.get(4)?,
                    prev: row.get(5)?,
                    created_at: row.get(6)?,
                },
                row.get::<_, i64>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (root, session_rowid) in roots {
        let session = node_by_rowid(conn, session_rowid)?;
        let workspace = workspace_for_session(conn, &session)?;

        mark_context_head(
            conn,
            &root,
            ContextHeadMark {
                owner: session.rowid,
                prev: root.prev,
                workspace_id: &workspace.public_id,
                session_id: &session.public_id,
                default_projection: false,
                default_operation: "migrated-root",
            },
        )?;

        let child_heads = ordered_children(conn, root.rowid, "context")?;
        for child in child_heads {
            let prev = child.prev.or(Some(root.rowid));
            mark_context_head(
                conn,
                &child,
                ContextHeadMark {
                    owner: session.rowid,
                    prev,
                    workspace_id: &workspace.public_id,
                    session_id: &session.public_id,
                    default_projection: true,
                    default_operation: "migrated",
                },
            )?;
        }
    }

    Ok(())
}

struct ContextHeadMark<'a> {
    owner: i64,
    prev: Option<i64>,
    workspace_id: &'a str,
    session_id: &'a str,
    default_projection: bool,
    default_operation: &'a str,
}

fn mark_context_head(conn: &Connection, head: &NodeRow, mark: ContextHeadMark<'_>) -> UcResult<()> {
    let mut content = head.content.clone();
    if !content.is_object() {
        content = json!({});
    }
    if let Some(map) = content.as_object_mut() {
        map.insert("role".to_string(), json!("head"));
        map.insert("workspace_id".to_string(), json!(mark.workspace_id));
        map.insert("session_id".to_string(), json!(mark.session_id));
        map.entry("projection".to_string())
            .or_insert(json!(mark.default_projection));
        map.entry("operation".to_string())
            .or_insert(json!(mark.default_operation));
    }
    conn.execute(
        "UPDATE nodes
         SET owner = ?1, prev = ?2, content = ?3
         WHERE id = ?4",
        params![mark.owner, mark.prev, content.to_string(), head.rowid],
    )?;
    Ok(())
}
