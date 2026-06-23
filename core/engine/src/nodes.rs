//! The single `nodes` table: row type, graph walking, head resolution, artifact lookup,
//! session/workspace creation, JSON value helpers, and snapshot import/export.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::content::{ContentStore, read_content};
use crate::error::{ErrorCode, UcError, UcResult};
use crate::idtime::{now_iso, public_id};
use crate::views::{
    ArtifactBytes, ArtifactMeta, ContextView, DeleteTarget, MessageView, SessionView, UpdateTarget,
    WorkspaceView,
};

#[derive(Debug, Clone)]
pub(crate) struct NodeRow {
    pub rowid: i64,
    pub public_id: String,
    pub content: Value,
    pub metadata: Value,
    pub data: Option<Vec<u8>>,
    pub prev: Option<i64>,
    pub created_at: String,
}

pub(crate) struct CreatedSession {
    pub session: SessionView,
    pub session_row: NodeRow,
}

impl CreatedSession {
    pub fn session_context_view(&self) -> ContextView {
        ContextView {
            id: self.session.id.clone(),
            metadata: self.session.metadata.clone(),
            created_at: self.session.created_at.clone(),
        }
    }
}

pub(crate) fn ensure_default_workspace(conn: &Connection) -> UcResult<NodeRow> {
    if let Some(workspace) = workspace_by_id(conn, "ws_default")? {
        return Ok(workspace);
    }

    let created_at = now_iso();
    conn.execute(
        "INSERT INTO nodes (public_id, kind, content, metadata, created_at)
         VALUES (?1, 'workspace', ?2, ?3, ?4)",
        params![
            "ws_default",
            json!({"name": "default", "default": true}).to_string(),
            json!({"name": "default", "default": true}).to_string(),
            created_at
        ],
    )?;
    node_by_rowid(conn, conn.last_insert_rowid())
}

pub(crate) fn create_session_nodes(
    conn: &Connection,
    workspace: &NodeRow,
    metadata: Value,
) -> UcResult<CreatedSession> {
    let created_at = now_iso();
    let session_id = public_id("ses");
    let context_id = public_id("ctx");

    conn.execute(
        "INSERT INTO nodes (public_id, kind, content, metadata, owner, created_at)
         VALUES (?1, 'session', ?2, ?3, ?4, ?5)",
        params![
            session_id,
            json!({
                "workspace_id": workspace.public_id,
                "initial_context_id": context_id
            })
            .to_string(),
            metadata.to_string(),
            workspace.rowid,
            created_at
        ],
    )?;
    let session_row = node_by_rowid(conn, conn.last_insert_rowid())?;

    conn.execute(
        "INSERT INTO nodes (public_id, kind, content, metadata, owner, created_at)
         VALUES (?1, 'context', ?2, ?3, ?4, ?5)",
        params![
            context_id,
            json!({
                "role": "head",
                "operation": "create",
                "projection": false,
                "workspace_id": workspace.public_id,
                "session_id": session_row.public_id
            })
            .to_string(),
            json!({"operation": "create"}).to_string(),
            session_row.rowid,
            created_at
        ],
    )?;

    Ok(CreatedSession {
        session: SessionView {
            id: session_row.public_id.clone(),
            workspace_id: workspace.public_id.clone(),
            context_id: context_id.clone(),
            metadata,
            created_at,
        },
        session_row,
    })
}

pub(crate) fn workspace_by_id(conn: &Connection, public_id: &str) -> UcResult<Option<NodeRow>> {
    query_node(
        conn,
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE public_id = ?1 AND kind = 'workspace'
         LIMIT 1",
        params![public_id],
    )
}

pub(crate) fn list_workspaces(conn: &Connection) -> UcResult<Vec<WorkspaceView>> {
    let mut stmt = conn.prepare(
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE kind = 'workspace'
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|row| WorkspaceView {
            id: row.public_id,
            metadata: row.metadata,
            created_at: row.created_at,
        })
        .collect())
}

fn session_by_id(conn: &Connection, public_id: &str) -> UcResult<Option<NodeRow>> {
    query_node(
        conn,
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE public_id = ?1 AND kind = 'session'
         LIMIT 1",
        params![public_id],
    )
}

