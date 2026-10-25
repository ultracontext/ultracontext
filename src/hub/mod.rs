//! The hub: single source of truth (DESIGN §1, §3, §4, §6.4). Owner: hub agent.
//!
//! Serializes all mutations (one SQLite writer), stores blobs content-addressed, keeps logs,
//! and fans out `Change`s to subscribers in seq order.

use anyhow::{bail, Context, Result};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::watch;
use tracing::{info, warn};

use crate::paths::Paths;

mod conn;
pub mod store;
#[cfg(test)]
mod tests;

use store::{BlobStore, Store};

/// Default `lease_idle_ms` (DESIGN §6.4).
pub const DEFAULT_LEASE_IDLE_MS: i64 = 120_000;

#[derive(Debug, Clone)]
pub struct HubOpts {
    /// UC_HOME of the hub process (state lives in $UC_HOME/hub, socket at $UC_HOME/hub.sock)
    pub uc_home: PathBuf,
    /// optional extra TCP listener, e.g. "0.0.0.0:7707"
    pub tcp: Option<String>,
    /// required token for TCP clients (UC_TOKEN)
    pub token: Option<String>,
    /// idle time after which a log owner loses its lease (DESIGN §6.4), default 120_000
    pub lease_idle_ms: i64,
}

impl HubOpts {
    /// Defaults: no TCP listener, token from `UC_TOKEN`, default lease.
    pub fn new(uc_home: PathBuf) -> HubOpts {
        HubOpts {
            uc_home,
            tcp: None,
            token: std::env::var("UC_TOKEN").ok().filter(|t| !t.is_empty()),
            lease_idle_ms: DEFAULT_LEASE_IDLE_MS,
        }
    }
}

/// State shared by all connections of one hub.
pub(crate) struct HubState {
    store: Mutex<Store>,
    blobs: BlobStore,
    hub_id: String,
    token: Option<String>,
    /// highest committed seq; subscription pumps wait on it
    head_tx: watch::Sender<u64>,
    shutdown: watch::Sender<bool>,
    /// live connections per machine id
    conns: Mutex<HashMap<String, usize>>,
}

impl HubState {
    fn new(store: Store, token: Option<String>) -> Arc<HubState> {
        let (head_tx, _) = watch::channel(store.head());
        let (shutdown, _) = watch::channel(false);
        Arc::new(HubState {
            blobs: store.blobs().clone(),
            hub_id: store.hub_id().to_string(),
            store: Mutex::new(store),
            token,
            head_tx,
            shutdown,
            conns: Mutex::new(HashMap::new()),
        })
    }

    /// Run `f` with exclusive access to the store on the blocking pool. Subscribers are woken
    /// while the lock is still held, so head notifications are monotonic.
    pub(crate) async fn with_store<T, F>(self: &Arc<Self>, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        let st = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let mut store = st.store.lock().unwrap_or_else(PoisonError::into_inner);
            let r = f(&mut store);
            let head = store.head();
            st.head_tx.send_if_modified(|h| {
                let newer = head > *h;
                if newer {
                    *h = head;
                }
                newer
            });
            r
        })
        .await
        .context("hub store task failed")?
    }

    pub(crate) fn head(&self) -> u64 {
        *self.head_tx.borrow()
    }

    fn set_connected(&self, machine: &str, up: bool) {
        let mut c = self.conns.lock().unwrap_or_else(PoisonError::into_inner);
        let n = c.entry(machine.to_string()).or_insert(0);
        if up {
            *n += 1;
        } else {
            *n = n.saturating_sub(1);
            if *n == 0 {
                c.remove(machine);
            }
        }
    }

    fn connected_ids(&self) -> HashSet<String> {
        let c = self.conns.lock().unwrap_or_else(PoisonError::into_inner);
        c.keys().cloned().collect()
    }
}

/// Run the hub in the foreground until killed.
pub async fn serve(opts: HubOpts) -> Result<()> {
    serve_with_shutdown(opts, shutdown_signal()).await
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let (mut term, mut int) = match (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) {
        (Ok(t), Ok(i)) => (t, i),
        (Err(e), _) | (_, Err(e)) => {
            warn!("cannot install signal handlers: {e}");
            return std::future::pending().await;
        }
    };
    tokio::select! {
        _ = term.recv() => info!("SIGTERM: shutting down"),
        _ = int.recv() => info!("SIGINT: shutting down"),
    }
}

