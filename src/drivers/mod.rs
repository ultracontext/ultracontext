//! Agent drivers: teach the kernel where an agent keeps its sessions and how to move them
//! between machines (DESIGN §6.6). The kernel never parses agent formats itself.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::config::Config;
use crate::pathmap::PathMap;
use crate::proto::SessionMeta;

pub mod claude;
pub mod codex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFileKind {
    /// append-only JSONL, replicated line by line (DESIGN §6.2)
    Log,
    /// whole-file versioned (write-once sidecars, e.g. file-history backups)
    File,
}

/// A native agent file the driver wants synced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentFile {
    /// canonical path inside the driver's space, e.g. "sessions/<id>.jsonl"
    pub canonical: String,
    pub session_id: String,
    pub kind: AgentFileKind,
    /// true for the main transcript of a session (carries SessionMeta)
    pub transcript: bool,
}

pub trait AgentDriver: Send + Sync {
    /// "claude" | "codex"
    fn name(&self) -> &'static str;
    /// hub space, "@claude" | "@codex"
    fn space(&self) -> &'static str;
    /// native root on this machine ($CLAUDE_CONFIG_DIR or ~/.claude, $CODEX_HOME or ~/.codex)
    fn root(&self) -> PathBuf;
    /// Classify a native path relative to `root()` ('/' separated). None = never synced
    /// (secrets, caches, global state, ...).
    fn classify(&self, rel: &str) -> Option<AgentFile>;
    /// Session metadata from the head (first <=64 KiB) and tail (last <=64 KiB) of a LOCAL
    /// transcript. Paths in the result must be canonical (use `map.clean`).
    fn parse_meta(&self, session_id: &str, head: &[u8], tail: &[u8], map: &PathMap)
        -> Option<SessionMeta>;
    /// Native path (relative to `root()`) where `canonical` lives on THIS machine.
    /// `meta` is the session's transcript metadata (canonical form) when known.
    fn native_rel(&self, canonical: &str, meta: Option<&SessionMeta>, map: &PathMap)
        -> Option<String>;
    /// local -> canonical, one complete JSONL line without the trailing '\n'
    fn clean_line(&self, line: &str, map: &PathMap) -> String {
        map.clean(line)
    }
    /// canonical -> local
    fn smudge_line(&self, line: &str, map: &PathMap) -> String {
        map.smudge(line)
    }
    /// Rewrite one canonical line for a fork (new session id).
    fn fork_line(&self, line: &str, old_id: &str, new_id: &str) -> String;
    /// Canonical path of the forked copy of `canonical`.
    fn fork_canonical(&self, canonical: &str, old_id: &str, new_id: &str) -> String {
        canonical.replace(old_id, new_id)
    }
    /// argv that continues the session in `local_cwd`, e.g. ["claude","--resume",id].
    fn resume_argv(&self, meta: &SessionMeta, local_cwd: &Path) -> Vec<String>;
    fn new_session_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// Enabled drivers for this machine.
pub fn enabled(cfg: &Config) -> Vec<Arc<dyn AgentDriver>> {
    let mut v: Vec<Arc<dyn AgentDriver>> = Vec::new();
    if cfg.agents.claude {
        v.push(Arc::new(claude::Claude::from_env()));
    }
    if cfg.agents.codex {
        v.push(Arc::new(codex::Codex::from_env()));
    }
    v
}

pub fn by_space<'a>(drivers: &'a [Arc<dyn AgentDriver>], space: &str) -> Option<&'a Arc<dyn AgentDriver>> {
    drivers.iter().find(|d| d.space() == space)
}