pub(crate) fn resolve_session_handle(conn: &Connection, public_id: &str) -> UcResult<NodeRow> {
    if let Some(session) = session_by_id(conn, public_id)? {
        return Ok(session);
    }

    query_node(
        conn,
        "SELECT session.id, session.public_id, session.content, session.metadata, session.data, session.prev, session.created_at
         FROM nodes context
         JOIN nodes session ON session.id = context.owner
         WHERE context.public_id = ?1
           AND context.kind = 'context'
           AND session.kind = 'session'
         LIMIT 1",
        params![public_id],
    )?
    .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Session not found"))
}

pub(crate) fn session_rows(conn: &Connection) -> UcResult<Vec<NodeRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE kind = 'session'
         ORDER BY created_at DESC, id DESC",
    )?;
    Ok(stmt
        .query_map([], row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(crate) fn context_view(row: NodeRow) -> ContextView {
    ContextView {
        id: row.public_id,
        metadata: row.metadata,
        created_at: row.created_at,
    }
}

pub(crate) fn workspace_for_session(conn: &Connection, session: &NodeRow) -> UcResult<NodeRow> {
    query_node(
        conn,
        "SELECT ws.id, ws.public_id, ws.content, ws.metadata, ws.data, ws.prev, ws.created_at
         FROM nodes session
         JOIN nodes ws ON ws.id = session.owner
         WHERE session.id = ?1
           AND session.kind = 'session'
           AND ws.kind = 'workspace'
         LIMIT 1",
        params![session.rowid],
    )?
    .ok_or_else(|| UcError::new(ErrorCode::Internal, "Workspace not found for session"))
}

pub(crate) fn current_context_head(conn: &Connection, session_rowid: i64) -> UcResult<NodeRow> {
    query_node(
        conn,
        "SELECT n.id, n.public_id, n.content, n.metadata, n.data, n.prev, n.created_at
         FROM nodes n
         WHERE n.kind = 'context'
           AND n.owner = ?1
           AND NOT EXISTS (
               SELECT 1 FROM nodes child
               WHERE child.kind = 'context' AND child.prev = n.id
           )
         ORDER BY n.id DESC
         LIMIT 1",
        params![session_rowid],
    )?
    .ok_or_else(|| UcError::new(ErrorCode::Internal, "HEAD not found"))
}

pub(crate) fn context_heads(conn: &Connection, session_rowid: i64) -> UcResult<Vec<NodeRow>> {
    let current = current_context_head(conn, session_rowid)?;
    walk_prev_chain(conn, current.rowid)
}

pub(crate) fn context_head_by_public_id(
    conn: &Connection,
    session_rowid: i64,
    public_id: &str,
) -> UcResult<NodeRow> {
    query_node(
        conn,
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE kind = 'context'
           AND owner = ?1
           AND public_id = ?2
         LIMIT 1",
        params![session_rowid, public_id],
    )?
    .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Context snapshot not found"))
}

pub(crate) fn context_version(conn: &Connection, head_rowid: i64) -> UcResult<usize> {
    Ok(walk_prev_chain(conn, head_rowid)?.len().saturating_sub(1))
}

pub(crate) fn ordered_children(
    conn: &Connection,
    owner: i64,
    kind: &str,
) -> UcResult<Vec<NodeRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE owner = ?1 AND kind = ?2",
    )?;
    let rows = stmt
        .query_map(params![owner, kind], row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(order_by_prev(rows))
}

pub(crate) fn context_message_rows(
    conn: &Connection,
    session: &NodeRow,
    head: &NodeRow,
) -> UcResult<Vec<NodeRow>> {
    if !head
        .content
        .get("projection")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return ordered_children(conn, session.rowid, "message");
    }
    ordered_children(conn, head.rowid, "message")
}

pub(crate) fn context_message_views(
    conn: &Connection,
    session: &NodeRow,
    head: &NodeRow,
) -> UcResult<Vec<MessageView>> {
    message_views_from_rows(context_message_rows(conn, session, head)?)
}

pub(crate) fn message_views_for_owner(
    conn: &Connection,
    owner_rowid: i64,
) -> UcResult<Vec<MessageView>> {
    message_views_from_rows(ordered_children(conn, owner_rowid, "message")?)
}

fn message_views_from_rows(rows: Vec<NodeRow>) -> UcResult<Vec<MessageView>> {
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(index, row)| MessageView {
            id: row.public_id,
            index,
            content: row.content,
            metadata: row.metadata,
            created_at: row.created_at,
        })
        .collect())
}

