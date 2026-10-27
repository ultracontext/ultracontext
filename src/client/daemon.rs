//! Daemon wiring: config, hub connection, session sync, watcher, control server, timers.
//! Owner: cli agent.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{IsTerminal, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, Notify};
use tracing::{debug, error, info, warn};

use super::control::{self, CtlError, CtlFuture, CtlHandler};
use super::db::ClientDb;
use super::hubconn::{HubClient, HubEvent, HubSettings};
use super::logsync::LogSync;
use super::watch::Watcher;
use super::{Ctx, Pending};
use crate::config::Config;
use crate::drivers;
use crate::paths::{self, Paths};
use crate::proto::{self, Ctl, HubStatus, Query, SessionInfo, StatusReport, SyncReport};

/// Full rescan cadence (DESIGN §5.1).
const RESCAN_EVERY: Duration = Duration::from_secs(300);
/// Housekeeping tick; a much later wall clock than expected means the machine slept.
const TICK: Duration = Duration::from_secs(30);
/// Trash keeps every file uc overwrote or deleted locally for this long (DESIGN §2).
const TRASH_KEEP_DAYS: i64 = 30;
const PURGE_EVERY: Duration = Duration::from_secs(24 * 3600);
const WAKE_GAP_MS: i64 = 90_000;
const START_TIMEOUT: Duration = Duration::from_secs(5);
const LIVE_QUERY_TIMEOUT: Duration = Duration::from_millis(1500);
const HUB_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;
const KV_HUB_ID: &str = "hub_id";
const HUB_UNREACHABLE: &str = "hub unreachable";
const SUBSCRIBE_FAILED: &str = "subscribe failed";

/// Tracing to stderr, filter from `UC_LOG` (default `default_filter`). No-op if already set up.
pub fn init_tracing(default_filter: &str) {
    use tracing_subscriber::EnvFilter;
    let filter =
        EnvFilter::try_from_env("UC_LOG").unwrap_or_else(|_| EnvFilter::new(default_filter));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .try_init();
}

