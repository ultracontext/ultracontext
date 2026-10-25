//! Codex CLI driver (DESIGN §6.6). Owner: sessions agent.

use std::path::{Path, PathBuf};

use super::{AgentDriver, AgentFile};
use crate::pathmap::PathMap;
use crate::proto::SessionMeta;

pub struct Codex {
    root: PathBuf,
}

impl Codex {
    /// root = $CODEX_HOME or ~/.codex
    pub fn from_env() -> Self {
        let root = std::env::var_os("CODEX_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::paths::home().join(".codex"));
        Codex { root }
    }
    pub fn with_root(root: PathBuf) -> Self {
        Codex { root }
    }
}

impl AgentDriver for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }
    fn space(&self) -> &'static str {
        "@codex"
    }
    fn root(&self) -> PathBuf {
        self.root.clone()
    }
    fn classify(&self, rel: &str) -> Option<AgentFile> {
        let _ = rel;
        todo!("sessions agent")
    }
    fn parse_meta(&self, session_id: &str, head: &[u8], tail: &[u8], map: &PathMap) -> Option<SessionMeta> {
        let _ = (session_id, head, tail, map);
        todo!("sessions agent")
    }
    fn native_rel(&self, canonical: &str, meta: Option<&SessionMeta>, map: &PathMap) -> Option<String> {
        let _ = (canonical, meta, map);
        todo!("sessions agent")
    }
    fn fork_line(&self, line: &str, old_id: &str, new_id: &str) -> String {
        let _ = (line, old_id, new_id);
        todo!("sessions agent")
    }
    fn resume_argv(&self, meta: &SessionMeta, local_cwd: &Path) -> Vec<String> {
        let _ = local_cwd;
        vec!["codex".into(), "resume".into(), meta.id.clone()]
    }
}
