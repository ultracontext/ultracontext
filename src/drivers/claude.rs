//! Claude Code driver (DESIGN §6.6). Owner: sessions agent.

use std::path::{Path, PathBuf};

use super::{AgentDriver, AgentFile};
use crate::pathmap::PathMap;
use crate::proto::SessionMeta;

pub struct Claude {
    root: PathBuf,
}

impl Claude {
    /// root = $CLAUDE_CONFIG_DIR or ~/.claude
    pub fn from_env() -> Self {
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::paths::home().join(".claude"));
        Claude { root }
    }
    pub fn with_root(root: PathBuf) -> Self {
        Claude { root }
    }
}

impl AgentDriver for Claude {
    fn name(&self) -> &'static str {
        "claude"
    }
    fn space(&self) -> &'static str {
        "@claude"
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
        vec!["claude".into(), "--resume".into(), meta.id.clone()]
    }
}