/// Run the daemon in the foreground (until Shutdown or SIGTERM/SIGINT).
pub async fn run(paths: Paths) -> Result<()> {
    init_tracing("info");
    paths
        .ensure()
        .with_context(|| format!("creating {}", paths.root.display()))?;
    // config.toml may hold a token; the control socket must not be reachable by others
    let _ = std::fs::set_permissions(&paths.root, std::fs::Permissions::from_mode(0o700));
    let cfg = match Config::load(&paths.config())? {
        Some(c) if c.is_initialized() => c,
        _ => bail!(
            "uc is not set up on this machine ({} has no hub); run 'uc init <hub>' first",
            paths.config().display()
        ),
    };
    let marker = hub_mismatch_marker(&paths);
    if marker.exists() {
        let why = std::fs::read_to_string(&marker).unwrap_or_default();
        bail!("sync is stopped: {}", why.trim());
    }
    let _pid = PidLock::acquire(&paths.daemon_pid())?;
    let listener = control::bind(&paths.daemon_sock())?;
    info!(pid = std::process::id(), version = proto::VERSION, hub = %cfg.hub, "uc daemon starting");

    let db = ClientDb::open(&paths.client_db())
        .with_context(|| format!("opening {}", paths.client_db().display()))?;
    let machine = cfg.machine_info();
    let (hub, mut hub_rx) = HubClient::start(hub_settings(&cfg, &paths), machine.clone());
    let agent_drivers = drivers::enabled(&cfg);
    let ctx = Arc::new(Ctx {
        paths: paths.clone(),
        cfg: RwLock::new(cfg),
        db,
        hub,
        machine,
        started: Instant::now(),
        last_error: Mutex::new(None),
    });
    let logsync = LogSync::new(ctx.clone(), agent_drivers);
    let (fs_tx, mut fs_rx) = mpsc::unbounded_channel::<PathBuf>();
    let watcher = Watcher::new(fs_tx).context("starting the file watcher")?;
    let (stop_tx, mut stop_rx) = watch::channel(false);
    // If a background loop dies the daemon exits non-zero so that the service manager (or the
    // next CLI call) restarts it, instead of silently not syncing.
    let (fatal_tx, mut fatal_rx) = mpsc::unbounded_channel::<String>();
    let d = Arc::new(Daemon {
        ctx,
        logsync,
        watcher: Arc::new(Mutex::new(watcher)),
        hub_version: Mutex::new(None),
        rescan_lock: tokio::sync::Mutex::new(()),
        config_lock: tokio::sync::Mutex::new(()),
        rescan_wanted: Notify::new(),
        stop: stop_tx,
        fatal: fatal_tx.clone(),
    });

    supervise("session sync", d.logsync.clone().run(), fatal_tx.clone());
    supervise(
        "control server",
        control::serve_listener(listener, d.clone() as Arc<dyn CtlHandler>),
        fatal_tx.clone(),
    );
    tokio::spawn(d.clone().rescan_worker());
    {
        // inotify registration walks whole trees: keep it off the async threads
        let (w, c) = (d.watcher.clone(), d.ctx.clone());
        let roots = d.logsync.roots();
        tokio::task::spawn_blocking(move || {
            for root in roots {
                watch_add_blocking(&w, &c, &root);
            }
        });
    }
    {
        // offline at startup: still scan, so `uc status` shows local pending work
        let d = d.clone();
        tokio::spawn(async move {
            if !d.ctx.hub.wait_connected(Duration::from_secs(10)).await {
                d.rescan_wanted.notify_one();
            }
        });
    }

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("installing SIGTERM handler")?;
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .context("installing SIGINT handler")?;
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_rescan = Instant::now();
    // first purge one tick after start, then daily
    let mut last_purge = Instant::now() - PURGE_EVERY + TICK;
    let mut last_wall = paths::now_ms();

    let result: Result<()> = loop {
        tokio::select! {
            ev = hub_rx.recv() => match ev {
                Some(ev) => d.on_hub_event(ev).await,
                None => break Err(anyhow!("hub connection task stopped")),
            },
            Some(p) = fs_rx.recv() => d.route_local(p).await,
            _ = tick.tick() => {
                let now = paths::now_ms();
                let woke = now - last_wall > WAKE_GAP_MS;
                last_wall = now;
                if last_purge.elapsed() >= PURGE_EVERY {
                    last_purge = Instant::now();
                    let trash = d.ctx.paths.trash();
                    tokio::task::spawn_blocking(move || {
                        match super::logsync::purge_trash(&trash, TRASH_KEEP_DAYS) {
                            Ok(n) if n > 0 => info!("trash: removed {n} entries older than {TRASH_KEEP_DAYS} days"),
                            Ok(_) => {}
                            Err(e) => warn!("trash purge: {e:#}"),
                        }
                    });
                }
                if woke || last_rescan.elapsed() >= RESCAN_EVERY {
                    if woke {
                        info!("clock jumped (sleep/wake?): rescanning");
                    }
                    last_rescan = Instant::now();
                    d.rescan_wanted.notify_one();
                }
            }
            Some(msg) = fatal_rx.recv() => break Err(anyhow!(msg)),
            _ = stop_rx.changed() => break Ok(()),
            _ = sigterm.recv() => break Ok(()),
            _ = sigint.recv() => break Ok(()),
        }
    };
    if result.is_ok() {
        // a clean stop (uc daemon stop, logout, shutdown): another machine may continue our
        // sessions right away instead of waiting for the lease to run out
        let _ = tokio::time::timeout(Duration::from_secs(3), d.logsync.release_all()).await;
    }
    let _ = std::fs::remove_file(paths.daemon_sock());
    match &result {
        Ok(()) => info!("uc daemon stopped"),
        Err(e) => error!("uc daemon exiting: {e:#}"),
    }
    result
}

/// Written when the hub's identity changed under this machine's sync state (see `uc init`).
pub fn hub_mismatch_marker(paths: &Paths) -> PathBuf {
    paths.root.join("hub_mismatch")
}

