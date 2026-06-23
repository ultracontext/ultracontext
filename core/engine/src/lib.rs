//! UltraContext core: context and artifact storage for AI applications.

mod content;
mod dispatch;
mod error;
mod idtime;
mod migrations;
mod nodes;
mod schema;
mod search;
mod views;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::sync::Mutex;

use crate::content::{delete_content, read_content, sha256_hex, store_content};
use crate::dispatch::{optional_i64, required_str};
use crate::idtime::{now_iso, public_id};
use crate::migrations::migrate_context_roots;
use crate::nodes::{
    ImportConflict, ImportNode, artifact_bytes, artifact_chain, artifact_meta, artifact_version,
    content_string, context_head_by_public_id, context_heads, context_message_rows,
    context_message_views, context_version, context_view, create_session_nodes,
    current_artifact_by_id, current_artifact_by_path, current_artifact_by_public_id,
    current_artifacts, current_context_head, current_cursor, ensure_default_workspace,
    existing_import_conflict, export_nodes, glob_prefix, merge_json, message_views_for_owner,
    node_by_rowid, normalize_path, normalize_prefix, ordered_children, resolve_delete_target,
    resolve_session_handle, resolve_update_target, session_rows, text_from_value, workspace_by_id,
    workspace_for_session,
};
use crate::schema::{DB_USER_VERSION, check_user_version, init_schema};
use crate::search::{fts_hit_rowids, index_search, is_hit};

// Re-export the full public SDK surface so external paths stay `ultracontext::Type`.
pub use crate::content::{ContentStore, S3ContentStore};
pub use crate::error::{ErrorCode, UcError, UcResult};
pub use crate::views::{
    AppendInput, ArtifactBytes, ArtifactData, ArtifactMeta, ArtifactSave, ContextData,
    ContextHistory, ContextHistoryEntry, ContextView, DeleteTarget, FileWrite, ForkOptions,
    GetOptions, MessageView, MutationResult, SearchHit, SearchKind, SearchResult, SessionView,
    UpdatePatch, UpdateTarget, WorkspaceView, artifact_data_json, artifact_meta_json,
    context_data_json, context_history_json, context_view_json, message_view_json,
    mutation_result_json, search_result_json, session_view_json, workspace_view_json,
};

pub struct UltraContext {
    conn: Mutex<Connection>,
    content_store: ContentStore,
}

#[derive(Debug, Clone)]
pub struct UltraContextOptions {
    pub content_store: ContentStore,
}

impl Default for UltraContextOptions {
    fn default() -> Self {
        Self {
            content_store: ContentStore::inline(),
        }
    }
}

impl UltraContext {
    pub fn open(path: impl AsRef<str>) -> UcResult<Self> {
        Self::open_with_options(path, UltraContextOptions::default())
    }

    pub fn open_with_options(
        path: impl AsRef<str>,
        options: UltraContextOptions,
    ) -> UcResult<Self> {
        let conn = Connection::open(path.as_ref())?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        // Refuse to open a db written by a newer/unknown schema before touching it.
        check_user_version(&conn)?;
        init_schema(&conn)?;
        conn.pragma_update(None, "user_version", DB_USER_VERSION)?;

        Ok(Self {
            conn: Mutex::new(conn),
            content_store: options.content_store,
        })
    }

    pub fn create_workspace(&self, metadata: Value) -> UcResult<WorkspaceView> {
        let conn = self.lock_conn()?;
        let created_at = now_iso();
        let workspace_id = public_id("ws");

        conn.execute(
            "INSERT INTO nodes (public_id, kind, content, metadata, created_at)
             VALUES (?1, 'workspace', '{}', ?2, ?3)",
            params![workspace_id, metadata.to_string(), created_at],
        )?;

        Ok(WorkspaceView {
            id: workspace_id,
            metadata,
            created_at,
        })
    }

    pub fn list_workspaces(&self) -> UcResult<Vec<WorkspaceView>> {
        let conn = self.lock_conn()?;
        crate::nodes::list_workspaces(&conn)
    }

    pub fn ensure_default_workspace(&self) -> UcResult<WorkspaceView> {
        let conn = self.lock_conn()?;
        let workspace = ensure_default_workspace(&conn)?;
        Ok(WorkspaceView {
            id: workspace.public_id,
            metadata: workspace.metadata,
            created_at: workspace.created_at,
        })
    }

