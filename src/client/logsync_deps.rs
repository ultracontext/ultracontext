//! What LogSync needs from the outside world, as small traits so the state machine runs the
//! same against the real hub connection + client DB and against an in-memory hub in tests.

use anyhow::Result;
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::client::db::{Base, ClientDb, Row};
use crate::client::hubconn::{Commit, HubClient};
use crate::client::Ctx;
use crate::config::Config;
use crate::paths::Paths;
use crate::proto::{Change, Entry, MachineInfo, Msg, Query};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The hub operations session sync uses (DESIGN §4.2).
pub trait LogHub: Send + Sync {
    fn next_id(&self) -> u64;
    fn is_connected(&self) -> bool;
    fn commit(&self, msg: Msg, bin: Vec<u8>) -> BoxFut<'_, Result<Commit>>;
    fn read_log<'a>(
        &'a self,
        space: &'a str,
        path: &'a str,
        offset: u64,
        len: u64,
    ) -> BoxFut<'a, Result<Vec<u8>>>;
    fn query(&self, q: Query) -> BoxFut<'_, Result<Value>>;
    fn upload_bytes<'a>(&'a self, data: &'a [u8], hash: &'a str) -> BoxFut<'a, Result<()>>;
    fn download_blob<'a>(&'a self, hash: &'a str, dest: &'a Path) -> BoxFut<'a, Result<()>>;
    /// Refresh our lease on a log without ever acquiring it. Default: no-op.
    fn heartbeat<'a>(&'a self, space: &'a str, path: &'a str) -> BoxFut<'a, Result<()>> {
        let _ = (space, path);
        Box::pin(async { Ok(()) })
    }
    /// Drop our lease on a log (DESIGN §6.4). Default: no-op (test hubs without leases).
    fn release<'a>(&'a self, space: &'a str, path: &'a str) -> BoxFut<'a, Result<()>> {
        let _ = (space, path);
        Box::pin(async { Ok(()) })
    }
}

impl LogHub for HubClient {
    fn next_id(&self) -> u64 {
        HubClient::next_id(self)
    }
    fn is_connected(&self) -> bool {
        HubClient::is_connected(self)
    }
    fn commit(&self, msg: Msg, bin: Vec<u8>) -> BoxFut<'_, Result<Commit>> {
        Box::pin(HubClient::commit(self, msg, bin))
    }
    fn read_log<'a>(
        &'a self,
        space: &'a str,
        path: &'a str,
        offset: u64,
        len: u64,
    ) -> BoxFut<'a, Result<Vec<u8>>> {
        Box::pin(HubClient::read_log(self, space, path, offset, len))
    }
    fn query(&self, q: Query) -> BoxFut<'_, Result<Value>> {
        Box::pin(HubClient::query(self, q))
    }
    fn upload_bytes<'a>(&'a self, data: &'a [u8], hash: &'a str) -> BoxFut<'a, Result<()>> {
        Box::pin(HubClient::upload_bytes(self, data, hash))
    }
    fn download_blob<'a>(&'a self, hash: &'a str, dest: &'a Path) -> BoxFut<'a, Result<()>> {
        Box::pin(HubClient::download_blob(self, hash, dest))
    }
    fn heartbeat<'a>(&'a self, space: &'a str, path: &'a str) -> BoxFut<'a, Result<()>> {
        Box::pin(async move {
            let msg = Msg::Heartbeat {
                id: HubClient::next_id(self),
                space: space.to_string(),
                path: path.to_string(),
            };
            HubClient::request(self, msg, Vec::new()).await.map(|_| ())
        })
    }
    fn release<'a>(&'a self, space: &'a str, path: &'a str) -> BoxFut<'a, Result<()>> {
        Box::pin(async move {
            let msg = Msg::Release {
                id: HubClient::next_id(self),
                space: space.to_string(),
                path: path.to_string(),
            };
            HubClient::request(self, msg, Vec::new()).await.map(|_| ())
        })
    }
}

