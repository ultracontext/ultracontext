//! Control API: daemon side (unix socket server) + CLI side (client). Owner: cli agent.

use anyhow::Result;
use std::path::Path;

use crate::proto::Ctl;

/// CLI side: send one control command to the local daemon and return its JSON result.
/// Errors carry the daemon's error code/message (e.g. code "busy" for resume).
pub async fn call(sock: &Path, cmd: Ctl) -> Result<serde_json::Value> {
    let _ = (sock, cmd);
    todo!("cli agent")
}