    pub fn create_session(&self, workspace_id: &str, metadata: Value) -> UcResult<SessionView> {
        let conn = self.lock_conn()?;
        let workspace = workspace_by_id(&conn, workspace_id)?
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Workspace not found"))?;
        Ok(create_session_nodes(&conn, &workspace, metadata)?.session)
    }

    pub fn create_in_workspace(
        &self,
        workspace_id: &str,
        metadata: Value,
    ) -> UcResult<ContextView> {
        let conn = self.lock_conn()?;
        let workspace = workspace_by_id(&conn, workspace_id)?
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Workspace not found"))?;
        Ok(create_session_nodes(&conn, &workspace, metadata)?.session_context_view())
    }

    pub fn create(&self, metadata: Value) -> UcResult<ContextView> {
        let conn = self.lock_conn()?;
        let workspace = ensure_default_workspace(&conn)?;
        Ok(create_session_nodes(&conn, &workspace, metadata)?.session_context_view())
    }

    pub fn fork(&self, source_id: &str, options: ForkOptions) -> UcResult<ContextView> {
        let conn = self.lock_conn()?;
        let source_session = resolve_session_handle(&conn, source_id)?;
        let workspace = workspace_for_session(&conn, &source_session)?;
        let source_heads = context_heads(&conn, source_session.rowid)?;
        let source_version = options
            .version
            .unwrap_or_else(|| source_heads.len().saturating_sub(1));
        let source_head = source_heads
            .get(source_version)
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Version not found"))?;

        // New session + copied messages materialize atomically or not at all.
        let tx = conn.unchecked_transaction()?;
        let created = create_session_nodes(&tx, &workspace, options.metadata.clone())?;
        let session = created.session_row.clone();

        let mut prev = None;
        for message in context_message_rows(&tx, &source_session, source_head)? {
            tx.execute(
                "INSERT INTO nodes
                 (public_id, kind, content, metadata, prev, parent, owner, created_at)
                 VALUES (?1, 'message', ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    public_id("msg"),
                    message.content.to_string(),
                    message.metadata.to_string(),
                    prev,
                    message.rowid,
                    session.rowid,
                    now_iso()
                ],
            )?;
            let rowid = tx.last_insert_rowid();
            index_search(&tx, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);
        }

        tx.commit()?;
        Ok(created.session_context_view())
    }

    pub fn append(&self, ctx_id: &str, messages: Vec<AppendInput>) -> UcResult<MutationResult> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let head = current_context_head(&conn, session.rowid)?;
        let existing = ordered_children(&conn, session.rowid, "message")?;
        let mut prev = existing.last().map(|node| node.rowid);
        let mut projected_prev = ordered_children(&conn, head.rowid, "message")?
            .last()
            .map(|node| node.rowid);
        let project_into_head = head
            .content
            .get("projection")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // Appended message + its projected-head twin land together or roll back together.
        let tx = conn.unchecked_transaction()?;
        for message in messages {
            tx.execute(
                "INSERT INTO nodes
                 (public_id, kind, content, metadata, prev, owner, created_at)
                 VALUES (?1, 'message', ?2, ?3, ?4, ?5, ?6)",
                params![
                    public_id("msg"),
                    message.content.to_string(),
                    message.metadata.to_string(),
                    prev,
                    session.rowid,
                    now_iso()
                ],
            )?;
            let rowid = tx.last_insert_rowid();
            index_search(&tx, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);

            if project_into_head {
                tx.execute(
                    "INSERT INTO nodes
                     (public_id, kind, content, metadata, prev, parent, owner, created_at)
                     VALUES (?1, 'message', ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        public_id("msg"),
                        message.content.to_string(),
                        message.metadata.to_string(),
                        projected_prev,
                        rowid,
                        head.rowid,
                        now_iso()
                    ],
                )?;
                let projected_rowid = tx.last_insert_rowid();
                index_search(&tx, projected_rowid, &text_from_value(&message.content))?;
                projected_prev = Some(projected_rowid);
            }
        }