/// Move client.db (+ WAL files) aside so the next daemon starts a fresh sync state against a
/// new hub. Local files are untouched; the first sync reconciles them by content.
/// Must only be called while no daemon runs. Returns the backup path.
pub fn reset_sync_state(paths: &Paths) -> Result<Option<PathBuf>> {
    let db = paths.client_db();
    if !db.exists() {
        let _ = std::fs::remove_file(hub_mismatch_marker(paths));
        return Ok(None);
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let backup = PathBuf::from(format!("{}.{stamp}.old", db.display()));
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", db.display()));
        if from.exists() {
            let to = PathBuf::from(format!("{}{suffix}", backup.display()));
            std::fs::rename(&from, &to)
                .with_context(|| format!("moving {} aside", from.display()))?;
        }
    }
    let _ = std::fs::remove_file(hub_mismatch_marker(paths));
    Ok(Some(backup))
}

fn hub_settings(cfg: &Config, paths: &Paths) -> HubSettings {
    let non_empty = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
    HubSettings {
        addr: cfg.hub.clone(),
        remote_uc: non_empty(&cfg.remote_uc),
        token: non_empty(&cfg.token)
            .or_else(|| std::env::var("UC_TOKEN").ok().and_then(|t| non_empty(&t))),
        uc_home: paths.root.clone(),
    }
}

fn supervise<F>(name: &'static str, fut: F, fatal: mpsc::UnboundedSender<String>)
where
    F: std::future::Future<Output = Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let msg = match tokio::spawn(fut).await {
            Ok(Ok(())) => format!("{name} loop stopped"),
            Ok(Err(e)) => format!("{name} loop failed: {e:#}"),
            Err(j) => format!("{name} loop crashed: {j}"),
        };
        let _ = fatal.send(msg);
    });
}

struct Daemon {
    ctx: Arc<Ctx>,
    logsync: Arc<LogSync>,
    watcher: Arc<Mutex<Watcher>>,
    hub_version: Mutex<Option<String>>,
    /// one full rescan at a time
    rescan_lock: tokio::sync::Mutex<()>,
    /// serializes config reloads
    config_lock: tokio::sync::Mutex<()>,
    /// coalescing rescan requests: a request during a rescan causes exactly one more
    rescan_wanted: Notify,
    stop: watch::Sender<bool>,
    fatal: mpsc::UnboundedSender<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn watch_add_blocking(watcher: &Mutex<Watcher>, ctx: &Ctx, root: &Path) {
    if let Err(e) = lock(watcher).add(root) {
        // correctness never depends on the watcher (periodic rescans), but it is much slower
        warn!("cannot watch {}: {e:#}", root.display());
        ctx.set_error(format!(
            "cannot watch {} (changes are picked up by the 5-minute rescan only): {e:#}",
            root.display()
        ));
    }
}

impl Daemon {
    /// Does the hub still hold the exact change this machine's cursor points at? A hub restored
    /// from an older backup may already be past our cursor again, with different changes.
    async fn cursor_change_gone(&self) -> bool {
        let Ok(Some((seq, space, path, hash))) = self.ctx.db.cursor_at() else {
            return false;
        };
        let q = Query::History {
            space,
            path,
            limit: Some(100_000),
        };
        let Ok(v) = self.ctx.hub.query(q).await else {
            return false;
        };
        let Ok(hist) = serde_json::from_value::<Vec<proto::LogRecord>>(v) else {
            return false;
        };
        !hist.iter().any(|r| r.seq == seq && r.hash == hash)
    }

