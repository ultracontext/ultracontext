//! Recursive filesystem watcher (FSEvents / inotify via `notify`). Emits changed absolute
//! paths; never relied on for correctness (periodic rescans back it up). Owner: client-core agent.

use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

pub struct Watcher {
    _priv: (),
}

impl Watcher {
    /// Start watching nothing; paths are sent to `tx`.
    pub fn new(tx: mpsc::UnboundedSender<PathBuf>) -> Result<Watcher> {
        let _ = tx;
        todo!("client-core agent")
    }
    /// Watch `root` recursively (creates nothing; errors if missing).
    pub fn add(&mut self, root: &Path) -> Result<()> {
        let _ = root;
        todo!("client-core agent")
    }
    pub fn remove(&mut self, root: &Path) -> Result<()> {
        let _ = root;
        todo!("client-core agent")
    }
}