/// Like `serve`, but stops when `shutdown` completes instead of on SIGTERM/SIGINT.
pub async fn serve_with_shutdown(opts: HubOpts, shutdown: impl Future<Output = ()>) -> Result<()> {
    let paths = Paths::new(opts.uc_home.clone());
    let hub_dir = paths.hub_dir();
    std::fs::create_dir_all(&hub_dir).with_context(|| format!("creating {}", hub_dir.display()))?;
    let _ = std::fs::set_permissions(&hub_dir, std::fs::Permissions::from_mode(0o700));
    let _lock = lock_exclusive(&hub_dir.join("hub.lock"))?;

    let token = opts.token.clone().filter(|t| !t.is_empty());
    if opts.tcp.is_some() && token.is_none() {
        bail!("the TCP listener requires a token: set UC_TOKEN");
    }
    let store = Store::open(&hub_dir, opts.lease_idle_ms)?;

    let sock = paths.hub_sock();
    let sock_len = sock.as_os_str().len();
    if sock_len > 100 {
        bail!(
            "hub socket path is too long for a unix socket ({sock_len} bytes): {}; use a shorter UC_HOME",
            sock.display()
        );
    }
    if sock.exists() {
        if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
            bail!("a hub is already listening on {}", sock.display());
        }
        std::fs::remove_file(&sock)
            .with_context(|| format!("removing stale socket {}", sock.display()))?;
    }
    let unix = UnixListener::bind(&sock).with_context(|| format!("binding {}", sock.display()))?;
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod {}", sock.display()))?;
    let tcp = match &opts.tcp {
        Some(addr) => Some(
            TcpListener::bind(addr.as_str())
                .await
                .with_context(|| format!("binding tcp {addr}"))?,
        ),
        None => None,
    };
    let pid_path = paths.hub_pid();
    let pid = std::process::id().to_string();
    std::fs::write(&pid_path, &pid).with_context(|| format!("writing {}", pid_path.display()))?;

    let state = HubState::new(store, token);
    info!(
        hub_id = %state.hub_id,
        head = state.head(),
        socket = %sock.display(),
        tcp = ?tcp.as_ref().and_then(|l| l.local_addr().ok()),
        version = crate::proto::VERSION,
        "hub listening"
    );

    let unix_loop = {
        let state = state.clone();
        async move {
            loop {
                match unix.accept().await {
                    Ok((stream, _)) => {
                        tokio::spawn(conn::serve_conn(
                            state.clone(),
                            stream,
                            false,
                            "unix".into(),
                        ));
                    }
                    Err(e) => {
                        warn!("accept on {}: {e}", sock.display());
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            }
        }
    };
    let tcp_loop = {
        let state = state.clone();
        async move {
            let Some(tcp) = tcp else {
                return std::future::pending::<()>().await;
            };
            loop {
                match tcp.accept().await {
                    Ok((stream, peer)) => {
                        if let Err(e) = stream.set_nodelay(true) {
                            warn!("set_nodelay: {e}");
                        }
                        tokio::spawn(conn::serve_conn(
                            state.clone(),
                            stream,
                            true,
                            peer.to_string(),
                        ));
                    }
                    Err(e) => {
                        warn!("tcp accept: {e}");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = unix_loop => {}
        _ = tcp_loop => {}
        _ = shutdown => {}
    }

    state.shutdown.send_replace(true);
    let _ = std::fs::remove_file(paths.hub_sock());
    if std::fs::read_to_string(&pid_path).is_ok_and(|p| p.trim() == pid) {
        let _ = std::fs::remove_file(&pid_path);
    }
    // Let in-flight store operations finish before the caller drops the runtime.
    let _ = state.with_store(|_| Ok(())).await;
    info!("hub stopped");
    Ok(())
}

/// One hub per UC_HOME: an exclusive flock held for the life of the process.
fn lock_exclusive(path: &Path) -> Result<File> {
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    // SAFETY: flock on a file descriptor we own.
    let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::WouldBlock {
            bail!(
                "another hub is already running here ({} is locked)",
                path.display()
            );
        }
        return Err(err).with_context(|| format!("locking {}", path.display()));
    }
    Ok(f)
}

/// Start `uc hub serve` detached (setsid, stdio to hub.log), using the current executable and
/// the given UC_HOME. Returns once the socket accepts connections (<= 5s) or errors.
pub fn spawn_detached(uc_home: &Path) -> Result<()> {
    spawn_detached_args(uc_home, &[])
}

/// `spawn_detached` with extra `uc hub serve` arguments (e.g. `["--tcp", "0.0.0.0:7707"]`).
pub fn spawn_detached_args(uc_home: &Path, extra: &[String]) -> Result<()> {
    let paths = Paths::new(uc_home.to_path_buf());
    let sock = paths.hub_sock();
    if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
        return Ok(());
    }
    std::fs::create_dir_all(paths.hub_dir())
        .with_context(|| format!("creating {}", paths.hub_dir().display()))?;
    let log_path = paths.hub_log();
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("opening {}", log_path.display()))?;
    let exe = std::env::current_exe().context("locating the uc executable")?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["hub", "serve"])
        .args(extra)
        .env("UC_HOME", uc_home)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: setsid is async-signal-safe; it detaches the hub from our session and terminal.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("starting {} hub serve", exe.display()))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut exited = None;
    loop {
        if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
            break;
        }
        if exited.is_none() {
            // Keep polling after an early exit: a concurrent starter may own the hub.
            exited = child.try_wait()?;
        }
        if Instant::now() >= deadline {
            let why = match exited {
                Some(status) => format!("exited with {status}"),
                None => "did not start listening within 5s".to_string(),
            };
            if exited.is_none() {
                std::thread::spawn(move || child.wait());
            }
            bail!("hub {why}; see {}", log_path.display());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if exited.is_none() {
        // Reap the hub if it ever exits while we are still running.
        std::thread::spawn(move || child.wait());
    }
    Ok(())
}