    async fn on_hub_event(&self, ev: HubEvent) {
        match ev {
            HubEvent::Connected {
                hub_id,
                head_seq,
                version,
            } => {
                info!(%hub_id, head_seq, %version, "connected to hub");
                if version != proto::VERSION {
                    warn!(
                        "hub runs uc {version}, this machine runs {}",
                        proto::VERSION
                    );
                }
                *lock(&self.hub_version) = Some(version);
                if let Err(e) = self.check_hub_identity(&hub_id) {
                    // stop everything: pushing with another hub's base versions could rewrite
                    // local files through the conflict path. `uc init` sees the marker and resets.
                    let msg = format!("{e:#}");
                    let _ = std::fs::write(hub_mismatch_marker(&self.ctx.paths), &msg);
                    self.ctx.set_error(&msg);
                    let _ = self.fatal.send(msg);
                    return;
                }
                {
                    // connectivity errors are resolved now; others (e.g. watcher) still apply
                    let mut last = lock(&self.ctx.last_error);
                    if last.as_deref().is_some_and(|e| {
                        e.starts_with(HUB_UNREACHABLE) || e.starts_with(SUBSCRIBE_FAILED)
                    }) {
                        *last = None;
                    }
                }
                let cursor = match self.ctx.db.cursor() {
                    Ok(c) => c,
                    Err(e) => {
                        error!("reading sync cursor: {e:#}");
                        self.ctx.set_error(format!("reading sync cursor: {e:#}"));
                        return;
                    }
                };
                let rolled_back = head_seq < cursor || self.cursor_change_gone().await;
                if rolled_back {
                    // The hub went back in time (restored from a backup / VM snapshot). Our bases
                    // point at changes it no longer has: applying its future changes on top would
                    // overwrite local edits it lost. Stop; `uc init` re-joins safely (differing
                    // files become pushes or conflict copies).
                    let msg = format!(
                        "the hub went back in time (it is at change #{head_seq} and no longer has change #{cursor} \
                         this machine already synced): was it restored from a backup? Sync is stopped so nothing \
                         is overwritten; run 'uc init {}' to re-join safely",
                        self.ctx.cfg().hub
                    );
                    let _ = std::fs::write(hub_mismatch_marker(&self.ctx.paths), &msg);
                    self.ctx.set_error(&msg);
                    let _ = self.fatal.send(msg);
                    return;
                }
                if let Err(e) = self.ctx.hub.subscribe(cursor).await {
                    warn!("{SUBSCRIBE_FAILED}: {e:#}");
                    self.ctx.set_error(format!("{SUBSCRIBE_FAILED}: {e:#}"));
                    return;
                }
                self.rescan_wanted.notify_one();
            }
            HubEvent::Disconnected { error } => {
                warn!("hub disconnected: {error}");
                self.ctx.set_error(format!("{HUB_UNREACHABLE}: {error}"));
            }
            HubEvent::Change(change, bin) => {
                let (seq, space, path) = (
                    change.seq,
                    change.entry.space.clone(),
                    change.entry.path.clone(),
                );
                // sequential on purpose: changes must be applied in seq order
                let r = if space.starts_with('@') {
                    self.logsync.on_remote(change, bin).await
                } else {
                    // a folder synced by an older uc version: not ours to apply
                    self.ctx.db.skip_remote(&change)
                };
                if let Err(e) = r {
                    warn!(seq, %space, %path, "applying remote change failed: {e:#}");
                    self.ctx
                        .set_error(format!("applying {space}/{path} (seq {seq}): {e:#}"));
                }
            }
            HubEvent::CaughtUp(seq) => debug!(seq, "caught up with the hub"),
        }
    }

    /// A client db belongs to exactly one hub: following another hub's seq numbers with this
    /// cursor would mis-apply history, so refuse instead.
    fn check_hub_identity(&self, hub_id: &str) -> Result<()> {
        match self.ctx.db.kv_get(KV_HUB_ID)? {
            None => self.ctx.db.kv_set(KV_HUB_ID, hub_id),
            Some(known) if known == hub_id => Ok(()),
            Some(known) => bail!(
                "the hub at '{}' is a different hub (id {hub_id}) than the one this machine synced \
                 with (id {known}); refusing to sync. To start over with this hub, run \
                 'uc init {}' (it resets this machine's sync state; files are kept)",
                self.ctx.cfg().hub,
                self.ctx.cfg().hub
            ),
        }
    }

    async fn route_local(&self, p: PathBuf) {
        if self.logsync.owns(&p) {
            self.logsync.on_local(p).await
        }
    }

    async fn rescan_worker(self: Arc<Self>) {
        loop {
            self.rescan_wanted.notified().await;
            self.rescan_all().await;
        }
    }

    async fn rescan_all(&self) {
        let _g = self.rescan_lock.lock().await;
        let t = Instant::now();
        if let Err(e) = self.logsync.rescan().await {
            warn!("session rescan failed: {e:#}");
            self.ctx.set_error(format!("session rescan failed: {e:#}"));
        }
        debug!(ms = t.elapsed().as_millis() as u64, "rescan done");
    }

    fn pending(&self) -> Pending {
        self.logsync.pending()
    }

    fn offline_error(&self) -> CtlError {
        match lock(&self.ctx.last_error).clone() {
            Some(e) => CtlError::new("offline", format!("not connected to the hub ({e})")),
            None => CtlError::new("offline", "not connected to the hub"),
        }
    }

