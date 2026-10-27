//! Control API: daemon side (unix socket server) + CLI side (client). Owner: cli agent.
//!
//! Same framing as the hub protocol (DESIGN §4.1): both sides send the magic, then the CLI sends
//! `Msg::Ctl{id, cmd}` frames and the daemon answers each with `Result{re, data}` or
//! `Error{re, code, msg}`. One connection may carry several requests, answered in order.

use anyhow::{Context, Result};
use serde_json::Value;
use std::fmt;
use std::future::Future;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{UnixListener, UnixStream};
use tracing::{debug, warn};

use crate::proto::{self, Ctl, Msg};

/// A control command failed. `code` is machine-readable:
/// - `conflict`: the hub rejected a change (CLI exit code 3)
/// - `offline`: the daemon is not connected to the hub
/// - `unreachable`: no daemon answers on the control socket
/// - `timeout`: the daemon did not answer in time
/// - `not_found`, `invalid`, `exists`, `restart_required`, `internal`, `error`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CtlError {
    pub code: String,
    pub msg: String,
}

impl CtlError {
    pub fn new(code: &str, msg: impl Into<String>) -> Self {
        CtlError {
            code: code.to_string(),
            msg: msg.into(),
        }
    }
}

impl fmt::Display for CtlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for CtlError {}

/// Find a `CtlError` anywhere in an error chain.
pub fn ctl_error(e: &anyhow::Error) -> Option<&CtlError> {
    e.chain().find_map(|c| c.downcast_ref::<CtlError>())
}

/// Boxed future returned by [`CtlHandler::handle`].
pub type CtlFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, CtlError>> + Send + 'a>>;

/// Daemon side: answers one control command.
pub trait CtlHandler: Send + Sync + 'static {
    fn handle(&self, cmd: Ctl) -> CtlFuture<'_>;
}

/// CLI side: send one control command to the local daemon and return its JSON result.
/// Errors carry the daemon's error code/message as a [`CtlError`];
/// a dead socket is `CtlError{code: "unreachable"}`.
pub async fn call(sock: &Path, cmd: Ctl) -> Result<Value> {
    let shutdown = matches!(cmd, Ctl::Shutdown);
    let mut stream = UnixStream::connect(sock).await.map_err(|e| {
        CtlError::new(
            "unreachable",
            format!("the uc daemon is not running ({}: {e})", sock.display()),
        )
    })?;
    let (mut r, mut w) = stream.split();
    proto::write_magic(&mut w).await?;
    proto::read_magic(&mut r).await.map_err(|e| {
        CtlError::new(
            "unreachable",
            format!("the uc daemon did not answer: {e:#}"),
        )
    })?;
    proto::write_frame(&mut w, &Msg::Ctl { id: 1, cmd }, &[]).await?;
    loop {
        let frame = match proto::read_frame(&mut r).await {
            Ok(Some(f)) => f,
            // the daemon may exit before its answer to Shutdown reaches us
            Ok(None) | Err(_) if shutdown => return Ok(Value::Null),
            Ok(None) => {
                return Err(CtlError::new(
                    "unreachable",
                    "the uc daemon closed the connection without answering (did it crash? see logs/daemon.log)",
                )
                .into())
            }
            Err(e) => return Err(e.context("reading the daemon's answer")),
        };
        match frame.msg {
            Msg::Result { re: 1, data } => return Ok(data),
            Msg::Error { code, msg, .. } => return Err(CtlError { code, msg }.into()),
            other => debug!(?other, "ignoring unexpected control frame"),
        }
    }
}

/// [`call`] with a deadline; on expiry fails with `CtlError{code: "timeout"}`.
pub async fn call_timeout(sock: &Path, cmd: Ctl, timeout: Duration) -> Result<Value> {
    match tokio::time::timeout(timeout, call(sock, cmd)).await {
        Ok(r) => r,
        Err(_) => Err(CtlError::new(
            "timeout",
            format!(
                "the uc daemon did not answer within {}s",
                timeout.as_secs().max(1)
            ),
        )
        .into()),
    }
}

/// Blocking liveness probe (usable outside a runtime): connect and exchange the magic.
pub fn probe(sock: &Path, timeout: Duration) -> bool {
    let Ok(mut s) = std::os::unix::net::UnixStream::connect(sock) else {
        return false;
    };
    if s.set_read_timeout(Some(timeout)).is_err() || s.set_write_timeout(Some(timeout)).is_err() {
        return false;
    }
    if s.write_all(proto::MAGIC).is_err() {
        return false;
    }
    let mut buf = [0u8; 8];
    s.read_exact(&mut buf).is_ok() && &buf == proto::MAGIC
}