pub(crate) fn resolve_update_target(
    messages: &[NodeRow],
    target: &UpdateTarget,
) -> UcResult<usize> {
    match target {
        UpdateTarget::Index(index) => {
            let normalized = if *index < 0 {
                messages.len() as isize + *index
            } else {
                *index
            };
            if normalized < 0 || normalized as usize >= messages.len() {
                return Err(UcError::new(
                    ErrorCode::InvalidInput,
                    format!("Index out of range: {index}"),
                ));
            }
            Ok(normalized as usize)
        }
        UpdateTarget::Id(id) => messages
            .iter()
            .position(|message| message.public_id == *id)
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, format!("Message not found: {id}"))),
    }
}

pub(crate) fn resolve_delete_target(
    messages: &[NodeRow],
    target: &DeleteTarget,
) -> UcResult<usize> {
    match target {
        DeleteTarget::Index(index) => {
            let normalized = if *index < 0 {
                messages.len() as isize + *index
            } else {
                *index
            };
            if normalized < 0 || normalized as usize >= messages.len() {
                return Err(UcError::new(
                    ErrorCode::InvalidInput,
                    format!("Index out of range: {index}"),
                ));
            }
            Ok(normalized as usize)
        }
        DeleteTarget::Id(id) => messages
            .iter()
            .position(|message| message.public_id == *id)
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, format!("Message not found: {id}"))),
    }
}

pub(crate) fn current_artifact_by_path(
    conn: &Connection,
    root_rowid: i64,
    path: &str,
) -> UcResult<Option<NodeRow>> {
    query_node(
        conn,
        "SELECT n.id, n.public_id, n.content, n.metadata, n.data, n.prev, n.created_at
         FROM nodes n
         WHERE n.kind = 'artifact'
           AND n.owner = ?1
           AND json_extract(n.content, '$.path') = ?2
           AND NOT EXISTS (
               SELECT 1 FROM nodes child
               WHERE child.kind = 'artifact' AND child.prev = n.id
           )
         ORDER BY n.id DESC
         LIMIT 1",
        params![root_rowid, path],
    )
}

pub(crate) fn current_artifact_by_id(
    conn: &Connection,
    root_rowid: i64,
    id: &str,
) -> UcResult<Option<NodeRow>> {
    query_node(
        conn,
        "SELECT n.id, n.public_id, n.content, n.metadata, n.data, n.prev, n.created_at
         FROM nodes n
         WHERE n.kind = 'artifact'
           AND n.owner = ?1
           AND n.public_id = ?2
           AND NOT EXISTS (
               SELECT 1 FROM nodes child
               WHERE child.kind = 'artifact' AND child.prev = n.id
           )
         ORDER BY n.id DESC
         LIMIT 1",
        params![root_rowid, id],
    )
}

pub(crate) fn current_artifact_by_public_id(
    conn: &Connection,
    id: &str,
) -> UcResult<Option<NodeRow>> {
    query_node(
        conn,
        "SELECT n.id, n.public_id, n.content, n.metadata, n.data, n.prev, n.created_at
         FROM nodes n
         WHERE n.kind = 'artifact'
           AND n.public_id = ?1
           AND NOT EXISTS (
               SELECT 1 FROM nodes child
               WHERE child.kind = 'artifact' AND child.prev = n.id
           )
         ORDER BY n.id DESC
         LIMIT 1",
        params![id],
    )
}

