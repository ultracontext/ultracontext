//! Public view + input structs (the SDK surface) and their canonical JSON serializers.

use serde_json::{Map, Value, json};

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

    pub(crate) fn with_optional_if_version(mut self, version: Option<usize>) -> Self {
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

// Canonical view -> JSON serializers; pub so the CLI emits the exact dispatch shapes.
pub fn context_view_json(view: &ContextView) -> Value {
    json!({
        "id": view.id,
        "metadata": view.metadata,
        "created_at": view.created_at
    })
}

pub fn workspace_view_json(view: &WorkspaceView) -> Value {
    json!({
        "id": view.id,
        "metadata": view.metadata,
        "created_at": view.created_at
    })
}

pub fn session_view_json(view: &SessionView) -> Value {
    json!({
        "id": view.id,
        "workspace_id": view.workspace_id,
        "context_id": view.context_id,
        "metadata": view.metadata,
        "created_at": view.created_at
    })
}

pub fn context_data_json(view: &ContextData) -> Value {
    json!({
        "id": view.id,
        "context_id": view.context_id,
        "data": view.data.iter().map(message_view_json).collect::<Vec<_>>(),
        "version": view.version
    })
}

pub fn mutation_result_json(view: &MutationResult) -> Value {
    json!({
        "context_id": view.context_id,
        "data": view.data.iter().map(message_view_json).collect::<Vec<_>>(),
        "version": view.version
    })
}

pub fn context_history_json(view: &ContextHistory) -> Value {
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

pub fn message_view_json(view: &MessageView) -> Value {
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

pub fn artifact_meta_json(view: &ArtifactMeta) -> Value {
    json!({
        "id": view.id,
        "path": view.path,
        "kind": view.kind,
        "size": view.size,
        "version": view.version,
        "created_at": view.created_at
    })
}

pub fn artifact_data_json(view: &ArtifactData) -> Value {
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

pub fn search_result_json(result: &SearchResult) -> Value {
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
