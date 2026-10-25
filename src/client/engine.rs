//! Folder-space sync engine: level-triggered L/B/R reconciliation (DESIGN §5).
//! Owner: client-core agent.

use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{Ctx, Pending};
use crate::proto::{Change, SpaceStatus};

pub struct Engine {
    _priv: (),
}

impl Engine {
    pub fn new(ctx: Arc<Ctx>) -> Arc<Engine> {
        let _ = ctx;
        todo!("client-core agent")
    }

    /// Space roots currently synced (for the watcher). Agent spaces ('@...') are not here.
    pub fn roots(&self) -> Vec<(String, PathBuf)> {
        todo!("client-core agent")
    }

    /// Does this absolute path belong to a folder space? Returns (space, canonical rel).
    pub fn locate(&self, abs: &Path) -> Option<(String, String)> {
        let _ = abs;
        todo!("client-core agent")
    }

    /// Mark local paths dirty (from the watcher). Debounced; never blocks long.
    pub async fn on_local(&self, abs: PathBuf) {
        let _ = abs;
        todo!("client-core agent")
    }

    /// Handle a replicated change for a folder space. MUST call ctx.db.record_remote(&change)
    /// before returning (cursor advances there); applying may be deferred.
    pub async fn on_remote(&self, change: Change) -> Result<()> {
        let _ = change;
        todo!("client-core agent")
    }

    /// Full rescan of all folder spaces + reconcile everything (startup, reconnect, every 5 min).
    pub async fn rescan(&self) -> Result<()> {
        todo!("client-core agent")
    }

    /// Background loop: debounced pushes, retries, deferred applies. Runs until shutdown.
    pub async fn run(self: Arc<Self>) -> Result<()> {
        todo!("client-core agent")
    }

    pub fn pending(&self) -> Pending {
        todo!("client-core agent")
    }

    pub fn space_status(&self) -> Vec<SpaceStatus> {
        todo!("client-core agent")
    }

    /// Start syncing a folder (config already updated by caller). Creates the space on the hub
    /// if it does not exist (default_path = tilde form), then rescans it.
    pub async fn add_space(&self, name: &str, path: &Path) -> Result<SpaceStatus> {
        let _ = (name, path);
        todo!("client-core agent")
    }

    pub async fn remove_space(&self, name: &str) -> Result<()> {
        let _ = name;
        todo!("client-core agent")
    }

    /// Push the content `path` had at `seq` as a new change.
    pub async fn restore(&self, space: &str, path: &str, seq: u64) -> Result<()> {
        let _ = (space, path, seq);
        todo!("client-core agent")
    }
}