    fn hub_error(&self, e: anyhow::Error) -> CtlError {
        if let Some(c) = control::ctl_error(&e) {
            return c.clone();
        }
        if !self.ctx.hub.is_connected() {
            let mut o = self.offline_error();
            o.msg = format!("{} ({e:#})", o.msg);
            return o;
        }
        CtlError::new("error", format!("{e:#}"))
    }

    async fn dispatch(&self, cmd: Ctl) -> Result<Value, CtlError> {
        match cmd {
            Ctl::Status => to_json(&self.status().await),
            Ctl::Sync { timeout_ms } => to_json(&self.sync(timeout_ms).await?),
            Ctl::Query { query } => self.query(query).await,
            Ctl::Reload => self.reload().await,
            Ctl::Shutdown => {
                info!("shutdown requested");
                let _ = self.stop.send(true);
                Ok(Value::Null)
            }
        }
    }

    async fn status(&self) -> StatusReport {
        let cfg = self.ctx.cfg();
        let pending = self.pending();
        let connected = self.ctx.hub.is_connected();
        let sessions_live = if connected {
            self.live_sessions().await
        } else {
            Vec::new()
        };
        StatusReport {
            machine: Some(self.ctx.machine.clone()),
            hub: cfg.hub,
            connected,
            hub_version: lock(&self.hub_version).clone(),
            cursor: self.ctx.db.cursor().unwrap_or(0),
            head_seq: self.ctx.hub.head_seq(),
            pending_up: pending.up,
            pending_down: pending.down,
            conflicts: pending.conflicts,
            sessions_live,
            last_error: lock(&self.ctx.last_error).clone(),
            daemon_pid: std::process::id(),
            daemon_version: proto::VERSION.to_string(),
            uptime_s: self.ctx.started.elapsed().as_secs(),
        }
    }

    async fn live_sessions(&self) -> Vec<SessionInfo> {
        let q = Query::Sessions {
            agent: None,
            machine: None,
            text: None,
            limit: Some(200),
        };
        let Ok(Ok(v)) = tokio::time::timeout(LIVE_QUERY_TIMEOUT, self.ctx.hub.query(q)).await
        else {
            return Vec::new();
        };
        match serde_json::from_value::<Vec<SessionInfo>>(v) {
            Ok(mut s) => {
                s.retain(|s| s.live);
                self.logsync.localize(&mut s);
                s
            }
            Err(e) => {
                debug!("bad sessions result: {e}");
                Vec::new()
            }
        }
    }

    /// The hub's head may be ahead of what this connection has seen (other machines' pushes).
    async fn hub_head(&self) -> u64 {
        match tokio::time::timeout(HUB_QUERY_TIMEOUT, self.ctx.hub.query(Query::Status)).await {
            Ok(Ok(v)) => serde_json::from_value::<HubStatus>(v)
                .map(|s| s.head_seq)
                .unwrap_or_else(|_| self.ctx.hub.head_seq()),
            _ => self.ctx.hub.head_seq(),
        }
    }

