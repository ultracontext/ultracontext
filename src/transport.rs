//! Byte-stream transports to the hub (DESIGN §1). Owner: hub agent.

use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubAddr {
    /// `uc`, `user@host`, `ssh://user@host[:port]`
    Ssh { target: String, port: Option<u16> },
    /// `unix:/path/hub.sock`
    Unix(PathBuf),
    /// `tcp://host:port`
    Tcp(String),
    /// `local` = unix:$UC_HOME/hub.sock, auto-start a hub here
    Local,
}

impl HubAddr {
    pub fn parse(s: &str) -> Result<HubAddr> {
        let _ = s;
        todo!("hub agent")
    }
}

impl std::fmt::Display for HubAddr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HubAddr::Ssh { target, port: Some(p) } => write!(f, "ssh://{target}:{p}"),
            HubAddr::Ssh { target, port: None } => write!(f, "{target}"),
            HubAddr::Unix(p) => write!(f, "unix:{}", p.display()),
            HubAddr::Tcp(a) => write!(f, "tcp://{a}"),
            HubAddr::Local => write!(f, "local"),
        }
    }
}

/// An open, not-yet-handshaken byte stream to a hub. Both directions still need the magic.
pub struct Conn {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// ssh child process (killed on drop)
    pub child: Option<tokio::process::Child>,
}

/// Open a stream to the hub.
/// - Ssh: spawn `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3
///   [-p port] target -- <remote_uc or probe> hub connect` (probe tries `uc`, then
///   `~/.cargo/bin/uc`, `~/.local/bin/uc`, `/usr/local/bin/uc` via a tiny `sh -c` snippet).
/// - Unix / Local: connect to the socket; Local auto-starts `uc hub serve --detach` (same UC_HOME)
///   and waits up to 5s.
/// - Tcp: plain TCP (token is sent in Hello by the caller).
pub async fn connect(addr: &HubAddr, remote_uc: Option<&str>, uc_home: &Path) -> Result<Conn> {
    let _ = (addr, remote_uc, uc_home);
    todo!("hub agent")
}

/// `uc hub connect`: bridge stdin/stdout to `$UC_HOME/hub.sock`, starting the hub if needed.
pub async fn bridge_stdio(uc_home: &Path) -> Result<()> {
    let _ = uc_home;
    todo!("hub agent")
}
