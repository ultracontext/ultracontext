//! Local-dir blob driver path resolution, rejecting traversal outside the store root.

use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, UcError, UcResult};

pub(crate) fn local_ref_path(root: &Path, key: &str) -> UcResult<PathBuf> {
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