    async fn sync(&self, timeout_ms: u64) -> Result<SyncReport, CtlError> {
        let timeout = Duration::from_millis(timeout_ms.max(1000));
        let deadline = Instant::now() + timeout;
        if !self.ctx.hub.is_connected() && !self.ctx.hub.wait_connected(timeout).await {
            return Err(self.offline_error());
        }
        self.rescan_all().await;
        loop {
            let head = self.hub_head().await;
            let cursor = self.ctx.db.cursor().unwrap_or(0);
            let pending = self.pending();
            let done = sync_done(&pending, cursor, head);
            let timed_out = !done && Instant::now() >= deadline;
            if done || timed_out {
                return Ok(SyncReport {
                    ok: done,
                    timed_out,
                    pending_up: pending.up,
                    pending_down: pending.down,
                    conflicts: pending.conflicts,
                    head_seq: head,
                    cursor,
                });
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn query(&self, q: Query) -> Result<Value, CtlError> {
        let sessions = matches!(q, Query::Sessions { .. });
        let v = self.ctx.hub.query(q).await.map_err(|e| self.hub_error(e))?;
        if !sessions {
            return Ok(v);
        }
        let mut list: Vec<SessionInfo> = serde_json::from_value(v).map_err(|e| {
            CtlError::new("error", format!("unexpected sessions result from hub: {e}"))
        })?;
        self.logsync.localize(&mut list);
        to_json(&list)
    }

    async fn reload(&self) -> Result<Value, CtlError> {
        let _g = self.config_lock.lock().await;
        let new = Config::load(&self.ctx.paths.config())
            .map_err(|e| CtlError::new("invalid", format!("{e:#}")))?
            .ok_or_else(|| CtlError::new("not_found", "config.toml is missing"))?;
        let old = self.ctx.cfg();
        let restart_required = needs_restart(&old, &new);
        *self.ctx.cfg.write().unwrap_or_else(|e| e.into_inner()) = new;
        info!(restart_required, "config reloaded");
        Ok(json!({ "restart_required": restart_required }))
    }
}

impl CtlHandler for Daemon {
    fn handle(&self, cmd: Ctl) -> CtlFuture<'_> {
        Box::pin(self.dispatch(cmd))
    }
}

fn to_json<T: Serialize>(v: &T) -> Result<Value, CtlError> {
    serde_json::to_value(v)
        .map_err(|e| CtlError::new("internal", format!("serializing result: {e}")))
}

/// `uc sync` is done when nothing is pending and every hub change up to `head` was applied.
pub fn sync_done(p: &Pending, cursor: u64, head: u64) -> bool {
    p.idle() && cursor >= head
}

/// Settings the running hub connection / drivers were built from.
fn needs_restart(old: &Config, new: &Config) -> bool {
    old.hub != new.hub
        || old.remote_uc != new.remote_uc
        || old.token != new.token
        || old.machine_id != new.machine_id
        || old.machine_name != new.machine_name
        || old.agents != new.agents
}

/// Holds an exclusive flock on daemon.pid for the daemon's lifetime: one daemon per UC_HOME.
struct PidLock {
    _file: File,
    path: PathBuf,
}

impl PidLock {
    fn acquire(path: &Path) -> Result<PidLock> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        // a CLI probing `running_pid` holds the lock for microseconds: retry briefly
        let mut attempts = 0;
        // SAFETY: flock on a valid, owned fd.
        while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            attempts += 1;
            if attempts >= 5 {
                let mut other = String::new();
                let _ = file.read_to_string(&mut other);
                bail!(
                    "another uc daemon is already running (pid {})",
                    other.trim()
                );
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        writeln!(file, "{}", std::process::id())?;
        file.flush()?;
        Ok(PidLock {
            _file: file,
            path: path.to_path_buf(),
        })
    }
}

impl Drop for PidLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Pid of the running daemon, if one holds the pid lock (a stale pid file is ignored, so we
/// never signal an unrelated process that reused the pid).
pub fn running_pid(paths: &Paths) -> Option<u32> {
    let path = paths.daemon_pid();
    let mut file = OpenOptions::new().read(true).write(true).open(&path).ok()?;
    // SAFETY: flock on a valid, owned fd.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        // SAFETY: as above; nobody held it, so release our probe lock.
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
        return None;
    }
    let mut s = String::new();
    file.read_to_string(&mut s).ok()?;
    s.trim().parse().ok()
}

/// Ensure a daemon is running for `paths` (spawn `uc daemon run` detached if the socket is dead),
/// waiting up to 5s for the control socket.
pub fn ensure_running(paths: &Paths) -> Result<()> {
    let sock = paths.daemon_sock();
    if control::probe(&sock, Duration::from_secs(2)) {
        return Ok(());
    }
    paths
        .ensure()
        .with_context(|| format!("creating {}", paths.root.display()))?;
    let exe = std::env::current_exe().context("locating the uc executable")?;
    let log = open_log(&paths.daemon_log())?;
    let mut cmd = Command::new(&exe);
    cmd.args(["daemon", "run"])
        .env("UC_HOME", &paths.root)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: setsid is async-signal-safe; detaches the daemon from the CLI's terminal/session.
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
        .with_context(|| format!("starting '{} daemon run'", exe.display()))?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if control::probe(&sock, Duration::from_millis(500)) {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            // lost a start race against another CLI: keep waiting for the winner
            if running_pid(paths).is_none() {
                bail!(
                    "the uc daemon exited during startup ({status}):\n{}",
                    log_tail(&paths.daemon_log(), 6)
                );
            }
        }
        if Instant::now() >= deadline {
            bail!(
                "the uc daemon did not come up within {}s (log: {}):\n{}",
                START_TIMEOUT.as_secs(),
                paths.daemon_log().display(),
                log_tail(&paths.daemon_log(), 6)
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Stop the daemon: Shutdown over the socket, then SIGTERM/SIGKILL via the pid lock if needed.
/// Returns false if no daemon was running.
pub async fn stop(paths: &Paths) -> Result<bool> {
    let sock = paths.daemon_sock();
    let answered = control::probe(&sock, Duration::from_secs(1));
    let pid = running_pid(paths);
    if !answered && pid.is_none() {
        return Ok(false);
    }
    if answered {
        let _ = control::call_timeout(&sock, Ctl::Shutdown, Duration::from_secs(5)).await;
    }
    for signal in [None, Some(libc::SIGTERM), Some(libc::SIGKILL)] {
        if let (Some(sig), Some(pid)) = (signal, running_pid(paths)) {
            warn!("daemon still running; sending signal {sig} to pid {pid}");
            // SAFETY: plain kill(2); pid comes from the lock-holding daemon's pid file.
            unsafe { libc::kill(pid as libc::pid_t, sig) };
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if running_pid(paths).is_none() && !control::probe(&sock, Duration::from_millis(200)) {
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    bail!("the uc daemon did not stop")
}

fn open_log(path: &Path) -> Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path)
        .map(|m| m.len() > LOG_ROTATE_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))
}

/// Last `n` lines of a log file (for error messages).
pub fn log_tail(path: &Path, n: usize) -> String {
    let Ok(mut f) = File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(16 * 1024)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..]
        .iter()
        .map(|l| format!("  {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_done_needs_idle_and_caught_up() {
        let idle = Pending::default();
        assert!(sync_done(&idle, 10, 10));
        assert!(sync_done(&idle, 11, 10));
        assert!(!sync_done(&idle, 9, 10));
        let busy = Pending {
            up: 1,
            ..Default::default()
        };
        assert!(!sync_done(&busy, 10, 10));
    }

    #[test]
    fn restart_detection() {
        let a = Config::new_for_this_machine();
        let mut b = a.clone();
        assert!(!needs_restart(&a, &b));
        b.hub = "other".into();
        assert!(needs_restart(&a, &b));
    }

    #[test]
    fn pid_lock_is_exclusive_and_ignores_stale_files() {
        let tmp = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let paths = Paths::new(tmp.path().to_path_buf());
        std::fs::write(paths.daemon_pid(), "999999\n").unwrap();
        assert_eq!(running_pid(&paths), None, "stale pid file must be ignored");
        let lock = PidLock::acquire(&paths.daemon_pid()).unwrap();
        assert_eq!(running_pid(&paths), Some(std::process::id()));
        drop(lock);
        assert!(!paths.daemon_pid().exists());
    }

    #[test]
    fn reset_moves_sync_state_aside() {
        let tmp = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let paths = Paths::new(tmp.path().to_path_buf());
        assert!(reset_sync_state(&paths).unwrap().is_none());
        let db = paths.client_db();
        std::fs::write(&db, "db").unwrap();
        std::fs::write(format!("{}-wal", db.display()), "wal").unwrap();
        std::fs::write(hub_mismatch_marker(&paths), "x").unwrap();
        let backup = reset_sync_state(&paths).unwrap().unwrap();
        assert!(!db.exists());
        assert!(!PathBuf::from(format!("{}-wal", db.display())).exists());
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "db");
        assert_eq!(
            std::fs::read_to_string(format!("{}-wal", backup.display())).unwrap(),
            "wal"
        );
        assert!(!hub_mismatch_marker(&paths).exists());
    }

    #[test]
    fn log_tail_lines() {
        let tmp = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let p = tmp.path().join("d.log");
        std::fs::write(&p, "one\ntwo\n\nthree\n").unwrap();
        assert_eq!(log_tail(&p, 2), "  two\n  three");
        assert_eq!(log_tail(&tmp.path().join("missing"), 2), "");
    }
}
