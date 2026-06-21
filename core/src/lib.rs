//! UltraContext core: context and artifact storage for AI applications.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

pub type UcResult<T> = std::result::Result<T, UcError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorCode {
    NotFound,
    InvalidInput,
    Conflict,
    Busy,
    IncompatibleDb,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UcError {
    pub code: ErrorCode,
    pub message: String,
}

impl UcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "code": self.code.as_str(),
            "message": self.message
        })
    }
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::NotFound => "not_found",
            ErrorCode::InvalidInput => "invalid_input",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Busy => "busy",
            ErrorCode::IncompatibleDb => "incompatible_db",
            ErrorCode::Internal => "internal",
        }
    }
}

impl From<rusqlite::Error> for UcError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(ref inner, _)
                if inner.code == rusqlite::ErrorCode::DatabaseBusy =>
            {
                UcError::new(ErrorCode::Busy, "Database busy")
            }
            _ => UcError::new(ErrorCode::Internal, error.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceView {
    pub id: String,
    pub metadata: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionView {
    pub id: String,
    pub workspace_id: String,
    pub context_id: String,
    pub metadata: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextView {
    pub id: String,
    pub metadata: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppendInput {
    pub content: Value,
    pub metadata: Value,
}

impl AppendInput {
    pub fn new(content: Value) -> Self {
        Self {
            content,
            metadata: json!({}),
        }
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct GetOptions {
    pub version: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MessageView {
    pub id: String,
    pub index: usize,
    pub content: Value,
    pub metadata: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextData {
    pub id: String,
    pub context_id: String,
    pub data: Vec<MessageView>,
    pub version: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MutationResult {
    pub context_id: String,
    pub data: Vec<MessageView>,
    pub version: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextHistoryEntry {
    pub id: String,
    pub session_id: String,
    pub version: usize,
    pub operation: String,
    pub created_at: String,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextHistory {
    pub data: Vec<ContextHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateTarget {
    Index(isize),
    Id(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpdatePatch {
    pub target: UpdateTarget,
    pub content: Value,
}

impl UpdatePatch {
    pub fn by_index(index: isize, content: Value) -> Self {
        Self {
            target: UpdateTarget::Index(index),
            content,
        }
    }

    pub fn by_id(id: impl Into<String>, content: Value) -> Self {
        Self {
            target: UpdateTarget::Id(id.into()),
            content,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeleteTarget {
    Index(isize),
    Id(String),
}

impl DeleteTarget {
    pub fn by_index(index: isize) -> Self {
        Self::Index(index)
    }

    pub fn by_id(id: impl Into<String>) -> Self {
        Self::Id(id.into())
    }
}

#[derive(Debug, Clone)]
pub struct ForkOptions {
    pub version: Option<usize>,
    pub metadata: Value,
}

impl Default for ForkOptions {
    fn default() -> Self {
        Self {
            version: None,
            metadata: json!({}),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactSave {
    pub id: Option<String>,
    pub path: String,
    pub kind: String,
    pub data: Vec<u8>,
    pub metadata: Value,
    pub if_version: Option<usize>,
}

impl ArtifactSave {
    pub fn new(path: impl Into<String>, kind: impl Into<String>, data: impl AsRef<[u8]>) -> Self {
        Self {
            id: None,
            path: path.into(),
            kind: kind.into(),
            data: data.as_ref().to_vec(),
            metadata: json!({}),
            if_version: None,
        }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }

    pub fn with_if_version(mut self, version: usize) -> Self {
        self.if_version = Some(version);
        self
    }

    fn with_optional_if_version(mut self, version: Option<usize>) -> Self {
        self.if_version = version;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileWrite {
    pub path: String,
    pub kind: String,
    pub data: Vec<u8>,
    pub metadata: Value,
    pub if_version: Option<usize>,
}

impl FileWrite {
    pub fn new(path: impl Into<String>, data: impl AsRef<[u8]>) -> Self {
        Self {
            path: path.into(),
            kind: "text/plain".to_string(),
            data: data.as_ref().to_vec(),
            metadata: json!({}),
            if_version: None,
        }
    }

    pub fn with_kind(mut self, kind: impl Into<String>) -> Self {
        self.kind = kind.into();
        self
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }

    pub fn with_if_version(mut self, version: usize) -> Self {
        self.if_version = Some(version);
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactMeta {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub size: usize,
    pub version: usize,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactData {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub size: usize,
    pub version: usize,
    pub metadata: Value,
    pub storage: Value,
    pub data: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactBytes {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub size: usize,
    pub version: usize,
    pub metadata: Value,
    pub storage: Value,
    pub data: Vec<u8>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchKind {
    Message,
    Artifact,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub kind: SearchKind,
    pub id: String,
    pub context_id: String,
    pub path: Option<String>,
    pub snippet: String,
    pub metadata: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub data: Vec<SearchHit>,
}

#[derive(Debug, Clone)]
struct NodeRow {
    rowid: i64,
    public_id: String,
    content: Value,
    metadata: Value,
    data: Option<Vec<u8>>,
    prev: Option<i64>,
    created_at: String,
}

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

#[derive(Debug, Clone)]
pub enum ContentStore {
    Inline { inline_limit: usize },
    LocalDir { root: PathBuf, inline_limit: usize },
}

impl ContentStore {
    pub fn inline() -> Self {
        Self::Inline {
            inline_limit: usize::MAX,
        }
    }

    pub fn inline_with_limit(inline_limit: usize) -> Self {
        Self::Inline { inline_limit }
    }

    pub fn local_dir(root: impl Into<PathBuf>, inline_limit: usize) -> Self {
        Self::LocalDir {
            root: root.into(),
            inline_limit,
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
        init_schema(&conn)?;

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
        list_workspaces(&conn)
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

        let created = create_session_nodes(&conn, &workspace, options.metadata.clone())?;
        let session = created.session_row.clone();

        let mut prev = None;
        for message in context_message_rows(&conn, &source_session, source_head)? {
            conn.execute(
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
            let rowid = conn.last_insert_rowid();
            index_search(&conn, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);
        }

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

        for message in messages {
            conn.execute(
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
            let rowid = conn.last_insert_rowid();
            index_search(&conn, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);

            if project_into_head {
                conn.execute(
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
                let projected_rowid = conn.last_insert_rowid();
                index_search(&conn, projected_rowid, &text_from_value(&message.content))?;
                projected_prev = Some(projected_rowid);
            }
        }

        let data = context_message_views(&conn, &session, &head)?;
        Ok(MutationResult {
            context_id: head.public_id,
            data,
            version: context_version(&conn, head.rowid)?,
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

        conn.execute(
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
        let new_head = conn.last_insert_rowid();

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

            conn.execute(
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
            let rowid = conn.last_insert_rowid();
            index_search(&conn, rowid, &text_from_value(&content))?;
            prev = Some(rowid);
        }

        let data = message_views_for_owner(&conn, new_head)?;
        Ok(MutationResult {
            context_id: new_context_id,
            data,
            version: context_version(&conn, new_head)?,
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

        conn.execute(
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
        let new_head = conn.last_insert_rowid();

        let mut prev = None;
        for (index, message) in messages.iter().enumerate() {
            if delete_indices.binary_search(&index).is_ok() {
                continue;
            }

            conn.execute(
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
            let rowid = conn.last_insert_rowid();
            index_search(&conn, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);
        }

        let data = message_views_for_owner(&conn, new_head)?;
        Ok(MutationResult {
            context_id: new_context_id,
            data,
            version: context_version(&conn, new_head)?,
        })
    }

    pub fn clear_context(&self, ctx_id: &str, version_metadata: Value) -> UcResult<MutationResult> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let current_head = current_context_head(&conn, session.rowid)?;
        let new_context_id = public_id("ctx");

        conn.execute(
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
        let new_head = conn.last_insert_rowid();

        Ok(MutationResult {
            context_id: new_context_id,
            data: vec![],
            version: context_version(&conn, new_head)?,
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

        conn.execute(
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
        let new_head = conn.last_insert_rowid();

        let mut prev = None;
        for message in messages {
            conn.execute(
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
            let rowid = conn.last_insert_rowid();
            index_search(&conn, rowid, &text_from_value(&message.content))?;
            prev = Some(rowid);
        }

        Ok(MutationResult {
            context_id: new_context_id,
            data: message_views_for_owner(&conn, new_head)?,
            version: context_version(&conn, new_head)?,
        })
    }

    pub fn save_artifact(&self, ctx_id: &str, input: ArtifactSave) -> UcResult<ArtifactMeta> {
        let conn = self.lock_conn()?;
        let session = resolve_session_handle(&conn, ctx_id)?;
        let artifact_owner = workspace_for_session(&conn, &session)?;
        self.save_artifact_for_owner(&conn, artifact_owner.rowid, input)
    }

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
            "sha256": content_fingerprint(&data),
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
        let mut hits = Vec::new();
        let fts_hits = fts_hit_rowids(&conn, &needle)?;

        for session in session_rows(&conn)? {
            let head = current_context_head(&conn, session.rowid)?;
            for message in context_message_rows(&conn, &session, &head)? {
                let haystack = text_from_value(&message.content);
                if matches_search(&fts_hits, message.rowid, &haystack, &needle) {
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
            }

            let artifact_owner = workspace_for_session(&conn, &session)?;
            for artifact in current_artifacts(&conn, artifact_owner.rowid)? {
                let kind = content_string(&artifact.content, "kind")?;
                if !kind.starts_with("text/") {
                    continue;
                }
                let Some(bytes) = read_content(&self.content_store, &artifact)? else {
                    continue;
                };
                let haystack = String::from_utf8_lossy(&bytes).to_string();
                if matches_search(&fts_hits, artifact.rowid, &haystack, &needle) {
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

    pub fn dispatch_json_str(&self, operation: &str, input: &str) -> UcResult<String> {
        let input = serde_json::from_str(input)
            .map_err(|_| UcError::new(ErrorCode::InvalidInput, "Input must be valid JSON"))?;
        Ok(self.dispatch_json(operation, input)?.to_string())
    }

    pub fn dispatch_json(&self, operation: &str, input: Value) -> UcResult<Value> {
        match operation {
            "create" => {
                let metadata = input.get("metadata").cloned().unwrap_or_else(|| json!({}));
                if let Some(workspace_id) = optional_str(&input, &["workspaceId", "workspace_id"])?
                {
                    Ok(context_view_json(
                        &self.create_in_workspace(workspace_id, metadata)?,
                    ))
                } else {
                    Ok(context_view_json(&self.create(metadata)?))
                }
            }
            "create_workspace" => {
                Ok(workspace_view_json(&self.create_workspace(
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "list_workspaces" => Ok(json!({
                "data": self
                    .list_workspaces()?
                    .into_iter()
                    .map(|view| workspace_view_json(&view))
                    .collect::<Vec<_>>()
            })),
            "create_session" => Ok(session_view_json(&self.create_session(
                required_str(&input, &["workspaceId", "workspace_id"])?,
                input.get("metadata").cloned().unwrap_or_else(|| json!({})),
            )?)),
            "fork" => Ok(context_view_json(&self.fork(
                required_str(&input, &["sourceId", "source_id"])?,
                ForkOptions {
                    version: optional_usize(&input, &["version"])?,
                    metadata: input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                },
            )?)),
            "append" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                let messages = array_or_single(required_value(&input, &["messages"])?)
                    .iter()
                    .cloned()
                    .map(|message| {
                        let metadata = message
                            .get("metadata")
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        AppendInput::new(message).with_metadata(metadata)
                    })
                    .collect();
                Ok(mutation_result_json(&self.append(ctx_id, messages)?))
            }
            "get" => Ok(context_data_json(&self.get(
                required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                GetOptions {
                    version: optional_usize(&input, &["version"])?,
                },
            )?)),
            "context_history" => Ok(context_history_json(
                &self.context_history(required_str(&input, &["ctxId", "contextId", "ctx_id"])?)?,
            )),
            "context_clear" => Ok(mutation_result_json(&self.clear_context(
                required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                input.get("metadata").cloned().unwrap_or_else(|| json!({})),
            )?)),
            "context_restore" => Ok(mutation_result_json(&self.restore_context(
                required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                required_str(
                    &input,
                    &[
                        "restoreContextId",
                        "restore_context_id",
                        "targetContextId",
                        "target_context_id",
                    ],
                )?,
                input.get("metadata").cloned().unwrap_or_else(|| json!({})),
            )?)),
            "list_contexts" => Ok(json!({
                "data": self
                    .list_contexts()?
                    .into_iter()
                    .map(|view| context_view_json(&view))
                    .collect::<Vec<_>>()
            })),
            "update" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                let update = first_update(&input)?;
                let patch = parse_update_patch(update)?;
                Ok(mutation_result_json(&self.update_message(
                    ctx_id,
                    patch,
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "delete" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                if input
                    .get("target")
                    .and_then(|target| target.get("permanent"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    self.delete_context_permanently(ctx_id)?;
                    return Ok(json!({"deleted": true, "id": ctx_id}));
                }
                let targets = parse_delete_targets(&input)?;
                Ok(mutation_result_json(&self.delete_messages(
                    ctx_id,
                    targets,
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "delete_messages" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                let targets = parse_delete_targets(&input)?;
                Ok(mutation_result_json(&self.delete_messages(
                    ctx_id,
                    targets,
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "delete_context" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                self.delete_context_permanently(ctx_id)?;
                Ok(json!({"deleted": true, "id": ctx_id}))
            }
            "save" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                Ok(artifact_meta_json(
                    &self.save_artifact(ctx_id, artifact_save_from_json(&input)?)?,
                ))
            }
            "load" => Ok(artifact_data_json(&self.load_artifact(
                required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                required_str(&input, &["pathOrId", "path_or_id", "path", "id"])?,
                optional_usize(&input, &["version"])?,
            )?)),
            "list_artifacts" => Ok(json!({
                "data": self
                    .list_artifacts(required_str(&input, &["ctxId", "contextId", "ctx_id"])?)?
                    .into_iter()
                    .map(|view| artifact_meta_json(&view))
                    .collect::<Vec<_>>()
            })),
            "delete_artifact" => {
                let artifact_id = required_str(&input, &["artifactId", "artifact_id", "id"])?;
                self.delete_artifact_permanently(artifact_id)?;
                Ok(json!({"deleted": true, "id": artifact_id}))
            }
            "search" => Ok(search_result_json(
                &self.search(required_str(&input, &["query"])?)?,
            )),
            "file_write" | "write" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                Ok(artifact_meta_json(
                    &self.file_write(ctx_id, file_write_from_json(&input)?)?,
                ))
            }
            "file_read" | "read" => Ok(artifact_data_json(&self.load_artifact(
                required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                required_str(&input, &["pathOrId", "path_or_id", "path", "id"])?,
                optional_usize(&input, &["version"])?,
            )?)),
            "file_move" | "move" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                Ok(artifact_meta_json(&self.file_move(
                    ctx_id,
                    required_str(&input, &["fromPathOrId", "from_path_or_id", "from"])?,
                    required_str(&input, &["toPath", "to_path", "to"])?,
                    optional_usize(&input, &["ifVersion", "if_version"])?,
                )?))
            }
            "file_list" | "list" => Ok(json!({
                "data": self
                    .file_list(
                        required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                        optional_str(&input, &["prefix"])?
                    )?
                    .into_iter()
                    .map(|view| artifact_meta_json(&view))
                    .collect::<Vec<_>>()
            })),
            "file_glob" | "glob" => Ok(json!({
                "data": self
                    .file_glob(
                        required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                        required_str(&input, &["pattern"])?
                    )?
                    .into_iter()
                    .map(|view| artifact_meta_json(&view))
                    .collect::<Vec<_>>()
            })),
            "file_grep" | "grep" => Ok(search_result_json(&self.file_grep(
                required_str(&input, &["ctxId", "contextId", "ctx_id"])?,
                required_str(&input, &["query"])?,
                optional_str(&input, &["prefix"])?,
            )?)),
            "file_remove" | "remove" => {
                let ctx_id = required_str(&input, &["ctxId", "contextId", "ctx_id"])?;
                let path_or_id = required_str(&input, &["pathOrId", "path_or_id", "path", "id"])?;
                self.file_remove(
                    ctx_id,
                    path_or_id,
                    optional_usize(&input, &["ifVersion", "if_version"])?,
                )?;
                Ok(json!({"deleted": true, "id": path_or_id}))
            }
            "export_snapshot" => self.export_snapshot(),
            "import_snapshot" => self.import_snapshot(input),
            "export_changes" => self.export_changes(optional_i64(&input, "since")?),
            "import_changes" => self.import_changes(input),
            _ => Err(UcError::new(
                ErrorCode::InvalidInput,
                format!("Unknown operation: {operation}"),
            )),
        }
    }

    fn lock_conn(&self) -> UcResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| UcError::new(ErrorCode::Internal, "Database lock poisoned"))
    }

    pub fn export_snapshot(&self) -> UcResult<Value> {
        let conn = self.lock_conn()?;
        let out = export_nodes(&conn, &self.content_store, None)?;
        let cursor = current_cursor(&conn)?;

        Ok(json!({
            "schema": "ultracontext.snapshot.v1",
            "cursor": cursor,
            "nodes": out
        }))
    }

    pub fn export_changes(&self, since: Option<i64>) -> UcResult<Value> {
        let conn = self.lock_conn()?;
        let out = export_nodes(&conn, &self.content_store, since)?;
        let cursor = current_cursor(&conn)?;

        Ok(json!({
            "schema": "ultracontext.changes.v1",
            "since": since.unwrap_or(0),
            "cursor": cursor,
            "nodes": out
        }))
    }

    pub fn import_snapshot(&self, snapshot: Value) -> UcResult<Value> {
        if snapshot.get("schema").and_then(Value::as_str) != Some("ultracontext.snapshot.v1") {
            return Err(UcError::new(
                ErrorCode::InvalidInput,
                "Unsupported snapshot schema",
            ));
        }
        self.import_nodes(&snapshot, "Snapshot")
    }

    pub fn import_changes(&self, changes: Value) -> UcResult<Value> {
        if changes.get("schema").and_then(Value::as_str) != Some("ultracontext.changes.v1") {
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
            let mut content = node.get("content").cloned().unwrap_or_else(|| json!({}));
            let metadata = node.get("metadata").cloned().unwrap_or_else(|| json!({}));
            let data = node
                .get("data")
                .and_then(Value::as_str)
                .map(|value| value.as_bytes().to_vec());
            if data.is_some()
                && kind == "artifact"
                && let Some(map) = content.as_object_mut()
            {
                map.insert("storage".to_string(), json!({"type": "inline"}));
            }

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
                && let Some(data) = node.get("data").and_then(Value::as_str)
            {
                index_search(&conn, id, data)?;
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

fn init_schema(conn: &Connection) -> UcResult<()> {
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
    let _ = conn.execute_batch(
        "
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts
        USING fts5(node_id UNINDEXED, body);
        ",
    );
    migrate_context_roots(conn)?;
    Ok(())
}

fn migrate_node_kinds(conn: &Connection) -> UcResult<()> {
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

fn migrate_context_roots(conn: &Connection) -> UcResult<()> {
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
                root.rowid,
                None,
                &workspace_id,
                &root.public_id,
                true,
                "migrated",
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
            session.rowid,
            root.prev,
            &workspace.public_id,
            &session.public_id,
            false,
            "migrated-root",
        )?;

        let child_heads = ordered_children(conn, root.rowid, "context")?;
        for child in child_heads {
            let prev = child.prev.or(Some(root.rowid));
            mark_context_head(
                conn,
                &child,
                session.rowid,
                prev,
                &workspace.public_id,
                &session.public_id,
                true,
                "migrated",
            )?;
        }
    }

    Ok(())
}

fn mark_context_head(
    conn: &Connection,
    head: &NodeRow,
    owner: i64,
    prev: Option<i64>,
    workspace_id: &str,
    session_id: &str,
    default_projection: bool,
    default_operation: &str,
) -> UcResult<()> {
    let mut content = head.content.clone();
    if !content.is_object() {
        content = json!({});
    }
    if let Some(map) = content.as_object_mut() {
        map.insert("role".to_string(), json!("head"));
        map.insert("workspace_id".to_string(), json!(workspace_id));
        map.insert("session_id".to_string(), json!(session_id));
        map.entry("projection".to_string())
            .or_insert(json!(default_projection));
        map.entry("operation".to_string())
            .or_insert(json!(default_operation));
    }
    conn.execute(
        "UPDATE nodes
         SET owner = ?1, prev = ?2, content = ?3
         WHERE id = ?4",
        params![owner, prev, content.to_string(), head.rowid],
    )?;
    Ok(())
}

fn context_view_json(view: &ContextView) -> Value {
    json!({
        "id": view.id,
        "metadata": view.metadata,
        "created_at": view.created_at
    })
}

fn workspace_view_json(view: &WorkspaceView) -> Value {
    json!({
        "id": view.id,
        "metadata": view.metadata,
        "created_at": view.created_at
    })
}

fn session_view_json(view: &SessionView) -> Value {
    json!({
        "id": view.id,
        "workspace_id": view.workspace_id,
        "context_id": view.context_id,
        "metadata": view.metadata,
        "created_at": view.created_at
    })
}

fn context_data_json(view: &ContextData) -> Value {
    json!({
        "id": view.id,
        "context_id": view.context_id,
        "data": view.data.iter().map(message_view_json).collect::<Vec<_>>(),
        "version": view.version
    })
}

fn mutation_result_json(view: &MutationResult) -> Value {
    json!({
        "context_id": view.context_id,
        "data": view.data.iter().map(message_view_json).collect::<Vec<_>>(),
        "version": view.version
    })
}

fn context_history_json(view: &ContextHistory) -> Value {
    json!({
        "data": view
            .data
            .iter()
            .map(|entry| {
                json!({
                    "id": entry.id,
                    "session_id": entry.session_id,
                    "version": entry.version,
                    "operation": entry.operation,
                    "created_at": entry.created_at,
                    "current": entry.current,
                })
            })
            .collect::<Vec<_>>()
    })
}

fn message_view_json(view: &MessageView) -> Value {
    let mut out = match &view.content {
        Value::Object(map) => map.clone(),
        value => {
            let mut map = Map::new();
            map.insert("content".to_string(), value.clone());
            map
        }
    };
    out.insert("id".to_string(), json!(view.id));
    out.insert("index".to_string(), json!(view.index));
    out.insert("metadata".to_string(), view.metadata.clone());
    out.insert("created_at".to_string(), json!(view.created_at));
    Value::Object(out)
}

fn artifact_meta_json(view: &ArtifactMeta) -> Value {
    json!({
        "id": view.id,
        "path": view.path,
        "kind": view.kind,
        "size": view.size,
        "version": view.version,
        "created_at": view.created_at
    })
}

fn artifact_data_json(view: &ArtifactData) -> Value {
    json!({
        "id": view.id,
        "path": view.path,
        "kind": view.kind,
        "size": view.size,
        "version": view.version,
        "metadata": view.metadata,
        "storage": view.storage,
        "data": view.data,
        "created_at": view.created_at
    })
}

fn search_result_json(result: &SearchResult) -> Value {
    json!({
        "data": result
            .data
            .iter()
            .map(|hit| {
                json!({
                    "kind": match hit.kind {
                        SearchKind::Message => "message",
                        SearchKind::Artifact => "artifact",
                    },
                    "id": hit.id,
                    "context_id": hit.context_id,
                    "path": hit.path,
                    "snippet": hit.snippet,
                    "metadata": hit.metadata,
                    "created_at": hit.created_at
                })
            })
            .collect::<Vec<_>>()
    })
}

fn first_update(input: &Value) -> UcResult<&Value> {
    let updates = required_value(input, &["updates", "update"])?;
    if let Some(values) = updates.as_array() {
        values
            .first()
            .ok_or_else(|| UcError::new(ErrorCode::InvalidInput, "Pass at least one update"))
    } else {
        Ok(updates)
    }
}

fn parse_update_patch(input: &Value) -> UcResult<UpdatePatch> {
    let Value::Object(map) = input else {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Update must be an object",
        ));
    };

    let target = if let Some(index) = map.get("index").and_then(Value::as_i64) {
        UpdateTarget::Index(index as isize)
    } else if let Some(id) = map.get("id").and_then(Value::as_str) {
        UpdateTarget::Id(id.to_string())
    } else {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Update must include id or index",
        ));
    };

    let mut content = map.clone();
    content.remove("id");
    content.remove("index");
    Ok(UpdatePatch {
        target,
        content: Value::Object(content),
    })
}

fn parse_delete_targets(input: &Value) -> UcResult<Vec<DeleteTarget>> {
    let target = required_value(input, &["targets", "target"])?;
    let values = if let Some(values) = target.as_array() {
        values
    } else {
        return parse_delete_target(target).map(|target| vec![target]);
    };

    if values.is_empty() {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Pass at least one message id or index",
        ));
    }

    values.iter().map(parse_delete_target).collect()
}

fn parse_delete_target(input: &Value) -> UcResult<DeleteTarget> {
    if let Some(index) = input.as_i64() {
        return Ok(DeleteTarget::Index(index as isize));
    }
    if let Some(id) = input.as_str() {
        return Ok(DeleteTarget::Id(id.to_string()));
    }
    if let Some(index) = input.get("index").and_then(Value::as_i64) {
        return Ok(DeleteTarget::Index(index as isize));
    }
    if let Some(id) = input.get("id").and_then(Value::as_str) {
        return Ok(DeleteTarget::Id(id.to_string()));
    }
    Err(UcError::new(
        ErrorCode::InvalidInput,
        "Delete target must be an id or index",
    ))
}

fn artifact_save_from_json(input: &Value) -> UcResult<ArtifactSave> {
    Ok(ArtifactSave {
        id: optional_str(input, &["id"])?.map(ToOwned::to_owned),
        path: required_str(input, &["path"])?.to_string(),
        kind: optional_str(input, &["kind"])?
            .unwrap_or("text/plain")
            .to_string(),
        data: value_to_bytes(input.get("data").unwrap_or(&Value::Null)),
        metadata: input.get("metadata").cloned().unwrap_or_else(|| json!({})),
        if_version: optional_usize(input, &["ifVersion", "if_version"])?,
    })
}

fn file_write_from_json(input: &Value) -> UcResult<FileWrite> {
    Ok(FileWrite {
        path: required_str(input, &["path"])?.to_string(),
        kind: optional_str(input, &["kind"])?
            .unwrap_or("text/plain")
            .to_string(),
        data: value_to_bytes(input.get("data").unwrap_or(&Value::Null)),
        metadata: input.get("metadata").cloned().unwrap_or_else(|| json!({})),
        if_version: optional_usize(input, &["ifVersion", "if_version"])?,
    })
}

fn value_to_bytes(value: &Value) -> Vec<u8> {
    match value {
        Value::Null => Vec::new(),
        Value::String(value) => value.as_bytes().to_vec(),
        value => value.to_string().into_bytes(),
    }
}

fn required_value<'a>(input: &'a Value, keys: &[&str]) -> UcResult<&'a Value> {
    keys.iter().find_map(|key| input.get(*key)).ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Missing field: {}", keys[0]),
        )
    })
}

fn array_or_single(value: &Value) -> Vec<Value> {
    if let Some(values) = value.as_array() {
        values.clone()
    } else {
        vec![value.clone()]
    }
}

fn required_str<'a>(input: &'a Value, keys: &[&str]) -> UcResult<&'a str> {
    required_value(input, keys)?.as_str().ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Field must be a string: {}", keys[0]),
        )
    })
}

fn optional_str<'a>(input: &'a Value, keys: &[&str]) -> UcResult<Option<&'a str>> {
    let Some(value) = keys.iter().find_map(|key| input.get(*key)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value.as_str().map(Some).ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Field must be a string: {}", keys[0]),
        )
    })
}

fn optional_usize(input: &Value, keys: &[&str]) -> UcResult<Option<usize>> {
    let Some(value) = keys.iter().find_map(|key| input.get(*key)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_u64()
        .map(|value| Some(value as usize))
        .ok_or_else(|| {
            UcError::new(
                ErrorCode::InvalidInput,
                format!("Field must be a positive integer: {}", keys[0]),
            )
        })
}

fn optional_i64(input: &Value, key: &str) -> UcResult<Option<i64>> {
    let Some(value) = input.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value.as_i64().map(Some).ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Field must be an integer: {key}"),
        )
    })
}

struct CreatedSession {
    session: SessionView,
    session_row: NodeRow,
}

impl CreatedSession {
    fn session_context_view(&self) -> ContextView {
        ContextView {
            id: self.session.id.clone(),
            metadata: self.session.metadata.clone(),
            created_at: self.session.created_at.clone(),
        }
    }
}

fn ensure_default_workspace(conn: &Connection) -> UcResult<NodeRow> {
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

fn create_session_nodes(
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

fn workspace_by_id(conn: &Connection, public_id: &str) -> UcResult<Option<NodeRow>> {
    query_node(
        conn,
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE public_id = ?1 AND kind = 'workspace'
         LIMIT 1",
        params![public_id],
    )
}

fn list_workspaces(conn: &Connection) -> UcResult<Vec<WorkspaceView>> {
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

fn resolve_session_handle(conn: &Connection, public_id: &str) -> UcResult<NodeRow> {
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

fn session_rows(conn: &Connection) -> UcResult<Vec<NodeRow>> {
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

fn context_view(row: NodeRow) -> ContextView {
    ContextView {
        id: row.public_id,
        metadata: row.metadata,
        created_at: row.created_at,
    }
}

fn workspace_for_session(conn: &Connection, session: &NodeRow) -> UcResult<NodeRow> {
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

fn current_context_head(conn: &Connection, session_rowid: i64) -> UcResult<NodeRow> {
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

fn context_heads(conn: &Connection, session_rowid: i64) -> UcResult<Vec<NodeRow>> {
    let current = current_context_head(conn, session_rowid)?;
    walk_prev_chain(conn, current.rowid)
}

fn context_head_by_public_id(
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

fn context_version(conn: &Connection, head_rowid: i64) -> UcResult<usize> {
    Ok(walk_prev_chain(conn, head_rowid)?.len().saturating_sub(1))
}

fn ordered_children(conn: &Connection, owner: i64, kind: &str) -> UcResult<Vec<NodeRow>> {
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

fn context_message_rows(
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

fn context_message_views(
    conn: &Connection,
    session: &NodeRow,
    head: &NodeRow,
) -> UcResult<Vec<MessageView>> {
    message_views_from_rows(context_message_rows(conn, session, head)?)
}

fn message_views_for_owner(conn: &Connection, owner_rowid: i64) -> UcResult<Vec<MessageView>> {
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

fn resolve_update_target(messages: &[NodeRow], target: &UpdateTarget) -> UcResult<usize> {
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

fn resolve_delete_target(messages: &[NodeRow], target: &DeleteTarget) -> UcResult<usize> {
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

fn current_artifact_by_path(
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

fn current_artifact_by_id(
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

fn current_artifact_by_public_id(conn: &Connection, id: &str) -> UcResult<Option<NodeRow>> {
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

fn current_artifacts(conn: &Connection, root_rowid: i64) -> UcResult<Vec<NodeRow>> {
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

fn artifact_version(conn: &Connection, artifact_rowid: i64) -> UcResult<usize> {
    Ok(artifact_chain(conn, artifact_rowid)?
        .len()
        .saturating_sub(1))
}

fn artifact_chain(conn: &Connection, current_rowid: i64) -> UcResult<Vec<NodeRow>> {
    walk_prev_chain(conn, current_rowid)
}

fn artifact_meta(conn: &Connection, row: &NodeRow) -> UcResult<ArtifactMeta> {
    Ok(ArtifactMeta {
        id: row.public_id.clone(),
        path: content_string(&row.content, "path")?,
        kind: content_string(&row.content, "kind")?,
        size: content_usize(&row.content, "size")?,
        version: artifact_version(conn, row.rowid)?,
        created_at: row.created_at.clone(),
    })
}

fn artifact_bytes(store: &ContentStore, row: &NodeRow, version: usize) -> UcResult<ArtifactBytes> {
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

struct StoredContent {
    storage: Value,
    data: Option<Vec<u8>>,
}

fn store_content(
    store: &ContentStore,
    artifact_id: &str,
    version: usize,
    kind: &str,
    bytes: &[u8],
) -> UcResult<StoredContent> {
    match store {
        ContentStore::Inline { inline_limit } if bytes.len() <= *inline_limit => {
            Ok(StoredContent {
                storage: json!({"type": "inline"}),
                data: Some(bytes.to_vec()),
            })
        }
        ContentStore::Inline { .. } => Err(UcError::new(
            ErrorCode::InvalidInput,
            "Artifact exceeds inline content limit and no external content store is configured",
        )),
        ContentStore::LocalDir {
            root: _,
            inline_limit,
        } if bytes.len() <= *inline_limit => Ok(StoredContent {
            storage: json!({"type": "inline"}),
            data: Some(bytes.to_vec()),
        }),
        ContentStore::LocalDir { root, .. } => {
            let key = content_key(artifact_id, version);
            let path = local_ref_path(root, &key)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(io_error)?;
            }
            fs::write(&path, bytes).map_err(io_error)?;
            Ok(StoredContent {
                storage: json!({
                    "type": "ref",
                    "driver": "local-dir",
                    "key": key,
                    "kind": kind
                }),
                data: None,
            })
        }
    }
}

fn read_content(store: &ContentStore, row: &NodeRow) -> UcResult<Option<Vec<u8>>> {
    if let Some(bytes) = row.data.as_ref() {
        return Ok(Some(bytes.clone()));
    }

    let storage = row
        .content
        .get("storage")
        .cloned()
        .unwrap_or_else(|| json!({"type": "inline"}));
    if storage.get("type").and_then(Value::as_str) != Some("ref") {
        return Ok(None);
    }
    match storage.get("driver").and_then(Value::as_str) {
        Some("local-dir") => {
            let ContentStore::LocalDir { root, .. } = store else {
                return Ok(None);
            };
            let key = storage
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| UcError::new(ErrorCode::Internal, "Content ref missing key"))?;
            let path = local_ref_path(root, key)?;
            match fs::read(path) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(UcError::new(
                    ErrorCode::Internal,
                    "Content ref points to a missing blob",
                )),
                Err(error) => Err(io_error(error)),
            }
        }
        _ => Ok(None),
    }
}

fn delete_content(store: &ContentStore, row: &NodeRow) -> UcResult<()> {
    let Some(storage) = row.content.get("storage") else {
        return Ok(());
    };
    if storage.get("type").and_then(Value::as_str) != Some("ref")
        || storage.get("driver").and_then(Value::as_str) != Some("local-dir")
    {
        return Ok(());
    }

    let ContentStore::LocalDir { root, .. } = store else {
        return Ok(());
    };
    let Some(key) = storage.get("key").and_then(Value::as_str) else {
        return Ok(());
    };
    let path = local_ref_path(root, key)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn content_key(artifact_id: &str, version: usize) -> String {
    format!("artifacts/{artifact_id}/v{version}")
}

fn local_ref_path(root: &Path, key: &str) -> UcResult<PathBuf> {
    if key.starts_with('/') {
        return Err(UcError::new(ErrorCode::Internal, "Invalid content ref key"));
    }
    let mut path = root.to_path_buf();
    for part in key.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(UcError::new(ErrorCode::Internal, "Invalid content ref key"));
        }
        path.push(part);
    }
    Ok(path)
}

fn io_error(error: std::io::Error) -> UcError {
    UcError::new(ErrorCode::Internal, error.to_string())
}

fn node_by_rowid(conn: &Connection, rowid: i64) -> UcResult<NodeRow> {
    query_node(
        conn,
        "SELECT id, public_id, content, metadata, data, prev, created_at
         FROM nodes
         WHERE id = ?1",
        params![rowid],
    )?
    .ok_or_else(|| UcError::new(ErrorCode::Internal, "Node not found"))
}

fn walk_prev_chain(conn: &Connection, current_rowid: i64) -> UcResult<Vec<NodeRow>> {
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

fn query_node<P>(conn: &Connection, sql: &str, params: P) -> UcResult<Option<NodeRow>>
where
    P: rusqlite::Params,
{
    Ok(conn.query_row(sql, params, row_from_sql).optional()?)
}

fn row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<NodeRow> {
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

fn export_nodes(
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
        let data = if let Some(data) = row.data {
            Some(String::from_utf8_lossy(&data).to_string())
        } else if row.kind == "artifact" {
            let node = node_by_rowid(conn, row.id)?;
            read_content(store, &node)?.map(|bytes| String::from_utf8_lossy(&bytes).to_string())
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

fn current_cursor(conn: &Connection) -> UcResult<i64> {
    Ok(
        conn.query_row("SELECT COALESCE(MAX(id), 0) FROM nodes", [], |row| {
            row.get(0)
        })?,
    )
}

struct ImportNode<'a> {
    id: i64,
    public_id: &'a str,
    kind: &'a str,
    content: Value,
    metadata: Value,
    data: Option<Vec<u8>>,
    prev: Option<i64>,
    parent: Option<i64>,
    owner: Option<i64>,
    created_at: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportConflict {
    Same,
    Different,
}

fn existing_import_conflict(
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

fn index_search(conn: &Connection, node_id: i64, body: &str) -> UcResult<()> {
    if body.trim().is_empty() || !fts_available(conn) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO search_fts (node_id, body) VALUES (?1, ?2)",
        params![node_id, body],
    )
    .map(|_| ())
    .or_else(|error| match error {
        rusqlite::Error::SqliteFailure(_, _) => Ok(()),
        error => Err(error.into()),
    })
}

fn fts_hit_rowids(conn: &Connection, query: &str) -> UcResult<Option<HashSet<i64>>> {
    if !fts_available(conn) {
        return Ok(None);
    }
    let mut stmt = match conn.prepare(
        "SELECT node_id FROM search_fts
         WHERE search_fts MATCH ?1
         LIMIT 2000",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Ok(None),
    };
    let phrase = fts_phrase(query);
    let rows = match stmt.query_map(params![phrase], |row| row.get::<_, i64>(0)) {
        Ok(rows) => rows,
        Err(_) => return Ok(None),
    };
    let mut out = HashSet::new();
    for row in rows {
        out.insert(row?);
    }
    Ok(Some(out))
}

fn matches_search(
    fts_hits: &Option<HashSet<i64>>,
    rowid: i64,
    haystack: &str,
    needle: &str,
) -> bool {
    if let Some(fts_hits) = fts_hits {
        fts_hits.contains(&rowid)
    } else {
        haystack.to_lowercase().contains(needle)
    }
}

fn fts_available(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

fn order_by_prev(mut rows: Vec<NodeRow>) -> Vec<NodeRow> {
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

fn merge_json(old: &Value, patch: &Value) -> Value {
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

fn normalize_path(path: &str) -> UcResult<String> {
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

fn normalize_prefix(prefix: &str) -> UcResult<String> {
    let prefix = prefix.trim_end_matches('/');
    if prefix.is_empty() {
        return Ok(String::new());
    }
    normalize_path(prefix)
}

fn glob_prefix(pattern: &str) -> UcResult<String> {
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

fn content_string(content: &Value, key: &str) -> UcResult<String> {
    content
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| UcError::new(ErrorCode::Internal, format!("Artifact missing {key}")))
}

fn content_usize(content: &Value, key: &str) -> UcResult<usize> {
    content
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .ok_or_else(|| UcError::new(ErrorCode::Internal, format!("Artifact missing {key}")))
}

fn text_from_value(value: &Value) -> String {
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

fn public_id(prefix: &str) -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mixed = nanos ^ (counter << 41) ^ ((std::process::id() as u128) << 17);
    format!("{prefix}_{:024x}", mixed & ((1u128 << 96) - 1))
}

fn now_iso() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn content_fingerprint(bytes: &[u8]) -> String {
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        a ^= u64::from(*byte);
        a = a.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{a:016x}")
}