/// The client-DB operations session sync uses (R and B per entry, DESIGN §5.1 / §6.2).
pub trait LogStore: Send + Sync {
    fn get(&self, space: &str, path: &str) -> Result<Option<Row>>;
    fn record_remote(&self, change: &Change) -> Result<()>;
    fn set_remote(&self, entry: &Entry) -> Result<()>;
    fn set_base(&self, space: &str, path: &str, base: Option<&Base>) -> Result<()>;
    fn rows(&self, space: &str) -> Result<Vec<Row>>;
    fn kv_get(&self, k: &str) -> Result<Option<String>>;
    fn kv_set(&self, k: &str, v: &str) -> Result<()>;
}

impl LogStore for ClientDb {
    fn get(&self, space: &str, path: &str) -> Result<Option<Row>> {
        ClientDb::get(self, space, path)
    }
    fn record_remote(&self, change: &Change) -> Result<()> {
        ClientDb::record_remote(self, change)
    }
    fn set_remote(&self, entry: &Entry) -> Result<()> {
        ClientDb::set_remote(self, entry)
    }
    fn set_base(&self, space: &str, path: &str, base: Option<&Base>) -> Result<()> {
        ClientDb::set_base(self, space, path, base)
    }
    fn rows(&self, space: &str) -> Result<Vec<Row>> {
        ClientDb::rows(self, space)
    }
    fn kv_get(&self, k: &str) -> Result<Option<String>> {
        ClientDb::kv_get(self, k)
    }
    fn kv_set(&self, k: &str, v: &str) -> Result<()> {
        ClientDb::kv_set(self, k, v)
    }
}

/// The daemon's client DB, reached through the shared context.
pub(super) struct CtxStore(pub Arc<Ctx>);

impl LogStore for CtxStore {
    fn get(&self, space: &str, path: &str) -> Result<Option<Row>> {
        self.0.db.get(space, path)
    }
    fn record_remote(&self, change: &Change) -> Result<()> {
        self.0.db.record_remote(change)
    }
    fn set_remote(&self, entry: &Entry) -> Result<()> {
        self.0.db.set_remote(entry)
    }
    fn set_base(&self, space: &str, path: &str, base: Option<&Base>) -> Result<()> {
        self.0.db.set_base(space, path, base)
    }
    fn rows(&self, space: &str) -> Result<Vec<Row>> {
        self.0.db.rows(space)
    }
    fn kv_get(&self, k: &str) -> Result<Option<String>> {
        self.0.db.kv_get(k)
    }
    fn kv_set(&self, k: &str, v: &str) -> Result<()> {
        self.0.db.kv_set(k, v)
    }
}

/// Timing knobs (tests shrink them).
#[derive(Debug, Clone)]
pub struct Tunables {
    /// quiet time before a changed log is pushed
    pub debounce: Duration,
    /// a transcript modified (by someone else) within this window counts as live
    pub hot_ms: i64,
    /// a diverged original must be unchanged this long before it is replaced (DESIGN §6.4)
    pub cold_ms: i64,
    /// how long `resume` waits for the transcript to catch up with the hub
    pub resume_timeout: Duration,
}

impl Default for Tunables {
    fn default() -> Self {
        Tunables {
            debounce: Duration::from_millis(200),
            hot_ms: 10_000,
            cold_ms: 30_000,
            resume_timeout: Duration::from_secs(120),
        }
    }
}

/// Everything LogSync depends on.
#[derive(Clone)]
pub struct Deps {
    pub hub: Arc<dyn LogHub>,
    pub store: Arc<dyn LogStore>,
    pub machine: MachineInfo,
    pub paths: Paths,
    /// $HOME of this machine (path map + `~` in space paths)
    pub home: PathBuf,
    /// current config (re-read on every use so `uc add` / reload are picked up)
    pub cfg: Arc<dyn Fn() -> Config + Send + Sync>,
    /// surfaced in `uc status` (Ctx::set_error)
    pub on_error: Option<Arc<dyn Fn(String) + Send + Sync>>,
    pub tun: Tunables,
}

/// `resume` hit a session that another machine is actively writing (DESIGN §6.4).
/// The daemon maps it to error code "busy" (CLI exit code 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusyError {
    pub owner_name: String,
    pub idle_ms: i64,
}

impl std::fmt::Display for BusyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "busy: session is live on {} (active {}s ago)",
            self.owner_name,
            self.idle_ms.max(0) / 1000
        )
    }
}

impl std::error::Error for BusyError {}
