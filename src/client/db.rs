//! Client state DB: remote (R), base (B) and local fingerprint per entry (DESIGN §5.1).
//! Owner: client-core agent. Used by engine and logsync.

use anyhow::Result;
use std::path::Path;

use crate::proto::{Change, Entry, Kind};

/// Local file fingerprint (cheap change detection without hashing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFp {
    pub size: u64,
    pub mtime_ns: i128,
    pub ino: u64,
    pub exec: bool,
}

/// Log sync point (DESIGN §6.2): local bytes [0, local_len) correspond to canonical
/// bytes [0, base.size).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogPoint {
    pub local_len: u64,
    /// tail fingerprint of the LOCAL file at local_len (hash::tail_fp_file)
    pub local_tail: String,
    /// native absolute path the log is materialized at on this machine
    pub native: String,
}

/// Last state agreed with the hub (B).
#[derive(Debug, Clone, PartialEq)]
pub struct Base {
    pub version: u64,
    pub kind: Kind,
    /// content hash (file/symlink) or canonical tail fingerprint (log)
    pub hash: String,
    pub size: u64,
    pub exec: bool,
    pub deleted: bool,
    /// local fingerprint right after we agreed (None for deleted)
    pub fp: Option<LocalFp>,
    pub log: Option<LogPoint>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Row {
    pub space: String,
    pub path: String,
    /// R: latest known hub state
    pub remote: Option<Entry>,
    /// B: last agreed state
    pub base: Option<Base>,
}

pub struct ClientDb {
    _priv: (),
}

impl ClientDb {
    pub fn open(path: &Path) -> Result<ClientDb> {
        let _ = path;
        todo!("client-core agent")
    }
    pub fn open_in_memory() -> Result<ClientDb> {
        todo!("client-core agent")
    }
    /// last applied hub seq (0 = none)
    pub fn cursor(&self) -> Result<u64> {
        todo!("client-core agent")
    }
    pub fn get(&self, space: &str, path: &str) -> Result<Option<Row>> {
        let _ = (space, path);
        todo!("client-core agent")
    }
    /// Upsert R from a change and advance the cursor to change.seq, atomically.
    pub fn record_remote(&self, change: &Change) -> Result<()> {
        let _ = change;
        todo!("client-core agent")
    }
    /// Upsert R only (e.g. from a Conflict/Committed response), no cursor change.
    pub fn set_remote(&self, entry: &Entry) -> Result<()> {
        let _ = entry;
        todo!("client-core agent")
    }
    pub fn set_base(&self, space: &str, path: &str, base: Option<&Base>) -> Result<()> {
        let _ = (space, path, base);
        todo!("client-core agent")
    }
    /// Drop all rows of a space (uc rm).
    pub fn forget_space(&self, space: &str) -> Result<()> {
        let _ = space;
        todo!("client-core agent")
    }
    pub fn rows(&self, space: &str) -> Result<Vec<Row>> {
        let _ = space;
        todo!("client-core agent")
    }
    /// Rows whose remote version is newer than base (pending down).
    pub fn rows_behind(&self, space: Option<&str>) -> Result<Vec<Row>> {
        let _ = space;
        todo!("client-core agent")
    }
    pub fn kv_get(&self, k: &str) -> Result<Option<String>> {
        let _ = k;
        todo!("client-core agent")
    }
    pub fn kv_set(&self, k: &str, v: &str) -> Result<()> {
        let _ = (k, v);
        todo!("client-core agent")
    }
}