pub(crate) fn current_artifacts(conn: &Connection, root_rowid: i64) -> UcResult<Vec<NodeRow>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.public_id, n.content, n.metadata, n.data, n.prev, n.created_at
         FROM nodes n
         WHERE n.kind = 'artifact'
           AND n.owner = ?1
           AND NOT EXISTS (
               SELECT 1 FROM nodes child
               WHERE child.kind = 'artifact' AND child.prev = n.id
           )
         ORDER BY json_extract(n.content, '$.path') ASC, n.id ASC",
    )?;
    Ok(stmt
        .query_map(params![root_rowid], row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(crate) fn artifact_version(conn: &Connection, artifact_rowid: i64) -> UcResult<usize> {
    Ok(artifact_chain(conn, artifact_rowid)?
        .len()
        .saturating_sub(1))
}

pub(crate) fn artifact_chain(conn: &Connection, current_rowid: i64) -> UcResult<Vec<NodeRow>> {
    walk_prev_chain(conn, current_rowid)
}

pub(crate) fn artifact_meta(conn: &Connection, row: &NodeRow) -> UcResult<ArtifactMeta> {
    Ok(ArtifactMeta {
        id: row.public_id.clone(),
        path: content_string(&row.content, "path")?,
        kind: content_string(&row.content, "kind")?,
        size: content_usize(&row.content, "size")?,
        version: artifact_version(conn, row.rowid)?,
        created_at: row.created_at.clone(),
    })
}

pub(crate) fn artifact_bytes(
    store: &ContentStore,
    row: &NodeRow,
    version: usize,
) -> UcResult<ArtifactBytes> {
    let data = read_content(store, row)?.unwrap_or_default();

    Ok(ArtifactBytes {
        id: row.public_id.clone(),
        path: content_string(&row.content, "path")?,
        kind: content_string(&row.content, "kind")?,
        size: content_usize(&row.content, "size")?,
        version,
        metadata: row.metadata.clone(),
        storage: row
            .content
            .get("storage")
            .cloned()
            .unwrap_or_else(|| json!({"type": "inline"})),
        data,
        created_at: row.created_at.clone(),
    })
}

pub(crate) fn node_by_rowid(conn: &Connection, rowid: i64) -> UcResult<NodeRow> {
    query_node(
        conn,
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE id = ?1",
        params![rowid],
    )?
    .ok_or_else(|| UcError::new(ErrorCode::Internal, "Node not found"))
}

pub(crate) fn walk_prev_chain(conn: &Connection, current_rowid: i64) -> UcResult<Vec<NodeRow>> {
    let mut out = Vec::new();
    let mut cursor = Some(current_rowid);
    while let Some(rowid) = cursor {
        let node = node_by_rowid(conn, rowid)?;
        cursor = node.prev;
        out.push(node);
    }
    out.reverse();
    Ok(out)
}

pub(crate) fn query_node<P>(conn: &Connection, sql: &str, params: P) -> UcResult<Option<NodeRow>>
where
    P: rusqlite::Params,
{
    Ok(conn.query_row(sql, params, row_from_sql).optional()?)
}

pub(crate) fn row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<NodeRow> {
    let content_text: String = row.get(2)?;
    let metadata_text: String = row.get(3)?;
    Ok(NodeRow {
        rowid: row.get(0)?,
        public_id: row.get(1)?,
        content: serde_json::from_str(&content_text).unwrap_or_else(|_| json!({})),
        metadata: serde_json::from_str(&metadata_text).unwrap_or_else(|_| json!({})),
        data: row.get(4)?,
        prev: row.get(5)?,
        created_at: row.get(6)?,
    })
}

pub(crate) fn export_nodes(
    conn: &Connection,
    store: &ContentStore,
    since: Option<i64>,
) -> UcResult<Vec<Value>> {
    let rows = if let Some(since) = since {
        let mut stmt = conn.prepare(
            "SELECT id, public_id, kind, content, metadata, data, prev, parent, owner, created_at
             FROM nodes
             WHERE id > ?1
             ORDER BY id ASC",
        )?;
        stmt.query_map(params![since], export_row_from_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, public_id, kind, content, metadata, data, prev, parent, owner, created_at
             FROM nodes
             ORDER BY id ASC",
        )?;
        stmt.query_map([], export_row_from_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let content_json: Value = serde_json::from_str(&row.content).unwrap_or_else(|_| json!({}));
        let metadata_json: Value =
            serde_json::from_str(&row.metadata).unwrap_or_else(|_| json!({}));
        // Base64 keeps non-UTF8 artifact bytes byte-exact through snapshot/changes.
        let data = if let Some(data) = row.data {
            Some(BASE64.encode(&data))
        } else if row.kind == "artifact" {
            let node = node_by_rowid(conn, row.id)?;
            read_content(store, &node)?.map(|bytes| BASE64.encode(&bytes))
        } else {
            None
        };

        out.push(json!({
            "id": row.id,
            "public_id": row.public_id,
            "kind": row.kind,
            "content": content_json,
            "metadata": metadata_json,
            "data": data,
            "prev": row.prev,
            "parent": row.parent,
            "owner": row.owner,
            "created_at": row.created_at
        }));
    }
    Ok(out)
}

struct ExportRow {
    id: i64,
    public_id: String,
    kind: String,
    content: String,
    metadata: String,
    data: Option<Vec<u8>>,
    prev: Option<i64>,
    parent: Option<i64>,
    owner: Option<i64>,
    created_at: String,
}

fn export_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExportRow> {
    Ok(ExportRow {
        id: row.get(0)?,
        public_id: row.get(1)?,
        kind: row.get(2)?,
        content: row.get(3)?,
        metadata: row.get(4)?,
        data: row.get(5)?,
        prev: row.get(6)?,
        parent: row.get(7)?,
        owner: row.get(8)?,
        created_at: row.get(9)?,
    })
}

pub(crate) fn current_cursor(conn: &Connection) -> UcResult<i64> {
    Ok(
        conn.query_row("SELECT COALESCE(MAX(id), 0) FROM nodes", [], |row| {
            row.get(0)
        })?,
    )
}

pub(crate) struct ImportNode<'a> {
    pub id: i64,
    pub public_id: &'a str,
    pub kind: &'a str,
    pub content: Value,
    pub metadata: Value,
    pub data: Option<Vec<u8>>,
    pub prev: Option<i64>,
    pub parent: Option<i64>,
    pub owner: Option<i64>,
    pub created_at: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImportConflict {
    Same,
    Different,
}

pub(crate) fn existing_import_conflict(
    conn: &Connection,
    import: &ImportNode<'_>,
) -> UcResult<Option<ImportConflict>> {
    let mut stmt = conn.prepare(
        "SELECT public_id, kind, content, metadata, data, prev, parent, owner, created_at
         FROM nodes
         WHERE id = ?1
         LIMIT 1",
    )?;
    let existing = stmt
        .query_row(params![import.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .optional()?;

    let Some((public_id, kind, content, metadata, data, prev, parent, owner, created_at)) =
        existing
    else {
        return Ok(None);
    };

    let content_value: Value = serde_json::from_str(&content).unwrap_or_else(|_| json!({}));
    let metadata_value: Value = serde_json::from_str(&metadata).unwrap_or_else(|_| json!({}));
    let same = public_id == import.public_id
        && kind == import.kind
        && content_value == import.content
        && metadata_value == import.metadata
        && data == import.data
        && prev == import.prev
        && parent == import.parent
        && owner == import.owner
        && created_at == import.created_at;

    Ok(Some(if same {
        ImportConflict::Same
    } else {
        ImportConflict::Different
    }))
}

pub(crate) fn order_by_prev(mut rows: Vec<NodeRow>) -> Vec<NodeRow> {
    let mut ordered = Vec::with_capacity(rows.len());
    let mut expected_prev = None;

    while !rows.is_empty() {
        if let Some(index) = rows.iter().position(|row| row.prev == expected_prev) {
            let row = rows.remove(index);
            expected_prev = Some(row.rowid);
            ordered.push(row);
        } else {
            rows.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.rowid.cmp(&b.rowid)));
            ordered.extend(rows);
            break;
        }
    }

    ordered
}

pub(crate) fn merge_json(old: &Value, patch: &Value) -> Value {
    match (old, patch) {
        (Value::Object(old_map), Value::Object(patch_map)) => {
            let mut merged = old_map.clone();
            for (key, value) in patch_map {
                if value.is_null() {
                    merged.remove(key);
                } else {
                    merged.insert(key.clone(), value.clone());
                }
            }
            Value::Object(merged)
        }
        (_, patch) => patch.clone(),
    }
}

pub(crate) fn normalize_path(path: &str) -> UcResult<String> {
    if path.is_empty() || path.starts_with('/') {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Invalid artifact path",
        ));
    }

    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                return Err(UcError::new(
                    ErrorCode::InvalidInput,
                    "Invalid artifact path",
                ));
            }
            value => parts.push(value),
        }
    }

    if parts.is_empty() {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Invalid artifact path",
        ));
    }

    Ok(parts.join("/"))
}

pub(crate) fn normalize_prefix(prefix: &str) -> UcResult<String> {
    let prefix = prefix.trim_end_matches('/');
    if prefix.is_empty() {
        return Ok(String::new());
    }
    normalize_path(prefix)
}

pub(crate) fn glob_prefix(pattern: &str) -> UcResult<String> {
    let prefix = pattern
        .split('*')
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    if prefix.is_empty() {
        return Ok(String::new());
    }
    normalize_path(prefix)
}

pub(crate) fn content_string(content: &Value, key: &str) -> UcResult<String> {
    content
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| UcError::new(ErrorCode::Internal, format!("Artifact missing {key}")))
}

pub(crate) fn content_usize(content: &Value, key: &str) -> UcResult<usize> {
    content
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .ok_or_else(|| UcError::new(ErrorCode::Internal, format!("Artifact missing {key}")))
}

pub(crate) fn text_from_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(text_from_value)
            .collect::<Vec<_>>()
            .join(" "),
        Value::Object(values) => values
            .values()
            .map(text_from_value)
            .collect::<Vec<_>>()
            .join(" "),
    }
}
