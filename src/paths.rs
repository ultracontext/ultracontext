//! Filesystem locations and canonical path rules (DESIGN §2, §3.2).

use anyhow::{bail, Result};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// `$HOME` (tests override it per process).
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// `$UC_HOME` or `~/.ultracontext`.
pub fn uc_home() -> PathBuf {
    match std::env::var_os("UC_HOME") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => home().join(".ultracontext"),
    }
}

/// All well-known locations under `UC_HOME`.
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    pub fn new(root: PathBuf) -> Self {
        Paths { root }
    }
    pub fn from_env() -> Self {
        Paths::new(uc_home())
    }
    pub fn config(&self) -> PathBuf {
        self.root.join("config.toml")
    }
    pub fn client_db(&self) -> PathBuf {
        self.root.join("client.db")
    }
    pub fn daemon_sock(&self) -> PathBuf {
        self.root.join("daemon.sock")
    }
    pub fn daemon_pid(&self) -> PathBuf {
        self.root.join("daemon.pid")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn daemon_log(&self) -> PathBuf {
        self.logs_dir().join("daemon.log")
    }
    pub fn trash(&self) -> PathBuf {
        self.root.join("trash")
    }
    pub fn staging(&self) -> PathBuf {
        self.root.join("staging")
    }
    pub fn hub_dir(&self) -> PathBuf {
        self.root.join("hub")
    }
    pub fn hub_sock(&self) -> PathBuf {
        self.root.join("hub.sock")
    }
    pub fn hub_pid(&self) -> PathBuf {
        self.hub_dir().join("hub.pid")
    }
    pub fn hub_log(&self) -> PathBuf {
        self.hub_dir().join("hub.log")
    }
    pub fn ensure(&self) -> Result<()> {
        for d in [self.root.clone(), self.logs_dir(), self.trash(), self.staging()] {
            std::fs::create_dir_all(&d)?;
        }
        Ok(())
    }
}

/// Expand a leading `~` to `$HOME`.
pub fn expand_tilde(p: &str) -> PathBuf {
    if p == "~" {
        return home();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest);
    }
    PathBuf::from(p)
}

/// Render an absolute path as `~/...` when it is under `$HOME` (for display and default space paths).
pub fn tilde(p: &Path) -> String {
    let h = home();
    // $HOME may sit behind a symlink (macOS /tmp -> /private/tmp) while `p` is canonicalized.
    let homes = [Some(h.clone()), h.canonicalize().ok()];
    for h in homes.iter().flatten() {
        if let Ok(rest) = p.strip_prefix(h) {
            if rest.as_os_str().is_empty() {
                return "~".to_string();
            }
            return format!("~/{}", rest.to_string_lossy());
        }
    }
    p.to_string_lossy().to_string()
}

/// Validate + normalize a canonical relative path: `/` separators, NFC, no `.`/`..`/empty
/// components, no leading `/`.
pub fn canonical(rel: &str) -> Result<String> {
    if rel.is_empty() {
        bail!("empty path");
    }
    if rel.starts_with('/') {
        bail!("absolute path not allowed: {rel}");
    }
    let mut parts = Vec::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            bail!("invalid path component in {rel:?}");
        }
        if part.contains('\0') {
            bail!("NUL in path");
        }
        parts.push(part.nfc().collect::<String>());
    }
    Ok(parts.join("/"))
}

/// Canonical relative path of `abs` inside `root` (None if outside).
pub fn rel_canonical(root: &Path, abs: &Path) -> Option<String> {
    let rest = abs.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rest.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().nfc().collect::<String>()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Local absolute path for a canonical relative path inside `root`.
pub fn join_canonical(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

pub fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_rules() {
        assert_eq!(canonical("a/b.txt").unwrap(), "a/b.txt");
        assert!(canonical("/a").is_err());
        assert!(canonical("a/../b").is_err());
        assert!(canonical("a//b").is_err());
        // NFD "é" -> NFC
        assert_eq!(canonical("cafe\u{301}").unwrap(), "caf\u{e9}");
    }

    #[test]
    fn rel_and_join() {
        let root = Path::new("/r/space");
        assert_eq!(rel_canonical(root, Path::new("/r/space/x/y")).unwrap(), "x/y");
        assert!(rel_canonical(root, Path::new("/r/other")).is_none());
        assert_eq!(join_canonical(root, "x/y"), PathBuf::from("/r/space/x/y"));
    }
}
