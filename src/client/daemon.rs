//! Daemon wiring: config, hub connection, engine + logsync, watcher, control server, timers.
//! Owner: cli agent.

use anyhow::Result;

use crate::paths::Paths;

/// Run the daemon in the foreground (until Shutdown or SIGTERM/SIGINT).
pub async fn run(paths: Paths) -> Result<()> {
    let _ = paths;
    todo!("cli agent")
}

/// Ensure a daemon is running for `paths` (spawn `uc daemon run` detached if the socket is dead),
/// waiting up to 5s for the control socket.
pub fn ensure_running(paths: &Paths) -> Result<()> {
    let _ = paths;
    todo!("cli agent")
}
