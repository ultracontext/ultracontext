//! The per-machine sync daemon (DESIGN §1, §5, §6).
//!
//! Ownership:
//! - hubconn, db, watch: client-core agent
//! - logsync: sessions agent
//! - control, daemon: cli agent

use std::sync::{Mutex, RwLock};
use std::time::Instant;

use crate::config::Config;
use crate::paths::Paths;
use crate::proto::MachineInfo;

pub mod control;
pub mod daemon;
pub mod db;
pub mod hubconn;
pub mod logsync;
pub mod watch;

/// Shared daemon context.
pub struct Ctx {
    pub paths: Paths,
    pub cfg: RwLock<Config>,
    pub db: db::ClientDb,
    pub hub: hubconn::HubClient,
    pub machine: MachineInfo,
    pub started: Instant,
    pub last_error: Mutex<Option<String>>,
}

impl Ctx {
    pub fn cfg(&self) -> Config {
        self.cfg.read().unwrap().clone()
    }
    pub fn set_error(&self, e: impl std::fmt::Display) {
        *self.last_error.lock().unwrap() = Some(e.to_string());
    }
}

/// Work not yet done, for `uc status` / `uc sync`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Pending {
    /// local changes not yet committed on the hub
    pub up: u64,
    /// remote changes not yet applied locally
    pub down: u64,
    /// conflict copies created (paths, display form)
    pub conflicts: Vec<String>,
}

impl Pending {
    pub fn idle(&self) -> bool {
        self.up == 0 && self.down == 0
    }
}
