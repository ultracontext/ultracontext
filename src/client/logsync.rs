//! Agent-session replication: logs, ownership, forks, materialization, resume (DESIGN §6).
//! Owner: sessions agent.

use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{Ctx, Pending};
use crate::drivers::AgentDriver;
use crate::proto::{Change, ResumePlan, SessionInfo};

pub struct LogSync {
    _priv: (),
}

impl LogSync {
    pub fn new(ctx: Arc<Ctx>, drivers: Vec<Arc<dyn AgentDriver>>) -> Arc<LogSync> {
        let _ = (ctx, drivers);
        todo!("sessions agent")
    }

    /// Native roots to watch (e.g. ~/.claude, ~/.codex) that exist on this machine.
    pub fn roots(&self) -> Vec<PathBuf> {
        todo!("sessions agent")
    }

    /// Is this absolute path under an agent root?
    pub fn owns(&self, abs: &Path) -> bool {
        let _ = abs;
        todo!("sessions agent")
    }

    /// A native file changed (from the watcher). Debounced (≈200ms for logs).
    pub async fn on_local(&self, abs: PathBuf) {
        let _ = abs;
        todo!("sessions agent")
    }

    /// Handle a replicated change for an agent space ('@claude', '@codex'). MUST call
    /// ctx.db.record_remote(&change) before returning. `bin` = inline append bytes (may be empty).
    pub async fn on_remote(&self, change: Change, bin: Vec<u8>) -> Result<()> {
        let _ = (change, bin);
        todo!("sessions agent")
    }

    /// Scan agent roots + reconcile (startup, reconnect, periodic).
    pub async fn rescan(&self) -> Result<()> {
        todo!("sessions agent")
    }

    /// Background loop (debounced pushes, deferred materialization, fork reconciliation).
    pub async fn run(self: Arc<Self>) -> Result<()> {
        todo!("sessions agent")
    }

    pub fn pending(&self) -> Pending {
        todo!("sessions agent")
    }

    /// Fill `local_cwd` / `local` for sessions listed by the hub.
    pub fn localize(&self, sessions: &mut [SessionInfo]) {
        let _ = sessions;
        todo!("sessions agent")
    }

    /// Resolve `id` (exact or unique prefix; agent optional), materialize the transcript (+ sidecars)
    /// locally, claim ownership (Busy -> Err with code "busy" unless takeover/fork), and return
    /// how to launch it. With `fork`, create a forked session first and resume that.
    pub async fn resume(&self, agent: Option<&str>, id: &str, takeover: bool, fork: bool) -> Result<ResumePlan> {
        let _ = (agent, id, takeover, fork);
        todo!("sessions agent")
    }
}
