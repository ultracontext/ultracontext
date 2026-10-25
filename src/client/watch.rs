//! Recursive filesystem watcher (FSEvents / inotify via `notify`). Emits changed absolute
//! paths; never relied on for correctness (periodic rescans back it up). Owner: client-core agent.
//!
//! When the OS reports dropped events (overflow / rescan flag) the affected root itself is
//! sent; consumers treat a directory path as "rescan this subtree".

use anyhow::{Context, Result};
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tracing::warn;

pub struct Watcher {
    inner: RecommendedWatcher,
    roots: Arc<Mutex<Vec<PathBuf>>>,
}

fn roots_for(roots: &Mutex<Vec<PathBuf>>, paths: &[PathBuf]) -> Vec<PathBuf> {
    let roots = roots.lock().unwrap_or_else(|e| e.into_inner());
    let hit: Vec<PathBuf> = roots
        .iter()
        .filter(|r| paths.iter().any(|p| p.starts_with(r) || r.starts_with(p)))
        .cloned()
        .collect();
    if hit.is_empty() {
        roots.clone()
    } else {
        hit
    }
}

impl Watcher {
    /// Start watching nothing; paths are sent to `tx`.
    pub fn new(tx: mpsc::UnboundedSender<PathBuf>) -> Result<Watcher> {
        let roots: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let cb_roots = roots.clone();
        let inner = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(ev) => {
                if ev.need_rescan() {
                    for r in roots_for(&cb_roots, &ev.paths) {
                        let _ = tx.send(r);
                    }
                }
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
            Err(e) => {
                warn!("watcher: {e}");
                for r in roots_for(&cb_roots, &e.paths) {
                    let _ = tx.send(r);
                }
            }
        })
        .context("starting filesystem watcher")?;
        Ok(Watcher { inner, roots })
    }

    /// Watch `root` recursively (creates nothing; errors if missing).
    pub fn add(&mut self, root: &Path) -> Result<()> {
        self.inner
            .watch(root, RecursiveMode::Recursive)
            .with_context(|| format!("watching {}", root.display()))?;
        let mut roots = self.roots.lock().unwrap_or_else(|e| e.into_inner());
        if !roots.iter().any(|r| r == root) {
            roots.push(root.to_path_buf());
        }
        Ok(())
    }

    pub fn remove(&mut self, root: &Path) -> Result<()> {
        self.roots.lock().unwrap_or_else(|e| e.into_inner()).retain(|r| r != root);
        self.inner
            .unwatch(root)
            .with_context(|| format!("unwatching {}", root.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn reports_changes_under_root() {
        let d = tempfile::Builder::new().prefix("uc").tempdir_in("/tmp").unwrap();
        let root = d.path().canonicalize().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut w = Watcher::new(tx).unwrap();
        w.add(&root).unwrap();
        assert!(w.add(&root.join("missing")).is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        std::fs::write(root.join("hello.txt"), b"hi").unwrap();
        let got = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(p) = rx.recv().await {
                if p.starts_with(&root) {
                    return p;
                }
            }
            PathBuf::new()
        })
        .await
        .expect("no watcher event");
        assert!(got.starts_with(&root));
        w.remove(&root).unwrap();
    }
}
