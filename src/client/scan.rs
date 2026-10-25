//! Folder scanning, ignore rules (DESIGN §5.5) and fingerprints. Owner: client-core agent.

use anyhow::Result;
use std::path::{Path, PathBuf};

use super::db::LocalFp;

/// Ignore matcher for one space root.
pub struct Ignore {
    _priv: (),
}

impl Ignore {
    /// Build from built-ins + .ucignore + (.gitignore if respect_gitignore) + always_include.
    pub fn new(root: &Path, respect_gitignore: bool, always_include: &[String]) -> Result<Ignore> {
        let _ = (root, respect_gitignore, always_include);
        todo!("client-core agent")
    }
    /// Is this absolute path (inside root) ignored? `is_dir` for directory rules.
    pub fn is_ignored(&self, abs: &Path, is_dir: bool) -> bool {
        let _ = (abs, is_dir);
        todo!("client-core agent")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LocalKind {
    File,
    Symlink(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Scanned {
    /// canonical relative path
    pub rel: String,
    pub abs: PathBuf,
    pub kind: LocalKind,
    pub fp: LocalFp,
}

/// Walk a space root (not following symlinks), applying ignore rules.
pub fn scan(root: &Path, ignore: &Ignore) -> Result<Vec<Scanned>> {
    let _ = (root, ignore);
    todo!("client-core agent")
}

/// lstat-based fingerprint; None if missing or not a regular file/symlink.
pub fn fingerprint(abs: &Path) -> Option<(LocalKind, LocalFp)> {
    let _ = abs;
    todo!("client-core agent")
}