        let data = context_message_views(&tx, &session, &head)?;
        let version = context_version(&tx, head.rowid)?;
        tx.commit()?;
        Ok(MutationResult {
            context_id: head.public_id,
            data,
            version,
        })
    }

    pub fn get(&self, ctx_id: &str, options: GetOptions) -> UcResult<ContextData> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let heads = context_heads(&conn, session.rowid)?;
        let version = options
            .version
            .unwrap_or_else(|| heads.len().saturating_sub(1));
        let head = heads
            .get(version)
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Version not found"))?;

        Ok(ContextData {
            id: ctx_id.to_string(),
            context_id: head.public_id.clone(),
            data: context_message_views(&conn, &session, head)?,
            version,
        })
    }

    pub fn context_history(&self, ctx_id: &str) -> UcResult<ContextHistory> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let heads = context_heads(&conn, session.rowid)?;
        let current_id = heads.last().map(|head| head.public_id.clone());
        Ok(ContextHistory {
            data: heads
                .into_iter()
                .enumerate()
                .map(|(version, head)| ContextHistoryEntry {
                    id: head.public_id.clone(),
                    session_id: session.public_id.clone(),
                    version,
                    operation: head
                        .content
                        .get("operation")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    created_at: head.created_at,
                    current: current_id.as_deref() == Some(head.public_id.as_str()),
                })
                .collect(),
        })
    }

    pub fn update_message(
        &self,
        ctx_id: &str,
        patch: UpdatePatch,
        version_metadata: Value,
    ) -> UcResult<MutationResult> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let current_head = current_context_head(&conn, session.rowid)?;
        let messages = context_message_rows(&conn, &session, &current_head)?;
        let target_index = resolve_update_target(&messages, &patch.target)?;
        let new_context_id = public_id("ctx");

        // New head + its full projected message set commit as one version.
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO nodes
             (public_id, kind, content, metadata, prev, owner, created_at)
            VALUES (?1, 'context', ?2, ?3, ?4, ?5, ?6)",
            params![
                &new_context_id,
                json!({"role": "head", "operation": "update", "projection": true}).to_string(),
                version_metadata.to_string(),
                current_head.rowid,
                session.rowid,
                now_iso()
            ],
        )?;
        let new_head = tx.last_insert_rowid();

        let mut prev = None;
        for (index, message) in messages.iter().enumerate() {
            let is_target = index == target_index;
            let content = if is_target {
                merge_json(&message.content, &patch.content)
            } else {
                message.content.clone()
            };
            let public_id = if is_target {
                public_id("msg")
            } else {
                message.public_id.clone()
            };
            let parent = if is_target { Some(message.rowid) } else { None };

            tx.execute(
                "INSERT INTO nodes
                 (public_id, kind, content, metadata, prev, parent, owner, created_at)
                 VALUES (?1, 'message', ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    public_id,
                    content.to_string(),
                    message.metadata.to_string(),
                    prev,
                    parent,
                    new_head,
                    now_iso()
                ],
            )?;
            let rowid = tx.last_insert_rowid();
            index_search(&tx, rowid, &text_from_value(&content))?;
            prev = Some(rowid);
        }

        let data = message_views_for_owner(&tx, new_head)?;
        let version = context_version(&tx, new_head)?;
        tx.commit()?;
        Ok(MutationResult {
            context_id: new_context_id,
            data,
            version,
        })
    }

    pub fn delete_messages(
        &self,
        ctx_id: &str,
        targets: Vec<DeleteTarget>,
        version_metadata: Value,
    ) -> UcResult<MutationResult> {
        if targets.is_empty() {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Pass at least one message id or index",
            ));
        }

        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let current_head = current_context_head(&conn, session.rowid)?;
        let messages = context_message_rows(&conn, &session, &current_head)?;
        let new_context_id = public_id("ctx");
        let mut delete_indices = Vec::new();
        for target in targets {
            delete_indices.push(resolve_delete_target(&messages, &target)?);
        }
        delete_indices.sort_unstable();
        delete_indices.dedup();

        // New head + surviving messages form one version; a mid-loop failure rolls back.
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO nodes
             (public_id, kind, content, metadata, prev, owner, created_at)
            VALUES (?1, 'context', ?2, ?3, ?4, ?5, ?6)",
            params![
                &new_context_id,
                json!({"role": "head", "operation": "delete", "projection": true}).to_string(),
                version_metadata.to_string(),
                current_head.rowid,
                session.rowid,
                now_iso()
            ],
        )?;
        let new_head = tx.last_insert_rowid();

        let mut prev = None;
        for (index, message) in messages.iter().enumerate() {
            if delete_indices.binary_search(&index).is_ok() {
                continue;
            }

            tx.execute(
                "INSERT INTO nodes
                 (public_id, kind, content, metadata, prev, owner, created_at)
                 VALUES (?1, 'message', ?2, ?3, ?4, ?5, ?6)",
                params![
                    &message.public_id,
                    message.content.to_string(),
                    message.metadata.to_string(),
                    prev,
                    new_head,
                    now_iso()
                ],
            )?;
            let rowid = tx.last_insert_rowid();
            index_search(&tx, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);
        }

        let data = message_views_for_owner(&tx, new_head)?;
        let version = context_version(&tx, new_head)?;
        tx.commit()?;
        Ok(MutationResult {
            context_id: new_context_id,
            data,
            version,
        })
    }

    pub fn clear_context(&self, ctx_id: &str, version_metadata: Value) -> UcResult<MutationResult> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let current_head = current_context_head(&conn, session.rowid)?;
        let new_context_id = public_id("ctx");

        // New empty head commits atomically with its version read.
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO nodes
             (public_id, kind, content, metadata, prev, owner, created_at)
             VALUES (?1, 'context', ?2, ?3, ?4, ?5, ?6)",
            params![
                &new_context_id,
                json!({"role": "head", "operation": "clear", "projection": true}).to_string(),
                version_metadata.to_string(),
                current_head.rowid,
                session.rowid,
                now_iso()
            ],
        )?;
        let new_head = tx.last_insert_rowid();
        let version = context_version(&tx, new_head)?;
        tx.commit()?;

        Ok(MutationResult {
            context_id: new_context_id,
            data: vec![],
            version,
        })
    }

    pub fn restore_context(
        &self,
        ctx_id: &str,
        context_id: &str,
        version_metadata: Value,
    ) -> UcResult<MutationResult> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let current_head = current_context_head(&conn, session.rowid)?;
        let source = context_head_by_public_id(&conn, session.rowid, context_id)?;
        let messages = context_message_rows(&conn, &session, &source)?;
        let new_context_id = public_id("ctx");

        // New head + restored message copies form one version.
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO nodes
             (public_id, kind, content, metadata, prev, parent, owner, created_at)
             VALUES (?1, 'context', ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &new_context_id,
                json!({
                    "role": "head",
                    "operation": "restore",
                    "projection": true,
                    "restored_from": context_id
                })
                .to_string(),
                version_metadata.to_string(),
                current_head.rowid,
                source.rowid,
                session.rowid,
                now_iso()
            ],
        )?;
        let new_head = tx.last_insert_rowid();

        let mut prev = None;
        for message in messages {
            tx.execute(
                "INSERT INTO nodes
                 (public_id, kind, content, metadata, prev, parent, owner, created_at)
                 VALUES (?1, 'message', ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &message.public_id,
                    message.content.to_string(),
                    message.metadata.to_string(),
                    prev,
                    message.rowid,
                    new_head,
                    now_iso()
                ],
            )?;
            let rowid = tx.last_insert_rowid();
            index_search(&tx, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);
        }

        let data = message_views_for_owner(&tx, new_head)?;
        let version = context_version(&tx, new_head)?;
        tx.commit()?;
        Ok(MutationResult {
            context_id: new_context_id,
            data,
            version,
        })
    }

    pub fn save_artifact(&self, ctx_id: &str, input: ArtifactSave) -> UcResult<ArtifactMeta> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let artifact_owner = workspace_for_session(&conn, &session)?;
        self.save_artifact_for_owner(&conn, artifact_owner.rowid, input)
    }

    /// MOUNT-INTERNAL: workspace-scoped artifact write for the NFS mount; not part of
    /// the SDK/dispatch contract.
    pub fn save_workspace_artifact(
        &self,
        workspace_id: &str,
        input: ArtifactSave,
    ) -> UcResult<ArtifactMeta> {
        let conn = self.lock_conn()?;
        let workspace = workspace_by_id(&conn, workspace_id)?
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Workspace not found"))?;
        self.save_artifact_for_owner(&conn, workspace.rowid, input)
    }

    fn save_artifact_for_owner(
        &self,
        conn: &Connection,
        owner_rowid: i64,
        input: ArtifactSave,
    ) -> UcResult<ArtifactMeta> {
        let normalized_path = normalize_path(&input.path)?;
        let current = if let Some(id) = input.id.as_deref() {
            current_artifact_by_id(conn, owner_rowid, id)?
        } else {
            current_artifact_by_path(conn, owner_rowid, &normalized_path)?
        };

        if let Some(expected) = input.if_version {
            let actual = if let Some(ref artifact) = current {
                artifact_version(conn, artifact.rowid)?
            } else {
                return Err(UcError::new(
                    ErrorCode::Conflict,
                    "Artifact version conflict",
                ));
            };
            if actual != expected {
                return Err(UcError::new(
                    ErrorCode::Conflict,
                    "Artifact version conflict",
                ));
            }
        }

        let artifact_id = current
            .as_ref()
            .map(|node| node.public_id.clone())
            .unwrap_or_else(|| public_id("art"));

        // Artifact version rows set parent == prev (linear provenance), reserved for future forks.
        let prev = current.as_ref().map(|node| node.rowid);
        let data = input.data;
        let next_version = if let Some(ref artifact) = current {
            artifact_version(conn, artifact.rowid)? + 1
        } else {
            0
        };
        let stored = store_content(
            &self.content_store,
            &artifact_id,
            next_version,
            &input.kind,
            &data,
        )?;
        let content = json!({
            "path": normalized_path,
            "kind": input.kind,
            "size": data.len(),
            "sha256": sha256_hex(&data),
            "storage": stored.storage
        });

        conn.execute(
            "INSERT INTO nodes
             (public_id, kind, content, metadata, data, prev, parent, owner, created_at)
             VALUES (?1, 'artifact', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                artifact_id,
                content.to_string(),
                input.metadata.to_string(),
                stored.data,
                prev,
                prev,
                owner_rowid,
                now_iso()
            ],
        )?;

        let inserted = conn.last_insert_rowid();
        let row = node_by_rowid(conn, inserted)?;
        if content_string(&row.content, "kind")?.starts_with("text/")
            && let Some(bytes) = read_content(&self.content_store, &row)?
        {
            index_search(conn, inserted, &String::from_utf8_lossy(&bytes))?;
        }
        artifact_meta(conn, &row)
    }

    pub fn load_artifact(
        &self,
        ctx_id: &str,
        path_or_id: &str,
        version: Option<usize>,
    ) -> UcResult<ArtifactData> {
        let bytes = self.load_artifact_bytes(ctx_id, path_or_id, version)?;
        Ok(ArtifactData {
            id: bytes.id,
            path: bytes.path,
            kind: bytes.kind,
            size: bytes.size,
            version: bytes.version,
            metadata: bytes.metadata,
            storage: bytes.storage,
            data: Some(String::from_utf8_lossy(&bytes.data).to_string()),
            created_at: bytes.created_at,
        })
    }

    pub fn load_artifact_bytes(
        &self,
        ctx_id: &str,
        path_or_id: &str,
        version: Option<usize>,
    ) -> UcResult<ArtifactBytes> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let artifact_owner = workspace_for_session(&conn, &session)?;
        let current = if path_or_id.starts_with("art_") {
            current_artifact_by_id(&conn, artifact_owner.rowid, path_or_id)?
        } else {
            current_artifact_by_path(&conn, artifact_owner.rowid, &normalize_path(path_or_id)?)?
        }
        .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Artifact not found"))?;

        let chain = artifact_chain(&conn, current.rowid)?;
        let version = version.unwrap_or_else(|| chain.len().saturating_sub(1));
        let row = chain
            .get(version)
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Artifact version not found"))?;

        artifact_bytes(&self.content_store, row, version)
    }

    /// MOUNT-INTERNAL: workspace-scoped artifact read for the NFS mount; not part of
    /// the SDK/dispatch contract.
    pub fn load_workspace_artifact_bytes(
        &self,
        workspace_id: &str,
        path_or_id: &str,
        version: Option<usize>,
    ) -> UcResult<ArtifactBytes> {
        let conn = self.lock_conn()?;
        let workspace = workspace_by_id(&conn, workspace_id)?
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Workspace not found"))?;
        let current = if path_or_id.starts_with("art_") {
            current_artifact_by_id(&conn, workspace.rowid, path_or_id)?
        } else {
            current_artifact_by_path(&conn, workspace.rowid, &normalize_path(path_or_id)?)?
        }
        .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Artifact not found"))?;

        let chain = artifact_chain(&conn, current.rowid)?;
        let version = version.unwrap_or_else(|| chain.len().saturating_sub(1));
        let row = chain
            .get(version)
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Artifact version not found"))?;

        artifact_bytes(&self.content_store, row, version)
    }

    pub fn list_contexts(&self) -> UcResult<Vec<ContextView>> {
        let conn = self.lock_conn()?;
        session_rows(&conn).map(|sessions| sessions.into_iter().map(context_view).collect())
    }

    pub fn list_artifacts(&self, ctx_id: &str) -> UcResult<Vec<ArtifactMeta>> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let artifact_owner = workspace_for_session(&conn, &session)?;
        current_artifacts(&conn, artifact_owner.rowid)?
            .iter()
            .map(|row| artifact_meta(&conn, row))
            .collect()
    }

    /// MOUNT-INTERNAL: workspace-scoped artifact listing for the NFS mount; not part of
    /// the SDK/dispatch contract.
    pub fn list_workspace_artifacts(&self, workspace_id: &str) -> UcResult<Vec<ArtifactMeta>> {
        let conn = self.lock_conn()?;
        let workspace = workspace_by_id(&conn, workspace_id)?
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Workspace not found"))?;
        current_artifacts(&conn, workspace.rowid)?
            .iter()
            .map(|row| artifact_meta(&conn, row))
            .collect()
    }

    pub fn search(&self, query: &str) -> UcResult<SearchResult> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Search query is empty",
            ));
        }

        let conn = self.lock_conn()?;

        // Drive results from FTS hit rowids; fall back to substring scan only without FTS.
        let fts_hits = fts_hit_rowids(&conn, &needle)?;
        let mut hits = Vec::new();

        for session in session_rows(&conn)? {
            let head = current_context_head(&conn, session.rowid)?;

            // Messages: only fetch content for rows the FTS index already flagged.
            for message in context_message_rows(&conn, &session, &head)? {
                if !is_hit(&fts_hits, message.rowid) {
                    continue;
                }
                let haystack = text_from_value(&message.content);
                if fts_hits.is_none() && !haystack.to_lowercase().contains(&needle) {
                    continue;
                }
                hits.push(SearchHit {
                    kind: SearchKind::Message,
                    id: message.public_id,
                    context_id: session.public_id.clone(),
                    path: None,
                    snippet: haystack,
                    metadata: message.metadata,
                    created_at: message.created_at,
                });
            }

            // Artifacts: read blob content only after the row passes the hit check.
            let artifact_owner = workspace_for_session(&conn, &session)?;
            for artifact in current_artifacts(&conn, artifact_owner.rowid)? {
                if !is_hit(&fts_hits, artifact.rowid) {
                    continue;
                }
                let kind = content_string(&artifact.content, "kind")?;
                if !kind.starts_with("text/") {
                    continue;
                }
                let Some(bytes) = read_content(&self.content_store, &artifact)? else {
                    continue;
                };
                let haystack = String::from_utf8_lossy(&bytes).to_string();
                if fts_hits.is_none() && !haystack.to_lowercase().contains(&needle) {
                    continue;
                }
                hits.push(SearchHit {
                    kind: SearchKind::Artifact,
                    id: artifact.public_id,
                    context_id: session.public_id.clone(),
                    path: Some(content_string(&artifact.content, "path")?),
                    snippet: haystack,
                    metadata: artifact.metadata,
                    created_at: artifact.created_at,
                });
            }
        }

        hits.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(SearchResult { data: hits })
    }

    pub fn delete_artifact_permanently(&self, artifact_id: &str) -> UcResult<()> {
        let conn = self.lock_conn()?;
        let current = current_artifact_by_public_id(&conn, artifact_id)?
            .ok_or_else(|| UcError::new(ErrorCode::NotFound, "Artifact not found"))?;
        let chain = artifact_chain(&conn, current.rowid)?;

        for row in chain.into_iter().rev() {
            delete_content(&self.content_store, &row)?;
            conn.execute("DELETE FROM nodes WHERE id = ?1", params![row.rowid])?;
        }

        Ok(())
    }

    pub fn delete_context_permanently(&self, ctx_id: &str) -> UcResult<()> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        conn.execute("DELETE FROM nodes WHERE id = ?1", params![session.rowid])?;
        Ok(())
    }

    pub fn file_write(&self, ctx_id: &str, input: FileWrite) -> UcResult<ArtifactMeta> {
        self.save_artifact(
            ctx_id,
            ArtifactSave::new(input.path, input.kind, input.data)
                .with_metadata(input.metadata)
                .with_optional_if_version(input.if_version),
        )
    }

    /// MOUNT-INTERNAL: workspace-scoped file write for the NFS mount; not part of the
    /// SDK/dispatch contract.
    pub fn file_write_workspace(
        &self,
        workspace_id: &str,
        input: FileWrite,
    ) -> UcResult<ArtifactMeta> {
        self.save_workspace_artifact(
            workspace_id,
            ArtifactSave::new(input.path, input.kind, input.data)
                .with_metadata(input.metadata)
                .with_optional_if_version(input.if_version),
        )
    }

    pub fn file_read(&self, ctx_id: &str, path_or_id: &str) -> UcResult<ArtifactData> {
        self.load_artifact(ctx_id, path_or_id, None)
    }

    pub fn file_move(
        &self,
        ctx_id: &str,
        from_path_or_id: &str,
        to_path: &str,
        if_version: Option<usize>,
    ) -> UcResult<ArtifactMeta> {
        let current = self.load_artifact(ctx_id, from_path_or_id, None)?;
        let data = current.data.unwrap_or_default().into_bytes();
        self.save_artifact(
            ctx_id,
            ArtifactSave::new(to_path, current.kind, data)
                .with_id(current.id)
                .with_metadata(current.metadata)
                .with_optional_if_version(if_version),
        )
    }

    /// MOUNT-INTERNAL: workspace-scoped file move for the NFS mount; not part of the
    /// SDK/dispatch contract.
    pub fn file_move_workspace(
        &self,
        workspace_id: &str,
        from_path_or_id: &str,
        to_path: &str,
        if_version: Option<usize>,
    ) -> UcResult<ArtifactMeta> {
        let current = self.load_workspace_artifact_bytes(workspace_id, from_path_or_id, None)?;
        self.save_workspace_artifact(
            workspace_id,
            ArtifactSave::new(to_path, current.kind, current.data)
                .with_id(current.id)
                .with_metadata(current.metadata)
                .with_optional_if_version(if_version),
        )
    }

    pub fn file_list(&self, ctx_id: &str, prefix: Option<&str>) -> UcResult<Vec<ArtifactMeta>> {
        let prefix = prefix.map(normalize_prefix).transpose()?;
        Ok(self
            .list_artifacts(ctx_id)?
            .into_iter()
            .filter(|artifact| {
                prefix
                    .as_ref()
                    .is_none_or(|prefix| artifact.path.starts_with(prefix))
            })
            .collect())
    }

    /// MOUNT-INTERNAL: workspace-scoped file listing for the NFS mount; not part of the
    /// SDK/dispatch contract.
    pub fn file_list_workspace(
        &self,
        workspace_id: &str,
        prefix: Option<&str>,
    ) -> UcResult<Vec<ArtifactMeta>> {
        let prefix = prefix.map(normalize_prefix).transpose()?;
        Ok(self
            .list_workspace_artifacts(workspace_id)?
            .into_iter()
            .filter(|artifact| {
                prefix
                    .as_ref()
                    .is_none_or(|prefix| artifact.path.starts_with(prefix))
            })
            .collect())
    }

    pub fn file_glob(&self, ctx_id: &str, pattern: &str) -> UcResult<Vec<ArtifactMeta>> {
        let prefix = glob_prefix(pattern)?;
        Ok(self
            .list_artifacts(ctx_id)?
            .into_iter()
            .filter(|artifact| artifact.path.starts_with(&prefix))
            .collect())
    }

    pub fn file_grep(
        &self,
        ctx_id: &str,
        query: &str,
        prefix: Option<&str>,
    ) -> UcResult<SearchResult> {
        let prefix = prefix.map(normalize_prefix).transpose()?;
        let session_id = {
            let conn = self.lock_conn()?;
            resolve_session_handle(&conn, ctx_id)?.public_id
        };
        let mut result = self.search(query)?;
        result.data.retain(|hit| {
            hit.kind == SearchKind::Artifact
                && hit.context_id == session_id
                && prefix.as_ref().is_none_or(|prefix| {
                    hit.path
                        .as_deref()
                        .is_some_and(|path| path.starts_with(prefix))
                })
        });
        Ok(result)
    }

    pub fn file_remove(
        &self,
        ctx_id: &str,
        path_or_id: &str,
        if_version: Option<usize>,
    ) -> UcResult<()> {
        let current = self.load_artifact(ctx_id, path_or_id, None)?;
        if let Some(expected) = if_version
            && current.version != expected
        {
            return Err(UcError::new(
                ErrorCode::Conflict,
                "Artifact version conflict",
            ));
        }
        self.delete_artifact_permanently(&current.id)
    }

    /// MOUNT-INTERNAL: workspace-scoped file remove for the NFS mount; not part of the
    /// SDK/dispatch contract.
    pub fn file_remove_workspace(
        &self,
        workspace_id: &str,
        path_or_id: &str,
        if_version: Option<usize>,
    ) -> UcResult<()> {
        let current = self.load_workspace_artifact_bytes(workspace_id, path_or_id, None)?;
        if let Some(expected) = if_version
            && current.version != expected
        {
            return Err(UcError::new(
                ErrorCode::Conflict,
                "Artifact version conflict",
            ));
        }
        self.delete_artifact_permanently(&current.id)
    }

    pub(crate) fn lock_conn(&self) -> UcResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| UcError::new(ErrorCode::Internal, "Database lock poisoned"))
    }

    pub fn export_snapshot(&self) -> UcResult<Value> {
        let conn = self.lock_conn()?;
        let out = export_nodes(&conn, &self.content_store, None)?;
        let cursor = current_cursor(&conn)?;

        Ok(json!({
            "schema": "ultracontext.snapshot.v2",
            "cursor": cursor,
            "nodes": out
        }))
    }

    pub fn export_changes(&self, since: Option<i64>) -> UcResult<Value> {
        let conn = self.lock_conn()?;
        let out = export_nodes(&conn, &self.content_store, since)?;
        let cursor = current_cursor(&conn)?;

        Ok(json!({
            "schema": "ultracontext.changes.v2",
            "since": since.unwrap_or(0),
            "cursor": cursor,
            "nodes": out
        }))
    }

    pub fn import_snapshot(&self, snapshot: Value) -> UcResult<Value> {
        // Tolerate only the current base64 schema; older utf8-lossy snapshots are rejected.
        if snapshot.get("schema").and_then(Value::as_str) != Some("ultracontext.snapshot.v2") {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Unsupported snapshot schema",
            ));
        }
        self.import_nodes(&snapshot, "Snapshot")
    }

    pub fn import_changes(&self, changes: Value) -> UcResult<Value> {
        // Tolerate only the current base64 schema; older utf8-lossy changes are rejected.
        if changes.get("schema").and_then(Value::as_str) != Some("ultracontext.changes.v2") {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Unsupported changes schema",
            ));
        }
        self.import_nodes(&changes, "Changes")
    }

    fn import_nodes(&self, snapshot: &Value, label: &str) -> UcResult<Value> {
        let nodes = snapshot
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                UcError::new(ErrorCode::InvalidInput, format!("{label} missing nodes"))
            })?;
        let conn = self.lock_conn()?;
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut conflicts = Vec::new();
        for node in nodes {
            let id = node.get("id").and_then(Value::as_i64).ok_or_else(|| {
                UcError::new(ErrorCode::InvalidInput, format!("{label} node missing id"))
            })?;
            let public_id = required_str(node, &["public_id"])?;
            let kind = required_str(node, &["kind"])?;
            let content = node.get("content").cloned().unwrap_or_else(|| json!({}));
            let metadata = node.get("metadata").cloned().unwrap_or_else(|| json!({}));
            // Base64-decode the blob and keep the exported storage descriptor as-is.
            let data = match node.get("data").and_then(Value::as_str) {
                Some(encoded) => Some(BASE64.decode(encoded).map_err(|error| {
                    UcError::new(
                        ErrorCode::InvalidInput,
                        format!("{label} node has invalid base64 data: {error}"),
                    )
                })?),
                None => None,
            };

            let import = ImportNode {
                id,
                public_id,
                kind,
                content: content.clone(),
                metadata: metadata.clone(),
                data: data.clone(),
                prev: optional_i64(node, "prev")?,
                parent: optional_i64(node, "parent")?,
                owner: optional_i64(node, "owner")?,
                created_at: required_str(node, &["created_at"])?,
            };

            if let Some(conflict) = existing_import_conflict(&conn, &import)? {
                if conflict == ImportConflict::Same {
                    skipped += 1;
                } else {
                    conflicts.push(json!({
                        "id": id,
                        "public_id": public_id,
                        "kind": kind,
                        "reason": "node_id_conflict"
                    }));
                }
                continue;
            }

            conn.execute(
                "INSERT OR IGNORE INTO nodes
                 (id, public_id, kind, content, metadata, data, prev, parent, owner, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id,
                    public_id,
                    kind,
                    content.to_string(),
                    metadata.to_string(),
                    data,
                    import.prev,
                    import.parent,
                    import.owner,
                    import.created_at
                ],
            )?;
            imported += 1;
            if kind == "message" {
                index_search(&conn, id, &text_from_value(&content))?;
            } else if kind == "artifact"
                && content_string(&content, "kind")
                    .unwrap_or_default()
                    .starts_with("text/")
                && let Some(bytes) = import.data.as_ref()
            {
                index_search(&conn, id, &String::from_utf8_lossy(bytes))?;
            }
        }
        migrate_context_roots(&conn)?;
        Ok(json!({
            "imported": imported,
            "skipped": skipped,
            "conflicts": conflicts
        }))
    }
}
