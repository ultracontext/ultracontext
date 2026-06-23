//! Pluggable artifact blob storage: inline / local-dir / S3, behind one `ContentStore`.

mod inline;
mod local;
mod s3;
mod sigv4;

use serde_json::{Value, json};
use std::fmt;
use std::fs;
use std::path::PathBuf;

use crate::error::{ErrorCode, UcError, UcResult};
use crate::nodes::NodeRow;

use local::local_ref_path;
use s3::{s3_delete, s3_get, s3_put, s3_ref_key};

// Re-exported so the engine can hash artifact payloads with the same impl S3 signing uses.
pub(crate) use sigv4::sha256_hex;

#[derive(Debug, Clone)]
pub enum ContentStore {
    Inline { inline_limit: usize },
    LocalDir { root: PathBuf, inline_limit: usize },
    S3(S3ContentStore),
}

#[derive(Clone, PartialEq, Eq)]
pub struct S3ContentStore {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub prefix: Option<String>,
    pub inline_limit: usize,
}

impl S3ContentStore {
    // Single source of truth for S3 config parsing shared by bindings + CLI.
    pub fn from_json(value: &Value, inline_limit: usize) -> S3ContentStore {
        let field = |keys: &[&str]| -> Option<String> {
            keys.iter()
                .find_map(|key| value.get(*key).and_then(Value::as_str))
                .map(ToOwned::to_owned)
        };

        S3ContentStore {
            endpoint: field(&["endpoint"]).unwrap_or_default(),
            bucket: field(&["bucket"]).unwrap_or_default(),
            region: field(&["region"]).unwrap_or_else(|| "auto".to_string()),
            access_key_id: field(&["accessKeyId", "access_key_id"]).unwrap_or_default(),
            secret_access_key: field(&["secretAccessKey", "secret_access_key"]).unwrap_or_default(),
            session_token: field(&["sessionToken", "session_token"]),
            prefix: field(&["prefix"]),
            inline_limit,
        }
    }
}

impl fmt::Debug for S3ContentStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("S3ContentStore")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("access_key_id", &redact_middle(&self.access_key_id))
            .field("secret_access_key", &"<redacted>")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "<redacted>"),
            )
            .field("prefix", &self.prefix)
            .field("inline_limit", &self.inline_limit)
            .finish()
    }
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

    pub fn s3(config: S3ContentStore) -> Self {
        Self::S3(config)
    }
}

pub(crate) struct StoredContent {
    pub storage: Value,
    pub data: Option<Vec<u8>>,
}

pub(crate) fn store_content(
    store: &ContentStore,
    artifact_id: &str,
    version: usize,
    kind: &str,
    bytes: &[u8],
) -> UcResult<StoredContent> {
    match store {
        ContentStore::Inline { inline_limit } if bytes.len() <= *inline_limit => {
            Ok(inline::store_inline(bytes))
        }
        ContentStore::Inline { .. } => Err(UcError::new(
            ErrorCode::InvalidInput,
            "Artifact exceeds inline content limit and no external content store is configured",
        )),
        ContentStore::LocalDir {
            root: _,
            inline_limit,
        } if bytes.len() <= *inline_limit => Ok(inline::store_inline(bytes)),
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
        ContentStore::S3(config) if bytes.len() <= config.inline_limit => {
            Ok(inline::store_inline(bytes))
        }
        ContentStore::S3(config) => {
            let key = s3_ref_key(config, artifact_id, version);
            s3_put(config, &key, bytes, kind)?;
            Ok(StoredContent {
                storage: json!({
                    "type": "ref",
                    "driver": "s3",
                    "bucket": &config.bucket,
                    "endpoint": &config.endpoint,
                    "region": &config.region,
                    "key": key,
                    "kind": kind
                }),
                data: None,
            })
        }
    }
}

pub(crate) fn read_content(store: &ContentStore, row: &NodeRow) -> UcResult<Option<Vec<u8>>> {
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
                // A missing on-disk blob is a real NotFound, not an internal assert.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(UcError::new(
                    ErrorCode::NotFound,
                    "Content ref points to a missing blob",
                )),
                Err(error) => Err(io_error(error)),
            }
        }
        Some("s3") => {
            let ContentStore::S3(config) = store else {
                return Ok(None);
            };
            let key = storage
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| UcError::new(ErrorCode::Internal, "Content ref missing key"))?;
            Ok(Some(s3_get(config, key)?))
        }
        _ => Ok(None),
    }
}

pub(crate) fn delete_content(store: &ContentStore, row: &NodeRow) -> UcResult<()> {
    let Some(storage) = row.content.get("storage") else {
        return Ok(());
    };
    if storage.get("type").and_then(Value::as_str) != Some("ref") {
        return Ok(());
    }
    match storage.get("driver").and_then(Value::as_str) {
        Some("local-dir") => {
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
        Some("s3") => {
            let ContentStore::S3(config) = store else {
                return Ok(());
            };
            let Some(key) = storage.get("key").and_then(Value::as_str) else {
                return Ok(());
            };
            s3_delete(config, key)
        }
        _ => Ok(()),
    }
}

// Versioned object key shared by the local-dir and S3 drivers.
fn content_key(artifact_id: &str, version: usize) -> String {
    format!("artifacts/{artifact_id}/v{version}")
}

fn redact_middle(value: &str) -> String {
    if value.len() <= 8 {
        return "<redacted>".to_string();
    }
    format!("{}...{}", &value[..4], &value[value.len() - 4..])
}

pub(crate) fn io_error(error: std::io::Error) -> UcError {
    UcError::new(ErrorCode::Internal, error.to_string())
}
