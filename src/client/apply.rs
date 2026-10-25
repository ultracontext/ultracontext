//! Safe local writes (DESIGN §5.3, §5.4). Owner: client-core agent. Also used by logsync.

use anyhow::Result;
use std::path::{Path, PathBuf};

use super::db::LocalFp;

/// Atomically place `src_tmp` (already in the target's directory) at `target`, provided the
/// target still matches `expect` (None = must not exist). Sets exec bit and mtime first.
/// Returns the new fingerprint, or Ok(None) if the precondition failed (caller treats as conflict).
pub fn atomic_replace(
    src_tmp: &Path,
    target: &Path,
    expect: Option<&LocalFp>,
    exec: bool,
    mtime_ms: Option<i64>,
) -> Result<Option<LocalFp>> {
    let _ = (src_tmp, target, expect, exec, mtime_ms);
    todo!("client-core agent")
}

/// A fresh temp path next to `target` (`.uc-tmp-<rand>`), creating parent dirs.
pub fn temp_beside(target: &Path) -> Result<PathBuf> {
    let _ = target;
    todo!("client-core agent")
}

/// Move a file to `$UC_HOME/trash/<date>/<machine-relative path>` (keeps it recoverable).
pub fn move_to_trash(trash_root: &Path, abs: &Path) -> Result<PathBuf> {
    let _ = (trash_root, abs);
    todo!("client-core agent")
}

/// Conflict copy name: `<stem> (conflict <machine> <YYYY-MM-DD HHMMSS>)<.ext>` (canonical rel).
pub fn conflict_name(rel: &str, machine_name: &str, at_ms: i64) -> String {
    let _ = (rel, machine_name, at_ms);
    todo!("client-core agent")
}

pub fn is_conflict_name(rel: &str) -> bool {
    rel.contains(" (conflict ")
}
