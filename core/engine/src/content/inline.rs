//! Inline blob driver: bytes live in the node's `data` column under the small-content limit.

use serde_json::json;

use super::StoredContent;

pub(crate) fn store_inline(bytes: &[u8]) -> StoredContent {
    StoredContent {
        storage: json!({"type": "inline"}),
        data: Some(bytes.to_vec()),
    }
}
