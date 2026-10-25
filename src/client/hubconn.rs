//! Persistent hub connection with request/response multiplexing and auto-reconnect.
//! Owner: client-core agent.

use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

use crate::proto::{Change, Entry, MachineInfo, Msg, Query};

/// Events from the connection task to the daemon loop.
#[derive(Debug)]
pub enum HubEvent {
    Connected { hub_id: String, head_seq: u64, version: String },
    Disconnected { error: String },
    /// a replicated change (+ inline append bytes)
    Change(Change, Vec<u8>),
    CaughtUp(u64),
}

#[derive(Debug, Clone)]
pub struct HubSettings {
    /// hub address string from config (parsed with transport::HubAddr::parse)
    pub addr: String,
    pub remote_uc: Option<String>,
    pub token: Option<String>,
    pub uc_home: PathBuf,
}

/// Outcome of a mutation request.
#[derive(Debug, Clone)]
pub enum Commit {
    Committed { seq: u64, entry: Entry },
    Conflict { current: Option<Entry>, reason: String },
    Busy { owner: String, owner_name: String, idle_ms: i64 },
}

/// Cheap-to-clone handle. A background task owns the stream, reconnects with exponential
/// backoff (0.5s .. 30s), sends Ping every 15s, and emits HubEvents.
#[derive(Clone)]
pub struct HubClient {
    _priv: (),
}

impl HubClient {
    /// Spawn the connection task. Events arrive on the returned receiver.
    pub fn start(settings: HubSettings, machine: MachineInfo) -> (HubClient, mpsc::UnboundedReceiver<HubEvent>) {
        let _ = (settings, machine);
        todo!("client-core agent")
    }

    pub fn is_connected(&self) -> bool {
        todo!("client-core agent")
    }

    pub fn head_seq(&self) -> u64 {
        todo!("client-core agent")
    }

    /// Wait until connected (or timeout).
    pub async fn wait_connected(&self, timeout: std::time::Duration) -> bool {
        let _ = timeout;
        todo!("client-core agent")
    }

    pub fn next_id(&self) -> u64 {
        todo!("client-core agent")
    }

    /// Send a request (its `id` must come from `next_id`) and await the matching response.
    /// Errors immediately when disconnected; `Msg::Error` responses become `Err`.
    pub async fn request(&self, msg: Msg, bin: Vec<u8>) -> Result<(Msg, Vec<u8>)> {
        let _ = (msg, bin);
        todo!("client-core agent")
    }

    pub async fn subscribe(&self, since: u64) -> Result<()> {
        let _ = since;
        todo!("client-core agent")
    }

    /// Upload a file's bytes as blob `hash` unless the hub already has it.
    pub async fn upload_file(&self, path: &Path, hash: &str) -> Result<()> {
        let _ = (path, hash);
        todo!("client-core agent")
    }

    /// Upload in-memory bytes as blob `hash` unless the hub already has it.
    pub async fn upload_bytes(&self, data: &[u8], hash: &str) -> Result<()> {
        let _ = (data, hash);
        todo!("client-core agent")
    }

    /// Download blob `hash` into `dest` (created/truncated), verifying the hash.
    pub async fn download_blob(&self, hash: &str, dest: &Path) -> Result<()> {
        let _ = (hash, dest);
        todo!("client-core agent")
    }

    /// Read `[offset, offset+len)` of a log.
    pub async fn read_log(&self, space: &str, path: &str, offset: u64, len: u64) -> Result<Vec<u8>> {
        let _ = (space, path, offset, len);
        todo!("client-core agent")
    }

    pub async fn query(&self, q: Query) -> Result<serde_json::Value> {
        let _ = q;
        todo!("client-core agent")
    }

    /// Send a mutation (Put/Delete/Append/LogReset/Claim/SpaceCreate) and map the response.
    pub async fn commit(&self, msg: Msg, bin: Vec<u8>) -> Result<Commit> {
        let _ = (msg, bin);
        todo!("client-core agent")
    }
}