/// Bind the control socket. Fails if a live daemon already answers on it; removes a stale socket
/// file; restricts the socket to the owner (0600).
pub fn bind(sock: &Path) -> Result<UnixListener> {
    if std::fs::symlink_metadata(sock).is_ok() {
        if std::os::unix::net::UnixStream::connect(sock).is_ok() {
            anyhow::bail!(
                "another uc daemon is already listening on {}",
                sock.display()
            );
        }
        std::fs::remove_file(sock)
            .with_context(|| format!("removing stale socket {}", sock.display()))?;
    }
    if let Some(dir) = sock.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let listener =
        UnixListener::bind(sock).with_context(|| format!("binding {}", sock.display()))?;
    std::fs::set_permissions(sock, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod 600 {}", sock.display()))?;
    Ok(listener)
}

/// Daemon side: serve control requests on `sock` until the task is dropped.
/// (The daemon itself binds first via [`bind`] so it fails before starting anything else.)
#[allow(dead_code)]
pub async fn serve(sock: &Path, handler: Arc<dyn CtlHandler>) -> Result<()> {
    let listener = bind(sock)?;
    serve_listener(listener, handler).await
}

/// Accept loop over an already bound listener (see [`bind`]).
pub async fn serve_listener(listener: UnixListener, handler: Arc<dyn CtlHandler>) -> Result<()> {
    loop {
        let stream = match listener.accept().await {
            Ok((s, _)) => s,
            Err(e) => {
                // EMFILE and friends: back off instead of spinning
                warn!("control socket accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let h = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_conn(stream, h).await {
                debug!("control connection ended: {e:#}");
            }
        });
    }
}

async fn serve_conn(mut stream: UnixStream, handler: Arc<dyn CtlHandler>) -> Result<()> {
    let (mut r, mut w) = stream.split();
    proto::write_magic(&mut w).await?;
    tokio::time::timeout(Duration::from_secs(10), proto::read_magic(&mut r))
        .await
        .context("control client sent no handshake")??;
    while let Some(frame) = proto::read_frame(&mut r).await? {
        let reply = match frame.msg {
            Msg::Ctl { id, cmd } => {
                // run on its own task so a panicking handler becomes an error reply, not a hang
                let h = handler.clone();
                let res = tokio::spawn(async move { h.handle(cmd).await }).await;
                match res {
                    Ok(Ok(data)) => Msg::Result { re: id, data },
                    Ok(Err(e)) => Msg::Error {
                        re: Some(id),
                        code: e.code,
                        msg: e.msg,
                    },
                    Err(j) => Msg::error(Some(id), "internal", format!("daemon bug: {j}")),
                }
            }
            other => Msg::error(
                other.id(),
                "invalid",
                "only control commands are accepted on the daemon socket",
            ),
        };
        if let Err(e) = proto::write_frame(&mut w, &reply, &[]).await {
            // e.g. an oversized result: nothing was written yet, so the stream is still in sync
            let fallback = Msg::error(reply.id().or(reply.re()), "internal", format!("{e:#}"));
            proto::write_frame(&mut w, &fallback, &[]).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fake;

    impl CtlHandler for Fake {
        fn handle(&self, cmd: Ctl) -> CtlFuture<'_> {
            Box::pin(async move {
                match cmd {
                    Ctl::Status => Ok(json!({"connected": true})),
                    Ctl::Reload => panic!("boom"),
                    _ => Ok(Value::Null),
                }
            })
        }
    }

    fn sock_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap()
    }

    // multi-threaded: `probe` is blocking and must not starve the server
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn call_and_serve_roundtrip() {
        let dir = sock_dir();
        let sock = dir.path().join("d.sock");
        let listener = bind(&sock).unwrap();
        let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        tokio::spawn(serve_listener(listener, Arc::new(Fake)));

        let v = call(&sock, Ctl::Status).await.unwrap();
        assert_eq!(v["connected"], true);

        // a panicking handler yields an error reply and the daemon keeps serving
        let err = call(&sock, Ctl::Reload).await.unwrap_err();
        assert_eq!(ctl_error(&err).unwrap().code, "internal");
        assert!(probe(&sock, Duration::from_secs(1)));
        assert!(call(&sock, Ctl::Shutdown).await.unwrap().is_null());
    }

    #[tokio::test]
    async fn dead_socket_is_unreachable() {
        let dir = sock_dir();
        let sock = dir.path().join("d.sock");
        let err = call(&sock, Ctl::Status).await.unwrap_err();
        assert_eq!(ctl_error(&err).unwrap().code, "unreachable");
        assert!(!probe(&sock, Duration::from_millis(100)));

        // a stale socket file (no listener) is replaced on bind
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap());
        assert!(sock.exists());
        let _l = bind(&sock).unwrap();
        // ...but a live one is not stolen
        assert!(bind(&sock).is_err());
    }

    #[tokio::test]
    async fn call_timeout_maps_to_timeout_code() {
        let dir = sock_dir();
        let sock = dir.path().join("d.sock");
        // accepts but never answers the handshake
        let _l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let err = call_timeout(&sock, Ctl::Status, Duration::from_millis(200))
            .await
            .unwrap_err();
        assert_eq!(ctl_error(&err).unwrap().code, "timeout");
    }
}
