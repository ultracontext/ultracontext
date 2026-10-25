//! The hub: single source of truth (DESIGN §1, §3, §4, §6.4). Owner: hub agent.
//!
//! Serializes all mutations (one SQLite writer), stores blobs content-addressed, keeps logs,
//! and fans out `Change`s to subscribers in seq order.

use anyhow::Result;
use std::path::{Path, PathBuf};

pub mod store;

#[derive(Debug, Clone)]
pub struct HubOpts {
    /// UC_HOME of the hub process (state lives in $UC_HOME/hub, socket at $UC_HOME/hub.sock)
    pub uc_home: PathBuf,
    /// optional extra TCP listener, e.g. "0.0.0.0:7707"
    pub tcp: Option<String>,
    /// required token for TCP clients (UC_TOKEN)
    pub token: Option<String>,
    /// idle time after which a log owner loses its lease (DESIGN §6.4), default 120_000
    pub lease_idle_ms: i64,
}

/// Run the hub in the foreground until killed.
pub async fn serve(opts: HubOpts) -> Result<()> {
    let _ = opts;
    todo!("hub agent")
}

/// Start `uc hub serve` detached (setsid, stdio to hub.log), using the current executable and
/// the given UC_HOME. Returns once the socket accepts connections (<= 5s) or errors.
pub fn spawn_detached(uc_home: &Path) -> Result<()> {
    let _ = uc_home;
    todo!("hub agent")
}
