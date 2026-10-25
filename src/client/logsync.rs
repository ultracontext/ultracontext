//! Agent-session replication: logs, ownership, forks, materialization, resume (DESIGN §6).
//! Owner: sessions agent.
//!
//! Level-triggered like the folder engine: watcher events and hub changes only mark logs
//! dirty; `tick` compares the local file with the sync point (B.log) and the hub entry (R)
//! and decides: push complete lines, append remote lines, rewrite, materialize, or fork.
//!
//! Invariants:
//! - a file an agent may be writing (live per driver, or recently touched by someone other
//!   than us) is never rewritten, replaced or appended to;
//! - the hub log is only extended by the owner (or after a claim); a rejected append forks
//!   the local lines into a new session instead of touching the canonical log;
//! - local deletes are never propagated: a vanished transcript only drops its materialization.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::db::{Base, LogPoint, Row};
use super::hubconn::Commit;
use super::{Ctx, Pending};
use crate::drivers::{AgentDriver, AgentFile, AgentFileKind};
use crate::hash;
use crate::pathmap::PathMap;
use crate::paths::now_ms;
use crate::proto::{Change, Entry, Kind, Msg, Query, ResumePlan, SessionInfo, SessionMeta};

#[path = "logsync_deps.rs"]
mod deps;
#[path = "logsync_fs.rs"]
mod lfs;
#[cfg(test)]
#[path = "logsync_mock.rs"]
mod mock;
#[cfg(test)]
#[path = "logsync_tests.rs"]
mod tests;

pub use deps::{BusyError, Deps, LogHub, LogStore, Tunables};

/// (space, canonical path)
type Key = (String, String);

/// Head/tail windows used for session metadata (same as Claude's own session listing).
const META_WINDOW: u64 = 64 * 1024;
const READ_CHUNK: u64 = 4 * 1024 * 1024;
/// Bytes of complete lines per Append (frames are capped at proto::MAX_FRAME).
const PUSH_CHUNK: usize = 4 * 1024 * 1024;
/// Largest Append payload that still fits a frame next to its JSON header and metadata.
const MAX_APPEND: usize = crate::proto::MAX_FRAME - 256 * 1024;
const FORKS_KV: &str = "logsync.forks";
const DAY_MS: i64 = 86_400_000;
/// Claude deletes transcripts whose mtime is older than cleanupPeriodDays (30) at startup.
const MIN_MTIME_AGE_MS: i64 = 20 * DAY_MS;

/// A local transcript that diverged from the hub (DESIGN §6.4): its lines now go to the fork
/// until it is cold, then it is moved to trash and both sessions are materialized from the hub.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ForkRec {
    space: String,
    old_id: String,
    new_id: String,
    old_canonical: String,
    fork_canonical: String,
    /// absolute path of the diverged local file
    original: String,
    at: i64,
}

#[derive(Default)]
struct State {
    /// local files changed since their last push attempt (path -> last event)
    dirty: HashMap<PathBuf, Instant>,
    /// hub entries to reconcile locally
    remote: BTreeSet<Key>,
    /// logs we claimed and have not appended to since
    claimed: HashSet<Key>,
    /// materialize even when not eager (resume)
    want: HashSet<Key>,
    /// (size, mtime_ns) right after our own writes, so they are not mistaken for agent activity
    written: HashMap<PathBuf, (u64, i128)>,
    /// diverged originals, keyed by absolute path (persisted in kv)
    forks: BTreeMap<String, ForkRec>,
    forks_loaded: bool,
    /// agent spaces whose hub entries were listed since startup
    listed: HashSet<String>,
    /// failing paths/logs: (next attempt, failures)
    retry: HashMap<String, (Instant, u32)>,
}

trait RetryDue {
    fn is_none_or_due(&self, now: Instant) -> bool;
}

impl RetryDue for Option<&(Instant, u32)> {
    fn is_none_or_due(&self, now: Instant) -> bool {
        self.map_or(true, |(at, _)| now >= *at)
    }
}

enum Step {
    Done,
    /// cannot proceed now (live agent, unsynced local lines, hub moved); retried every tick
    Deferred,
}

/// Where local lines come from.
struct Src<'a> {
    d: &'a Arc<dyn AgentDriver>,
    /// native path relative to the driver root
    rel: &'a str,
    abs: &'a Path,
    /// session id as written in the local file
    sid: &'a str,
    /// canonical path of the local file (before any fork rewrite)
    canonical: &'a str,
    transcript: bool,
}

/// Where they go on the hub.
struct Dst {
    space: String,
    canonical: String,
    /// (old id, new id) rewrite applied to every pushed line
    fork: Option<(String, String)>,
}

pub struct LogSync {
    deps: Deps,
    drivers: Vec<Arc<dyn AgentDriver>>,
    st: Mutex<State>,
    /// serializes everything that reads or writes logs (local or hub side)
    op: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
}

fn log_base(e: &Entry, p: LogPoint) -> Base {
    Base {
        version: e.version,
        kind: Kind::Log,
        hash: e.hash.clone(),
        size: e.size,
        exec: false,
        deleted: false,
        fp: None,
        log: Some(p),
    }
}

fn file_base(e: &Entry) -> Base {
    Base {
        version: e.version,
        kind: e.kind,
        hash: e.hash.clone(),
        size: e.size,
        exec: e.exec,
        deleted: false,
        fp: None,
        log: None,
    }
}

/// Session id of a canonical path: `sessions/<sid>.jsonl`, `sessions/<sid>/..`, `file-history/<sid>/..`.
fn sid_of(canonical: &str) -> Option<&str> {
    let rest = canonical
        .strip_prefix("sessions/")
        .or_else(|| canonical.strip_prefix("file-history/"))?;
    let end = rest.find('/').unwrap_or(rest.len());
    let sid = &rest[..end];
    Some(sid.strip_suffix(".jsonl").unwrap_or(sid)).filter(|s| !s.is_empty())
}

fn transcript_of(canonical: &str) -> Option<String> {
    sid_of(canonical).map(|s| format!("sessions/{s}.jsonl"))
}

fn is_transcript(canonical: &str) -> bool {
    transcript_of(canonical).as_deref() == Some(canonical)
}

/// Apply `f` to every line (without its '\n'); non-UTF-8 lines pass through untouched.
fn map_lines(data: &[u8], f: impl Fn(&str) -> String) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 16);
    for line in data.split_inclusive(|&b| b == b'\n') {
        let (body, nl) = match line.strip_suffix(b"\n") {
            Some(b) => (b, true),
            None => (line, false),
        };
        match std::str::from_utf8(body) {
            Ok(s) => out.extend_from_slice(f(s).as_bytes()),
            Err(_) => out.extend_from_slice(body),
        }
        if nl {
            out.push(b'\n');
        }
    }
    out
}

/// Line-aligned prefix of `data` (complete lines) to send in one Append: up to PUSH_CHUNK
/// bytes, or exactly one line when a single line is larger.
fn chunk_len(data: &[u8]) -> usize {
    let n = lfs::complete_len(&data[..data.len().min(PUSH_CHUNK)]);
    if n > 0 {
        return n;
    }
    data.iter()
        .position(|&c| c == b'\n')
        .map_or(data.len(), |i| i + 1)
}

/// Split complete canonical lines into Append-sized chunks.
fn chunks(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut off = 0;
    while off < data.len() {
        let n = chunk_len(&data[off..]);
        out.push(&data[off..off + n]);
        off += n;
    }
    out
}

fn is_not_found(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::NotFound
}

impl LogSync {
    pub fn new(ctx: Arc<Ctx>, drivers: Vec<Arc<dyn AgentDriver>>) -> Arc<LogSync> {
        let cfg_ctx = ctx.clone();
        let err_ctx = ctx.clone();
        let deps = Deps {
            hub: Arc::new(ctx.hub.clone()),
            store: Arc::new(deps::CtxStore(ctx.clone())),
            machine: ctx.machine.clone(),
            paths: ctx.paths.clone(),
            home: crate::paths::home(),
            cfg: Arc::new(move || cfg_ctx.cfg()),
            on_error: Some(Arc::new(move |e: String| err_ctx.set_error(e))),
            tun: Tunables::default(),
        };
        LogSync::with_deps(deps, drivers)
    }

    /// Construct from explicit dependencies (tests, alternative hubs).
    pub fn with_deps(deps: Deps, drivers: Vec<Arc<dyn AgentDriver>>) -> Arc<LogSync> {
        Arc::new(LogSync {
            deps,
            drivers,
            st: Mutex::new(State::default()),
            op: tokio::sync::Mutex::new(()),
            wake: tokio::sync::Notify::new(),
        })
    }

    /// Native roots to watch (e.g. ~/.claude, ~/.codex) that exist on this machine.
    pub fn roots(&self) -> Vec<PathBuf> {
        self.drivers
            .iter()
            .map(|d| d.root())
            .filter(|r| r.is_dir())
            .collect()
    }

    /// Is this absolute path under an agent root?
    pub fn owns(&self, abs: &Path) -> bool {
        self.drivers.iter().any(|d| abs.starts_with(d.root()))
    }

    /// A native file changed (from the watcher). Debounced (≈200ms for logs).
    pub async fn on_local(&self, abs: PathBuf) {
        if !self.owns(&abs) {
            return;
        }
        let classified = self
            .locate(&abs)
            .is_some_and(|(d, rel)| d.classify(&rel).is_some());
        if classified {
            self.st().dirty.insert(abs, Instant::now());
            self.wake.notify_one();
        }
    }

    /// Handle a replicated change for an agent space ('@claude', '@codex'). MUST call
    /// ctx.db.record_remote(&change) before returning. `bin` = inline append bytes (may be empty).
    pub async fn on_remote(&self, change: Change, bin: Vec<u8>) -> Result<()> {
        // inline bytes are not trusted on their own: every apply re-reads the hub range and
        // checks the tail fingerprint at our sync point, which also covers missed resets
        let _ = bin;
        self.deps.store.record_remote(&change)?;
        let e = &change.entry;
        if self.driver(&e.space).is_none() {
            return Ok(());
        }
        if e.origin == self.deps.machine.id {
            let base = self.deps.store.get(&e.space, &e.path)?.and_then(|r| r.base);
            if base.is_some_and(|b| b.version >= e.version) {
                return Ok(());
            }
        }
        self.st().remote.insert((e.space.clone(), e.path.clone()));
        self.wake.notify_one();
        Ok(())
    }

    /// Scan agent roots + reconcile (startup, reconnect, periodic).
    pub async fn rescan(&self) -> Result<()> {
        for d in self.drivers.clone() {
            // one listing per process is enough: afterwards the change stream keeps R current
            let listed = self.st().listed.contains(d.space());
            if !listed && self.deps.hub.is_connected() {
                let q = Query::Entries {
                    space: d.space().to_string(),
                    prefix: None,
                };
                match self.deps.hub.query(q).await {
                    Ok(v) => {
                        let entries: Vec<Entry> = serde_json::from_value(v).unwrap_or_default();
                        for e in &entries {
                            self.adopt_entry(e)?;
                        }
                        self.st().listed.insert(d.space().to_string());
                    }
                    Err(e) => tracing::debug!("listing {}: {e:#}", d.space()),
                }
            }
            let dd = d.clone();
            let files = tokio::task::spawn_blocking(move || walk(&dd))
                .await
                .context("scan task")?;
            let mut dirty = Vec::new();
            for (abs, _rel, af) in files {
                let row = self
                    .deps
                    .store
                    .get(d.space(), &af.canonical)?
                    .unwrap_or_default();
                let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
                let in_sync = match (&af.kind, row.base.as_ref()) {
                    (AgentFileKind::Log, Some(b)) => b
                        .log
                        .as_ref()
                        .is_some_and(|p| Path::new(&p.native) == abs && p.local_len == size),
                    (AgentFileKind::File, Some(b)) => b.size == size,
                    _ => false,
                };
                if !in_sync {
                    dirty.push(abs);
                }
            }
            let behind: Vec<Key> = self
                .deps
                .store
                .rows(d.space())?
                .into_iter()
                .filter(|r| {
                    r.remote.as_ref().is_some_and(|e| {
                        !e.deleted && r.base.as_ref().map_or(true, |b| b.version < e.version)
                    })
                })
                .map(|r| (r.space, r.path))
                .collect();
            let mut st = self.st();
            let past = self.due_now();
            for p in dirty {
                st.dirty.entry(p).or_insert(past);
            }
            st.remote.extend(behind);
        }
        self.wake.notify_one();
        Ok(())
    }

    /// Background loop (debounced pushes, deferred materialization, fork reconciliation).
    pub async fn run(self: Arc<Self>) -> Result<()> {
        loop {
            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
            if let Err(e) = self.tick(false).await {
                self.report(&e);
            }
        }
    }

    /// One reconciliation pass. `force` ignores the debounce (tests, `uc sync`).
    pub async fn tick(&self, force: bool) -> Result<()> {
        let _g = self.op.lock().await;
        self.load_forks();
        if !self.deps.hub.is_connected() {
            return Ok(());
        }
        let due: Vec<PathBuf> = {
            let mut st = self.st();
            let now = Instant::now();
            let due: Vec<PathBuf> = st
                .dirty
                .iter()
                .filter(|(p, t)| {
                    (force || now.duration_since(**t) >= self.deps.tun.debounce)
                        && st
                            .retry
                            .get(&p.to_string_lossy().to_string())
                            .is_none_or_due(now)
                })
                .map(|(p, _)| p.clone())
                .collect();
            for p in &due {
                st.dirty.remove(p);
            }
            due
        };
        for abs in due {
            let id = abs.to_string_lossy().to_string();
            match self.sync_local(&abs).await {
                Ok(()) => self.retry_ok(&id),
                Err(e) => {
                    tracing::warn!("session sync {}: {e:#}", abs.display());
                    self.report(&e);
                    self.retry_failed(&id);
                    self.st().dirty.insert(abs, Instant::now());
                }
            }
        }
        let keys: Vec<Key> = {
            let mut st = self.st();
            let now = Instant::now();
            let (due, later): (Vec<Key>, Vec<Key>) =
                std::mem::take(&mut st.remote).into_iter().partition(|k| {
                    st.retry
                        .get(&format!("{}/{}", k.0, k.1))
                        .is_none_or_due(now)
                });
            st.remote.extend(later);
            due
        };
        for key in keys {
            let id = format!("{}/{}", key.0, key.1);
            match self.reconcile_remote(&key).await {
                Ok(Step::Done) => self.retry_ok(&id),
                Ok(Step::Deferred) => {
                    self.retry_ok(&id);
                    self.st().remote.insert(key);
                }
                Err(e) => {
                    tracing::warn!("session apply {id}: {e:#}");
                    self.report(&e);
                    self.retry_failed(&id);
                    self.st().remote.insert(key);
                }
            }
        }
        self.finish_cold_forks().await;
        Ok(())
    }

    pub fn pending(&self) -> Pending {
        let (up, want) = {
            let st = self.st();
            (st.dirty.len() as u64, st.want.clone())
        };
        let mut down = 0;
        for d in &self.drivers {
            let Ok(rows) = self.deps.store.rows(d.space()) else {
                continue;
            };
            for row in rows {
                let Some(r) = &row.remote else { continue };
                if r.deleted || row.base.as_ref().is_some_and(|b| b.version >= r.version) {
                    continue;
                }
                let key = (row.space.clone(), row.path.clone());
                let materialized = row
                    .base
                    .as_ref()
                    .is_some_and(|b| b.log.is_some() || b.kind != Kind::Log);
                if materialized
                    || want.contains(&key)
                    || (is_transcript(&row.path) && self.eager(&key, r))
                {
                    down += 1;
                }
            }
        }
        Pending {
            up,
            down,
            conflicts: Vec::new(),
        }
    }

    /// Fill `local_cwd` / `local` for sessions listed by the hub.
    pub fn localize(&self, sessions: &mut [SessionInfo]) {
        let map = self.map();
        for s in sessions.iter_mut() {
            let Some(d) = self.driver(&s.space) else {
                continue;
            };
            s.local_cwd = s.meta.cwd.as_deref().map(|c| map.smudge(c));
            let base_native = self
                .deps
                .store
                .get(&s.space, &s.path)
                .ok()
                .flatten()
                .and_then(|r| r.base)
                .and_then(|b| b.log)
                .map(|p| PathBuf::from(p.native));
            s.local = base_native.is_some_and(|p| p.exists())
                || d.native_rel(&s.path, Some(&s.meta), &map)
                    .is_some_and(|r| crate::paths::join_canonical(&d.root(), &r).exists());
        }
    }

    /// Resolve `id` (exact or unique prefix; agent optional), materialize the transcript (+ sidecars)
    /// locally, claim ownership (Busy -> Err with code "busy" unless takeover/fork), and return
    /// how to launch it. With `fork`, create a forked session first and resume that.
    pub async fn resume(
        &self,
        agent: Option<&str>,
        id: &str,
        takeover: bool,
        fork: bool,
    ) -> Result<ResumePlan> {
        let info = self.resolve(agent, id).await?;
        let d = self.driver(&info.space).ok_or_else(|| {
            anyhow!(
                "{} sessions are not enabled on this machine",
                info.meta.agent
            )
        })?;
        let key = (info.space.clone(), info.path.clone());
        let deadline = Instant::now() + self.deps.tun.resume_timeout;
        if fork {
            return self.resume_as_fork(&d, &key, deadline).await;
        }
        self.want_session(&d, &key).await?;
        self.ensure_local(&key, deadline).await?;
        let claim = Msg::Claim {
            id: self.deps.hub.next_id(),
            space: key.0.clone(),
            path: key.1.clone(),
            force: takeover,
        };
        let took_over = match self.deps.hub.commit(claim, Vec::new()).await? {
            Commit::Committed { entry, .. } => {
                self.adopt_entry(&entry)?;
                self.st().claimed.insert(key.clone());
                info.live
                    && info
                        .owner
                        .as_deref()
                        .is_some_and(|o| o != self.deps.machine.id)
            }
            Commit::Busy {
                owner_name,
                idle_ms,
                ..
            } => {
                return Err(anyhow::Error::new(BusyError {
                    owner_name,
                    idle_ms,
                }));
            }
            Commit::Conflict { reason, .. } => {
                bail!("could not claim session {}: {reason}", info.meta.id)
            }
        };
        // the session's other logs (subagents) move with it; best effort
        let others: Vec<Key> = {
            let st = self.st();
            st.want
                .iter()
                .filter(|k| k.0 == key.0 && *k != &key && sid_of(&k.1) == sid_of(&key.1))
                .cloned()
                .collect()
        };
        for k in others {
            let msg = Msg::Claim {
                id: self.deps.hub.next_id(),
                space: k.0.clone(),
                path: k.1.clone(),
                force: takeover,
            };
            if let Ok(Commit::Committed { entry, .. }) = self.deps.hub.commit(msg, Vec::new()).await
            {
                self.adopt_entry(&entry)?;
                self.st().claimed.insert(k);
            }
        }
        // lines the previous owner appended before the claim landed
        self.refresh(&key).await?;
        self.ensure_local(&key, deadline).await?;
        self.plan(&d, &key, took_over, None)
    }

    // ---------------------------------------------------------------- helpers

    fn st(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn retry_ok(&self, id: &str) {
        let mut st = self.st();
        if !st.retry.is_empty() {
            st.retry.remove(id);
        }
    }

    /// Exponential backoff (1s .. 60s) for a path or log that keeps failing.
    fn retry_failed(&self, id: &str) {
        let mut st = self.st();
        let now = Instant::now();
        let e = st.retry.entry(id.to_string()).or_insert((now, 0));
        e.1 = e.1.saturating_add(1);
        e.0 = now + Duration::from_secs((1u64 << e.1.min(6)).min(60));
    }

    /// A dirty timestamp that is already past the debounce.
    fn due_now(&self) -> Instant {
        let now = Instant::now();
        now.checked_sub(self.deps.tun.debounce).unwrap_or(now)
    }

    fn report(&self, e: &anyhow::Error) {
        if let Some(f) = &self.deps.on_error {
            f(format!("sessions: {e:#}"));
        }
    }

    fn driver(&self, space: &str) -> Option<Arc<dyn AgentDriver>> {
        self.drivers.iter().find(|d| d.space() == space).cloned()
    }

    fn locate(&self, abs: &Path) -> Option<(Arc<dyn AgentDriver>, String)> {
        self.drivers
            .iter()
            .find_map(|d| crate::paths::rel_canonical(&d.root(), abs).map(|rel| (d.clone(), rel)))
    }

    fn map(&self) -> PathMap {
        let cfg = (self.deps.cfg)();
        let home = &self.deps.home;
        let spaces: Vec<(String, PathBuf)> = cfg
            .spaces
            .iter()
            .map(|s| {
                let p = match s.path.strip_prefix("~/") {
                    Some(rest) => home.join(rest),
                    None if s.path == "~" => home.clone(),
                    None => PathBuf::from(&s.path),
                };
                (s.name.clone(), p)
            })
            .collect();
        PathMap::new(home, &spaces)
    }

    /// Store R unless we already know a newer version.
    fn adopt_entry(&self, e: &Entry) -> Result<()> {
        let cur = self
            .deps
            .store
            .get(&e.space, &e.path)?
            .and_then(|r| r.remote);
        if cur.map_or(true, |c| c.version < e.version) {
            self.deps.store.set_remote(e)?;
        }
        Ok(())
    }

    fn set_base(&self, space: &str, path: &str, base: &Base) -> Result<()> {
        self.deps.store.set_base(space, path, Some(base))
    }

    fn load_forks(&self) {
        let mut st = self.st();
        if st.forks_loaded {
            return;
        }
        st.forks_loaded = true;
        match self.deps.store.kv_get(FORKS_KV) {
            Ok(Some(s)) => match serde_json::from_str(&s) {
                Ok(f) => st.forks = f,
                Err(e) => tracing::warn!("ignoring unreadable fork records: {e}"),
            },
            Ok(None) => {}
            Err(e) => tracing::warn!("reading fork records: {e:#}"),
        }
    }

    fn save_forks(&self) -> Result<()> {
        let s = serde_json::to_string(&self.st().forks)?;
        self.deps.store.kv_set(FORKS_KV, &s)
    }

    fn fork_of(&self, abs: &Path) -> Option<ForkRec> {
        self.st().forks.get(abs.to_string_lossy().as_ref()).cloned()
    }

    fn note_written(&self, p: &Path) {
        if let Some(fp) = lfs::fp(p) {
            self.st().written.insert(p.to_path_buf(), fp);
        }
    }

    /// Live per the agent's own registry/locks, or touched recently by someone other than us.
    fn is_live(&self, d: &Arc<dyn AgentDriver>, sid: &str, native: &Path) -> bool {
        let root = d.root();
        let registered = match d.name() {
            "claude" => crate::drivers::claude::is_live_in(&root, sid),
            "codex" => crate::drivers::codex::writer_locked(&root, sid),
            _ => false,
        };
        registered || self.touched_within(native, self.deps.tun.hot_ms)
    }

    fn touched_within(&self, p: &Path, window_ms: i64) -> bool {
        let Some(fp) = lfs::fp(p) else { return false };
        if self.st().written.get(p) == Some(&fp) {
            return false;
        }
        let age_ms = (now_ms() as i128) - fp.1 / 1_000_000;
        age_ms < window_ms as i128
    }

    /// Metadata of the session `key` belongs to (from the transcript's hub entry).
    fn session_meta(&self, key: &Key, r: &Entry) -> Option<SessionMeta> {
        if is_transcript(&key.1) {
            return r.meta.as_ref().and_then(SessionMeta::from_meta);
        }
        let t = transcript_of(&key.1)?;
        let row = self.deps.store.get(&key.0, &t).ok()??;
        row.remote?.meta.as_ref().and_then(SessionMeta::from_meta)
    }

    fn eager(&self, key: &Key, r: &Entry) -> bool {
        let days = (self.deps.cfg)().agents.eager_days as i64;
        let at = self
            .session_meta(key, r)
            .and_then(|m| m.updated_at)
            .unwrap_or(r.mtime);
        at >= now_ms() - days * DAY_MS
    }

    /// mtime for a materialized transcript: last activity, never old enough for Claude's cleanup.
    fn mtime_for(&self, meta: Option<&SessionMeta>, r: &Entry) -> i64 {
        let at = meta.and_then(|m| m.updated_at).unwrap_or(r.mtime);
        at.max(now_ms() - MIN_MTIME_AGE_MS)
    }

    async fn read_log_range(
        &self,
        space: &str,
        path: &str,
        start: u64,
        end: u64,
    ) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        let mut off = start;
        while off < end {
            let len = (end - off).min(READ_CHUNK);
            let chunk = self.deps.hub.read_log(space, path, off, len).await?;
            if chunk.is_empty() {
                bail!("hub returned no data for {space}/{path} at {off}");
            }
            off += chunk.len() as u64;
            out.extend_from_slice(&chunk);
        }
        out.truncate(end.saturating_sub(start) as usize);
        Ok(out)
    }

    async fn refresh(&self, key: &Key) -> Result<Entry> {
        let v = self
            .deps
            .hub
            .query(Query::Entry {
                space: key.0.clone(),
                path: key.1.clone(),
            })
            .await?;
        let e: Option<Entry> = serde_json::from_value(v).context("bad Entry query result")?;
        let e = e.ok_or_else(|| anyhow!("{}/{} is not on the hub", key.0, key.1))?;
        self.adopt_entry(&e)?;
        Ok(e)
    }

    fn clean_bytes(
        &self,
        d: &Arc<dyn AgentDriver>,
        data: &[u8],
        map: &PathMap,
        fork: Option<&(String, String)>,
    ) -> Vec<u8> {
        map_lines(data, |l| {
            let c = d.clean_line(l, map);
            match fork {
                Some((old, new)) => d.fork_line(&c, old, new),
                None => c,
            }
        })
    }

    fn smudge_bytes(&self, d: &Arc<dyn AgentDriver>, data: &[u8], map: &PathMap) -> Vec<u8> {
        map_lines(data, |l| d.smudge_line(l, map))
    }

    /// Transcript metadata for pushing local bytes `[0, end)`.
    fn meta_for(&self, src: &Src<'_>, dst: &Dst, end: u64, map: &PathMap) -> Option<SessionMeta> {
        if !src.transcript {
            return None;
        }
        let head = lfs::read_range(src.abs, 0, end.min(META_WINDOW)).ok()?;
        let tail = lfs::read_range(src.abs, end.saturating_sub(META_WINDOW), end).ok()?;
        let mut m = src.d.parse_meta(src.sid, &head, &tail, map)?;
        if src.d.name() == "codex" {
            m.native_rel = Some(src.rel.to_string());
        }
        if src.d.name() == "claude" {
            // where Claude keeps the file is the truth for its cwd: when the parsed cwd does not
            // match the project dir (relocation line scrolled out of the windows), pick the
            // cwd seen in the windows that does
            let dir = src
                .rel
                .strip_prefix("projects/")
                .and_then(|r| r.split('/').next());
            if let Some(dir) = dir {
                use crate::drivers::claude::{json_lines, slug};
                let matches = |c: &str| slug(&map.smudge(c)) == dir;
                if !m.cwd.as_deref().is_some_and(matches) {
                    let found = json_lines(&head)
                        .into_iter()
                        .chain(json_lines(&tail))
                        .flat_map(|v| {
                            ["relocatedCwd", "cwd"]
                                .into_iter()
                                .filter_map(|f| {
                                    v.get(f).and_then(|x| x.as_str()).map(str::to_string)
                                })
                                .collect::<Vec<_>>()
                        })
                        .find(|c| slug(c) == dir);
                    if let Some(c) = found {
                        m.cwd = Some(map.clean(&c));
                    }
                }
            }
        }
        if let Some((old, new)) = &dst.fork {
            m.id = new.clone();
            m.forked_from = Some(old.clone());
            m.native_rel = m.native_rel.map(|r| src.d.fork_line(&r, old, new));
        }
        Some(m)
    }

    // ---------------------------------------------------------------- local -> hub

    async fn sync_local(&self, abs: &Path) -> Result<()> {
        let Some((d, rel)) = self.locate(abs) else {
            return Ok(());
        };
        let Some(af) = d.classify(&rel) else {
            return Ok(());
        };
        match af.kind {
            AgentFileKind::File => self.push_file(&d, &af, abs).await,
            AgentFileKind::Log => self.push_log(&d, &rel, &af, abs).await,
        }
    }

    /// Write-once sidecars (tool results, file-history backups, ...): whole-file CAS put.
    /// They practically never conflict; when they do, the hub wins and the local copy is kept
    /// in trash by `apply_file`.
    async fn push_file(&self, d: &Arc<dyn AgentDriver>, af: &AgentFile, abs: &Path) -> Result<()> {
        let space = d.space();
        let key = (space.to_string(), af.canonical.clone());
        let row = self
            .deps
            .store
            .get(space, &af.canonical)?
            .unwrap_or_default();
        let abs2 = abs.to_path_buf();
        let data = match tokio::task::spawn_blocking(move || std::fs::read(&abs2))
            .await
            .context("read task")?
        {
            Ok(data) => data,
            Err(e) if is_not_found(&e) => return Ok(()),
            Err(e) => return Err(e).with_context(|| format!("read {}", abs.display())),
        };
        let h = hash::hash_bytes(&data);
        if row.base.as_ref().is_some_and(|b| b.hash == h && !b.deleted) {
            return Ok(());
        }
        let remote = row.remote.as_ref().filter(|r| !r.deleted);
        if let Some(r) = remote.filter(|r| r.hash == h) {
            return self.set_base(space, &af.canonical, &file_base(r));
        }
        if remote.is_some() && row.base.as_ref().map(|b| b.version) != remote.map(|r| r.version) {
            self.st().remote.insert(key);
            return Ok(());
        }
        self.deps.hub.upload_bytes(&data, &h).await?;
        let mtime = lfs::fp(abs).map_or(0, |f| (f.1 / 1_000_000) as i64);
        let msg = Msg::Put {
            id: self.deps.hub.next_id(),
            space: space.to_string(),
            path: af.canonical.clone(),
            base: row.base.as_ref().filter(|b| !b.deleted).map(|b| b.version),
            kind: Kind::File,
            hash: h,
            size: data.len() as u64,
            exec: false,
            mtime,
            meta: None,
        };
        match self.deps.hub.commit(msg, Vec::new()).await? {
            Commit::Committed { entry, .. } => {
                self.adopt_entry(&entry)?;
                self.set_base(space, &af.canonical, &file_base(&entry))
            }
            Commit::Conflict { current, .. } => {
                if let Some(cur) = current {
                    self.adopt_entry(&cur)?;
                }
                self.st().remote.insert(key);
                Ok(())
            }
            Commit::Busy { .. } => bail!("unexpected busy for {}", af.canonical),
        }
    }

    async fn apply_file(
        &self,
        d: &Arc<dyn AgentDriver>,
        key: &Key,
        r: &Entry,
        base: Option<&Base>,
    ) -> Result<Step> {
        if base.is_some_and(|b| b.version >= r.version) {
            return Ok(Step::Done);
        }
        let t = transcript_of(&key.1).unwrap_or_default();
        let t_local = self
            .deps
            .store
            .get(&key.0, &t)?
            .and_then(|row| row.base)
            .is_some_and(|b| b.log.is_some());
        if !t_local {
            // sidecars follow their transcript
            let wanted = self.st().want.contains(&(key.0.clone(), t));
            return Ok(if wanted || self.eager(key, r) {
                Step::Deferred
            } else {
                Step::Done
            });
        }
        let map = self.map();
        let meta = self.session_meta(key, r);
        let Some(native_rel) = d.native_rel(&key.1, meta.as_ref(), &map) else {
            return Ok(Step::Done);
        };
        let target = crate::paths::join_canonical(&d.root(), &native_rel);
        if let Ok((h, _)) = hash::hash_file(&target) {
            if h == r.hash {
                self.set_base(&key.0, &key.1, &file_base(r))?;
                return Ok(Step::Done);
            }
            if !base.is_some_and(|b| b.hash == h) {
                lfs::copy_to_trash(&self.deps.paths.trash(), &target)?;
            }
        }
        let tmp = lfs::temp_path_beside(&target)?;
        let res = async {
            self.deps.hub.download_blob(&r.hash, &tmp).await?;
            if hash::hash_file(&tmp)?.0 != r.hash {
                bail!("downloaded blob does not match {}", r.hash);
            }
            if r.mtime > 0 {
                lfs::set_mtime(&tmp, r.mtime)?;
            }
            std::fs::rename(&tmp, &target).with_context(|| format!("placing {}", target.display()))
        }
        .await;
        if res.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        res?;
        self.note_written(&target);
        self.set_base(&key.0, &key.1, &file_base(r))?;
        Ok(Step::Done)
    }

    async fn push_log(
        &self,
        d: &Arc<dyn AgentDriver>,
        rel: &str,
        af: &AgentFile,
        abs: &Path,
    ) -> Result<()> {
        let src = Src {
            d,
            rel,
            abs,
            sid: &af.session_id,
            canonical: &af.canonical,
            transcript: af.transcript,
        };
        let dst = match self.fork_of(abs) {
            Some(fr) => Dst {
                space: fr.space,
                canonical: fr.fork_canonical,
                fork: Some((fr.old_id, fr.new_id)),
            },
            None => Dst {
                space: d.space().to_string(),
                canonical: af.canonical.clone(),
                fork: None,
            },
        };
        self.push_to(&src, &dst).await
    }

    async fn push_to(&self, src: &Src<'_>, dst: &Dst) -> Result<()> {
        let len = match std::fs::metadata(src.abs) {
            Ok(m) => m.len(),
            Err(e) if is_not_found(&e) => return Ok(()),
            Err(e) => return Err(e).with_context(|| format!("stat {}", src.abs.display())),
        };
        let row = self
            .deps
            .store
            .get(&dst.space, &dst.canonical)?
            .unwrap_or_default();
        if let Some((b, p)) = row
            .base
            .as_ref()
            .and_then(|b| b.log.clone().map(|p| (b, p)))
        {
            let here = Path::new(&p.native) == src.abs;
            if !here && Path::new(&p.native).exists() {
                tracing::warn!(
                    "session {} exists twice on this machine ({} and {}); syncing only the first",
                    src.sid,
                    p.native,
                    src.abs.display()
                );
                return Ok(());
            }
            let intact = len >= p.local_len && lfs::tail_ok(src.abs, p.local_len, &p.local_tail);
            if intact {
                let p = LogPoint {
                    native: src.abs.to_string_lossy().to_string(),
                    ..p
                };
                if !here {
                    // the agent moved the transcript (e.g. Claude relocation): same content
                    tracing::info!("session {} moved to {}", src.sid, src.abs.display());
                    let mut b2 = b.clone();
                    b2.log = Some(p.clone());
                    self.set_base(&dst.space, &dst.canonical, &b2)?;
                }
                return self.append_new(src, dst, b, &p, len).await;
            }
            if here {
                return self.local_rewritten(src, dst, &row).await;
            }
        }
        self.adopt_or_fork(src, dst, row.remote.as_ref()).await
    }

    /// Push the complete lines past the sync point.
    async fn append_new(
        &self,
        src: &Src<'_>,
        dst: &Dst,
        b: &Base,
        p: &LogPoint,
        len: u64,
    ) -> Result<()> {
        if len <= p.local_len {
            return Ok(());
        }
        let new = lfs::read_range(src.abs, p.local_len, len)?;
        let total = lfs::complete_len(&new);
        if total == 0 {
            return Ok(()); // only a partial line so far
        }
        let map = self.map();
        let key = (dst.space.clone(), dst.canonical.clone());
        let (mut b, mut p) = (b.clone(), p.clone());
        let mut off = 0usize;
        // frames are capped (proto::MAX_FRAME): push big backlogs in line-aligned chunks
        while off < total {
            let n = chunk_len(&new[off..total]);
            let cleaned = self.clean_bytes(src.d, &new[off..off + n], &map, dst.fork.as_ref());
            if cleaned.len() > MAX_APPEND {
                bail!(
                    "a {} byte line in {} exceeds the hub frame size",
                    cleaned.len(),
                    src.abs.display()
                );
            }
            let end = p.local_len + n as u64;
            let meta = self.meta_for(src, dst, end, &map);
            let claim = self.st().claimed.contains(&key);
            let msg = Msg::Append {
                id: self.deps.hub.next_id(),
                space: dst.space.clone(),
                path: dst.canonical.clone(),
                offset: b.size,
                tail: (b.size > 0).then(|| b.hash.clone()),
                meta: meta.map(|m| m.to_meta()),
                claim,
            };
            match self.deps.hub.commit(msg, cleaned.clone()).await? {
                Commit::Committed { entry, .. } => {
                    self.adopt_entry(&entry)?;
                    let p2 = LogPoint {
                        local_len: end,
                        local_tail: hash::tail_fp_file(src.abs, end)?,
                        native: p.native.clone(),
                    };
                    b = log_base(&entry, p2.clone());
                    p = p2;
                    self.set_base(&dst.space, &dst.canonical, &b)?;
                    self.st().claimed.remove(&key);
                    off += n;
                }
                Commit::Conflict { current, reason } => {
                    return self
                        .append_rejected(src, dst, &b, &p, &cleaned, end, current, &reason)
                        .await;
                }
                Commit::Busy { .. } => {
                    tracing::warn!("session {} is owned by another machine; forking", src.sid);
                    return self.fork(src, dst, end).await;
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn append_rejected(
        &self,
        src: &Src<'_>,
        dst: &Dst,
        b: &Base,
        p: &LogPoint,
        cleaned: &[u8],
        end: u64,
        current: Option<Entry>,
        reason: &str,
    ) -> Result<()> {
        let Some(cur) = &current else {
            // the log is gone from the hub (hub state lost): publish our copy again
            tracing::warn!(
                "session log {} missing on the hub; re-publishing",
                dst.canonical
            );
            self.deps.store.set_base(&dst.space, &dst.canonical, None)?;
            self.st()
                .dirty
                .insert(src.abs.to_path_buf(), self.due_now());
            return Ok(());
        };
        self.adopt_entry(cur)?;
        // a lost response: our lines may already be on the hub
        let want_end = b.size + cleaned.len() as u64;
        if let Some(cur) = current
            .as_ref()
            .filter(|c| !c.deleted && c.size >= want_end)
        {
            let start = b.size.saturating_sub(hash::TAIL_WINDOW);
            let got = self
                .read_log_range(&dst.space, &dst.canonical, start, want_end)
                .await?;
            let split = (b.size - start) as usize;
            let prefix_ok =
                b.size == 0 || hash::tail_fp_parts(&got[..split.min(got.len())], b.size) == b.hash;
            if prefix_ok && got.len() == (want_end - start) as usize && got[split..] == *cleaned {
                let p2 = LogPoint {
                    local_len: end,
                    local_tail: hash::tail_fp_file(src.abs, end)?,
                    native: p.native.clone(),
                };
                let base = if cur.size == want_end {
                    log_base(cur, p2)
                } else {
                    let w = got.len().saturating_sub(hash::TAIL_WINDOW as usize);
                    Base {
                        version: 0,
                        hash: hash::tail_fp_parts(&got[w..], want_end),
                        size: want_end,
                        ..log_base(cur, p2)
                    }
                };
                self.set_base(&dst.space, &dst.canonical, &base)?;
                if base.version == 0 {
                    self.st()
                        .remote
                        .insert((dst.space.clone(), dst.canonical.clone()));
                }
                return Ok(());
            }
        }
        tracing::warn!(
            "session {} diverged from the hub ({reason}); continuing local lines as a fork",
            src.sid
        );
        self.fork(src, dst, end).await
    }

    /// The local prefix changed (file shrank or was rewritten).
    async fn local_rewritten(&self, src: &Src<'_>, dst: &Dst, row: &Row) -> Result<()> {
        let local = lfs::read_range(src.abs, 0, u64::MAX)?;
        let n = lfs::complete_len(&local);
        if n == 0 {
            tracing::warn!("{} was emptied locally; not propagating", src.abs.display());
            return Ok(());
        }
        let (Some(b), Some(r)) = (row.base.as_ref(), row.remote.as_ref()) else {
            return self.fork(src, dst, n as u64).await;
        };
        let owner = r.owner.as_deref() == Some(self.deps.machine.id.as_str());
        if owner && r.version == b.version {
            let map = self.map();
            let content = self.clean_bytes(src.d, &local[..n], &map, dst.fork.as_ref());
            let h = hash::hash_bytes(&content);
            self.deps.hub.upload_bytes(&content, &h).await?;
            let meta = self.meta_for(src, dst, n as u64, &map);
            let msg = Msg::LogReset {
                id: self.deps.hub.next_id(),
                space: dst.space.clone(),
                path: dst.canonical.clone(),
                base: Some(b.version),
                hash: h,
                size: content.len() as u64,
                meta: meta.map(|m| m.to_meta()),
            };
            if let Commit::Committed { entry, .. } = self.deps.hub.commit(msg, Vec::new()).await? {
                self.adopt_entry(&entry)?;
                let p = LogPoint {
                    local_len: n as u64,
                    local_tail: hash::tail_fp(&local[..n]),
                    native: src.abs.to_string_lossy().to_string(),
                };
                self.set_base(&dst.space, &dst.canonical, &log_base(&entry, p))?;
                tracing::info!("session {} rewritten locally; hub log reset", src.sid);
                return Ok(());
            }
        }
        if !owner && !r.deleted {
            // a follower copy that only lost lines (agent GC, tombstones) is stale, not a new
            // history: put the hub copy back once nobody writes it
            let map = self.map();
            let cleaned = self.clean_bytes(src.d, &local[..n], &map, dst.fork.as_ref());
            let hub = self
                .read_log_range(&dst.space, &dst.canonical, 0, r.size)
                .await?;
            let hub_lines: HashSet<&[u8]> = hub.split(|&c| c == b'\n').collect();
            if cleaned
                .split(|&c| c == b'\n')
                .all(|l| hub_lines.contains(l))
            {
                if hash::tail_fp(&hub) != r.hash
                    || self.is_live(src.d, src.sid, src.abs)
                    || self.touched_within(src.abs, self.deps.tun.cold_ms)
                {
                    return Ok(()); // retried on the next change or rescan
                }
                lfs::copy_to_trash(&self.deps.paths.trash(), src.abs)?;
                let restored = self.smudge_bytes(src.d, &hub, &map);
                let key = (dst.space.clone(), dst.canonical.clone());
                let meta = self.session_meta(&key, r);
                lfs::replace(src.abs, &restored, Some(self.mtime_for(meta.as_ref(), r)))?;
                self.note_written(src.abs);
                let p = LogPoint {
                    local_len: restored.len() as u64,
                    local_tail: hash::tail_fp(&restored),
                    native: src.abs.to_string_lossy().to_string(),
                };
                self.set_base(&dst.space, &dst.canonical, &log_base(r, p))?;
                tracing::info!(
                    "restored the hub copy of session {} over a pruned local copy",
                    src.sid
                );
                return Ok(());
            }
        }
        self.fork(src, dst, n as u64).await
    }

    /// No usable sync point: line-compare the local file with the hub log and adopt the common
    /// prefix, push what only we have, or fork when the histories differ.
    async fn adopt_or_fork(&self, src: &Src<'_>, dst: &Dst, remote: Option<&Entry>) -> Result<()> {
        let r = remote.filter(|r| !r.deleted);
        let hub = match r {
            Some(r) if r.size > 0 => {
                self.read_log_range(&dst.space, &dst.canonical, 0, r.size)
                    .await?
            }
            _ => Vec::new(),
        };
        if let Some(r) = r {
            if hash::tail_fp(&hub) != r.hash {
                bail!(
                    "hub log {} changed while reading; will retry",
                    dst.canonical
                );
            }
        }
        let abs = src.abs.to_path_buf();
        let local = tokio::task::spawn_blocking(move || lfs::read_range(&abs, 0, u64::MAX))
            .await
            .context("read task")??;
        let n = lfs::complete_len(&local);
        let map = self.map();
        let (mut hpos, mut lpos) = (0usize, 0usize);
        for line in local[..n].split_inclusive(|&b| b == b'\n') {
            let c = self.clean_bytes(src.d, line, &map, dst.fork.as_ref());
            if hub.len() - hpos >= c.len() && hub[hpos..hpos + c.len()] == c[..] {
                hpos += c.len();
                lpos += line.len();
            } else {
                break;
            }
        }
        let p = LogPoint {
            local_len: lpos as u64,
            local_tail: hash::tail_fp(&local[..lpos]),
            native: src.abs.to_string_lossy().to_string(),
        };
        let key = (dst.space.clone(), dst.canonical.clone());
        if hpos == hub.len() {
            // the hub has nothing we lack: adopt it, then push our extra lines
            let base = match r {
                Some(r) => log_base(r, p.clone()),
                None => Base {
                    version: 0,
                    kind: Kind::Log,
                    hash: hash::tail_fp(b""),
                    size: 0,
                    exec: false,
                    deleted: false,
                    fp: None,
                    log: Some(p.clone()),
                },
            };
            if r.is_some() {
                self.set_base(&dst.space, &dst.canonical, &base)?;
            }
            if lpos < n {
                return self
                    .append_new(src, dst, &base, &p, local.len() as u64)
                    .await;
            }
            return Ok(());
        }
        if lpos == n {
            // we are a strict prefix of the hub: agree on it and catch up from the hub
            let base = Base {
                version: 0,
                kind: Kind::Log,
                hash: hash::tail_fp(&hub[..hpos]),
                size: hpos as u64,
                exec: false,
                deleted: false,
                fp: None,
                log: Some(p),
            };
            self.set_base(&dst.space, &dst.canonical, &base)?;
            self.st().remote.insert(key);
            return Ok(());
        }
        tracing::warn!(
            "local copy of session {} differs from the hub; forking it",
            src.sid
        );
        self.fork(src, dst, n as u64).await
    }

    /// Divergence (DESIGN §6.4): push local bytes `[0, upto)` as a new session.
    async fn fork(&self, src: &Src<'_>, dst: &Dst, upto: u64) -> Result<()> {
        let d = src.d;
        let old = src.sid.to_string();
        let reuse = if dst.fork.is_none() {
            self.st()
                .forks
                .values()
                .find(|f| f.space == dst.space && f.old_id == old)
                .map(|f| f.new_id.clone())
        } else {
            None
        };
        let new = reuse.unwrap_or_else(|| d.new_session_id());
        let fork_canonical = d.fork_canonical(src.canonical, &old, &new);
        let map = self.map();
        let local = lfs::read_range(src.abs, 0, upto)?;
        let n = lfs::complete_len(&local);
        let rewrite = (old.clone(), new.clone());
        let content = self.clean_bytes(d, &local[..n], &map, Some(&rewrite));
        let fdst = Dst {
            space: dst.space.clone(),
            canonical: fork_canonical.clone(),
            fork: Some(rewrite),
        };
        let meta = self.meta_for(src, &fdst, n as u64, &map);
        let entry = self
            .create_log(&dst.space, &fork_canonical, &content, meta.as_ref())
            .await
            .with_context(|| format!("creating fork {new} of {old}"))?;
        let original = src.abs.to_string_lossy().to_string();
        let p = LogPoint {
            local_len: n as u64,
            local_tail: hash::tail_fp(&local[..n]),
            native: original.clone(),
        };
        self.set_base(&dst.space, &fork_canonical, &log_base(&entry, p))?;
        let rec = ForkRec {
            space: dst.space.clone(),
            old_id: old.clone(),
            new_id: new.clone(),
            old_canonical: src.canonical.to_string(),
            fork_canonical,
            original: original.clone(),
            at: now_ms(),
        };
        self.st().forks.insert(original, rec);
        self.save_forks()?;
        tracing::warn!("session {old} forked as {new} (forked_from = {old})");
        Ok(())
    }

    /// Publish a new log (complete canonical lines), chunked to fit frames.
    async fn create_log(
        &self,
        space: &str,
        path: &str,
        content: &[u8],
        meta: Option<&SessionMeta>,
    ) -> Result<Entry> {
        let mut last: Option<Entry> = None;
        for chunk in chunks(content) {
            if chunk.len() > MAX_APPEND {
                bail!("a {} byte line exceeds the hub frame size", chunk.len());
            }
            let msg = Msg::Append {
                id: self.deps.hub.next_id(),
                space: space.to_string(),
                path: path.to_string(),
                offset: last.as_ref().map_or(0, |e| e.size),
                tail: last.as_ref().map(|e| e.hash.clone()),
                meta: meta.map(SessionMeta::to_meta),
                claim: false,
            };
            match self.deps.hub.commit(msg, chunk.to_vec()).await? {
                Commit::Committed { entry, .. } => {
                    self.adopt_entry(&entry)?;
                    last = Some(entry);
                }
                Commit::Conflict { reason, .. } => bail!("{path} rejected by the hub: {reason}"),
                Commit::Busy { .. } => bail!("{path} rejected by the hub: busy"),
            }
        }
        last.ok_or_else(|| anyhow!("nothing to publish for {path}"))
    }

    /// A diverged original that went cold is replaced by the hub's versions of both sessions.
    async fn finish_cold_forks(&self) {
        let recs: Vec<ForkRec> = self.st().forks.values().cloned().collect();
        for fr in recs {
            if let Err(e) = self.finish_fork(&fr).await {
                tracing::warn!("finishing fork {}: {e:#}", fr.new_id);
            }
        }
    }

    async fn finish_fork(&self, fr: &ForkRec) -> Result<()> {
        let Some(d) = self.driver(&fr.space) else {
            return Ok(());
        };
        let abs = PathBuf::from(&fr.original);
        if let Some((size, _)) = lfs::fp(&abs) {
            if self.is_live(&d, &fr.old_id, &abs)
                || self.touched_within(&abs, self.deps.tun.cold_ms)
            {
                return Ok(());
            }
            if self.st().dirty.contains_key(&abs) {
                return Ok(());
            }
            let synced = self
                .deps
                .store
                .get(&fr.space, &fr.fork_canonical)?
                .and_then(|r| r.base)
                .and_then(|b| b.log)
                .filter(|p| p.native == fr.original)
                .map(|p| p.local_len);
            let tail = lfs::read_range(&abs, synced.unwrap_or(0), size)?;
            if synced.is_none() || lfs::complete_len(&tail) > 0 {
                // stray complete lines not in the fork yet: push them first
                self.st().dirty.insert(abs, self.due_now());
                return Ok(());
            }
            let moved = lfs::move_to_trash(&self.deps.paths.trash(), &abs)?;
            tracing::info!(
                "diverged copy of session {} kept at {}",
                fr.old_id,
                moved.display()
            );
        }
        {
            let mut st = self.st();
            st.forks.remove(&fr.original);
        }
        self.save_forks()?;
        for c in [&fr.old_canonical, &fr.fork_canonical] {
            if let Some(mut b) = self.deps.store.get(&fr.space, c)?.and_then(|r| r.base) {
                if b.log.as_ref().is_some_and(|p| p.native == fr.original) {
                    b.log = None;
                    self.set_base(&fr.space, c, &b)?;
                }
            }
            let key = (fr.space.clone(), c.clone());
            let mut st = self.st();
            st.want.insert(key.clone());
            st.remote.insert(key);
        }
        Ok(())
    }

    // ---------------------------------------------------------------- hub -> local

    async fn reconcile_remote(&self, key: &Key) -> Result<Step> {
        let Some(d) = self.driver(&key.0) else {
            return Ok(Step::Done);
        };
        let row = self.deps.store.get(&key.0, &key.1)?.unwrap_or_default();
        let Some(r) = row.remote.clone() else {
            return Ok(Step::Done);
        };
        if r.deleted {
            return Ok(Step::Done); // deletes are never applied to agent data
        }
        if r.kind != Kind::Log {
            return self.apply_file(&d, key, &r, row.base.as_ref()).await;
        }
        let want = self.st().want.contains(key);
        let sid = sid_of(&key.1).unwrap_or_default().to_string();
        let Some((b, p)) = row
            .base
            .as_ref()
            .and_then(|b| b.log.clone().map(|p| (b.clone(), p)))
        else {
            if !(want || self.eager(key, &r)) {
                return Ok(Step::Done);
            }
            return self.materialize(&d, key, &r).await;
        };
        if b.version >= r.version {
            return Ok(Step::Done);
        }
        if b.size == r.size && b.hash == r.hash {
            // only owner/metadata changed (claims): nothing to write
            let mut b2 = b.clone();
            b2.version = r.version;
            self.set_base(&key.0, &key.1, &b2)?;
            return Ok(Step::Done);
        }
        if self.st().forks.contains_key(&p.native) {
            return Ok(Step::Deferred); // diverged original: replaced once cold
        }
        let native = PathBuf::from(&p.native);
        let len = match std::fs::metadata(&native) {
            Ok(m) => m.len(),
            Err(e) if is_not_found(&e) => {
                // gone locally (agent cleanup, user): drop the materialization, never the session
                let mut b2 = b.clone();
                b2.log = None;
                self.set_base(&key.0, &key.1, &b2)?;
                if want || self.eager(key, &r) {
                    return self.materialize(&d, key, &r).await;
                }
                return Ok(Step::Done);
            }
            Err(e) => return Err(e).with_context(|| format!("stat {}", native.display())),
        };
        if self.is_live(&d, &sid, &native) {
            return Ok(Step::Deferred);
        }
        let intact = len >= p.local_len && lfs::tail_ok(&native, p.local_len, &p.local_tail);
        if intact && len > p.local_len {
            let extra = lfs::read_range(&native, p.local_len, len)?;
            if lfs::complete_len(&extra) == 0
                && !self.touched_within(&native, self.deps.tun.cold_ms)
            {
                // a torn line left by a dead writer: keep a copy, cut it, then append the hub's lines
                lfs::copy_to_trash(&self.deps.paths.trash(), &native)?;
                lfs::truncate(&native, p.local_len)?;
                tracing::info!("dropped a torn partial line from {}", native.display());
                return self.catch_up(&d, key, &r, &b, &p).await;
            }
        }
        if len != p.local_len || !intact {
            // local lines we have not pushed: push first (that may fork)
            self.st().dirty.entry(native).or_insert_with(Instant::now);
            return Ok(Step::Deferred);
        }
        let step = self.catch_up(&d, key, &r, &b, &p).await?;
        if matches!(step, Step::Done) && d.name() == "claude" && is_transcript(&key.1) {
            self.follow_relocation(&d, key, &r)?;
        }
        Ok(step)
    }

    /// The session moved to another cwd on its owner (Claude relocation): move our copy (and
    /// its sidecar dir) to the new project dir instead of leaving the id in two places.
    fn follow_relocation(&self, d: &Arc<dyn AgentDriver>, key: &Key, r: &Entry) -> Result<()> {
        let Some(b) = self
            .deps
            .store
            .get(&key.0, &key.1)?
            .and_then(|row| row.base)
        else {
            return Ok(());
        };
        let Some(p) = b.log.clone() else {
            return Ok(());
        };
        let meta = self.session_meta(key, r);
        let Some(rel) = d.native_rel(&key.1, meta.as_ref(), &self.map()) else {
            return Ok(());
        };
        let want = crate::paths::join_canonical(&d.root(), &rel);
        let cur = PathBuf::from(&p.native);
        if want == cur || want.exists() || !cur.exists() {
            return Ok(());
        }
        if let Some(dir) = want.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&cur, &want).with_context(|| format!("moving {}", cur.display()))?;
        let (side_old, side_new) = (cur.with_extension(""), want.with_extension(""));
        if side_old.is_dir() && !side_new.exists() {
            if let Err(e) = std::fs::rename(&side_old, &side_new) {
                tracing::warn!("moving {}: {e}", side_old.display());
            }
        }
        self.note_written(&want);
        let mut b2 = b;
        b2.log = Some(LogPoint {
            native: want.to_string_lossy().to_string(),
            ..p
        });
        self.set_base(&key.0, &key.1, &b2)?;
        tracing::info!("session {} relocated to {}", key.1, want.display());
        Ok(())
    }

    /// Append the hub's lines past our sync point to the local file.
    async fn catch_up(
        &self,
        d: &Arc<dyn AgentDriver>,
        key: &Key,
        r: &Entry,
        b: &Base,
        p: &LogPoint,
    ) -> Result<Step> {
        if r.size < b.size {
            return self.rewrite_local(d, key, r, p).await;
        }
        let start = b.size.saturating_sub(hash::TAIL_WINDOW);
        let got = self.read_log_range(&key.0, &key.1, start, r.size).await?;
        let split = (b.size - start) as usize;
        if got.len() < split || (b.size > 0 && hash::tail_fp_parts(&got[..split], b.size) != b.hash)
        {
            // the hub no longer extends our base: it was reset
            return self.rewrite_local(d, key, r, p).await;
        }
        let w = got.len().saturating_sub(hash::TAIL_WINDOW as usize);
        if hash::tail_fp_parts(&got[w..], r.size) != r.hash {
            return Ok(Step::Deferred); // R is stale; the newer change is on its way
        }
        let new = &got[split..];
        if lfs::complete_len(new) != new.len() {
            bail!(
                "hub log {}/{} does not end with a complete line",
                key.0,
                key.1
            );
        }
        let native = PathBuf::from(&p.native);
        if new.is_empty() {
            self.set_base(&key.0, &key.1, &log_base(r, p.clone()))?;
            return Ok(Step::Done);
        }
        let local = self.smudge_bytes(d, new, &self.map());
        let sid = sid_of(&key.1).unwrap_or_default();
        if self.is_live(d, sid, &native) || lfs::fp(&native).map(|f| f.0) != Some(p.local_len) {
            return Ok(Step::Deferred);
        }
        lfs::append(&native, &local)?;
        let len2 = p.local_len + local.len() as u64;
        if lfs::fp(&native).map(|f| f.0) != Some(len2) {
            // an agent appended in the instant between our check and our write: the local
            // order is now mixed, so forget the sync point and let the line-by-line compare
            // decide (adopt or fork); the hub log is untouched either way
            tracing::warn!(
                "{} changed while applying hub lines; re-checking it",
                native.display()
            );
            let mut b2 = b.clone();
            b2.log = None;
            self.set_base(&key.0, &key.1, &b2)?;
            return Ok(Step::Deferred);
        }
        let meta = self.session_meta(key, r);
        lfs::set_mtime(&native, self.mtime_for(meta.as_ref(), r))?;
        self.note_written(&native);
        let p2 = LogPoint {
            local_len: len2,
            local_tail: hash::tail_fp_file(&native, len2)?,
            native: p.native.clone(),
        };
        self.set_base(&key.0, &key.1, &log_base(r, p2))?;
        Ok(Step::Done)
    }

    /// The hub log was reset: replace the (unchanged, cold) local copy, keeping the old one in trash.
    async fn rewrite_local(
        &self,
        d: &Arc<dyn AgentDriver>,
        key: &Key,
        r: &Entry,
        p: &LogPoint,
    ) -> Result<Step> {
        let data = self.read_log_range(&key.0, &key.1, 0, r.size).await?;
        if hash::tail_fp(&data) != r.hash {
            return Ok(Step::Deferred);
        }
        let local = self.smudge_bytes(d, &data, &self.map());
        let native = PathBuf::from(&p.native);
        let sid = sid_of(&key.1).unwrap_or_default();
        if self.is_live(d, sid, &native)
            || lfs::fp(&native).map(|f| f.0) != Some(p.local_len)
            || !lfs::tail_ok(&native, p.local_len, &p.local_tail)
        {
            return Ok(Step::Deferred);
        }
        lfs::copy_to_trash(&self.deps.paths.trash(), &native)?;
        let meta = self.session_meta(key, r);
        lfs::replace(&native, &local, Some(self.mtime_for(meta.as_ref(), r)))?;
        self.note_written(&native);
        let p2 = LogPoint {
            local_len: local.len() as u64,
            local_tail: hash::tail_fp(&local),
            native: p.native.clone(),
        };
        self.set_base(&key.0, &key.1, &log_base(r, p2))?;
        tracing::info!(
            "session log {} was reset on the hub; local copy rewritten",
            key.1
        );
        Ok(Step::Done)
    }

    /// Write a session that has no local copy yet at the driver's native path.
    async fn materialize(&self, d: &Arc<dyn AgentDriver>, key: &Key, r: &Entry) -> Result<Step> {
        if !is_transcript(&key.1) {
            let t = transcript_of(&key.1).unwrap_or_default();
            let t_local = self
                .deps
                .store
                .get(&key.0, &t)?
                .and_then(|row| row.base)
                .is_some_and(|b| b.log.is_some());
            if !t_local {
                let wanted = self.st().want.contains(&(key.0.clone(), t));
                return Ok(if wanted || self.eager(key, r) {
                    Step::Deferred
                } else {
                    Step::Done
                });
            }
        }
        let map = self.map();
        let meta = self.session_meta(key, r);
        let Some(mut native_rel) = d.native_rel(&key.1, meta.as_ref(), &map) else {
            tracing::debug!("cannot place {}/{} on this machine (no cwd)", key.0, key.1);
            return Ok(Step::Done);
        };
        // `claude --resume <id>` refuses ids found in two project dirs: reuse a local copy that
        // already lives in another one (relocation follows once it is in sync)
        if d.name() == "claude" && is_transcript(&key.1) {
            if let Some(existing) = claude_copy_elsewhere(&d.root(), &native_rel) {
                native_rel = existing;
            }
        }
        let target = crate::paths::join_canonical(&d.root(), &native_rel);
        if self.fork_of(&target).is_some() {
            return Ok(Step::Deferred); // a diverged local copy sits there until it is cold
        }
        if target.exists() {
            let Some(af) = d.classify(&native_rel) else {
                return Ok(Step::Done);
            };
            let src = Src {
                d,
                rel: &native_rel,
                abs: &target,
                sid: &af.session_id,
                canonical: &af.canonical,
                transcript: af.transcript,
            };
            let dst = Dst {
                space: key.0.clone(),
                canonical: key.1.clone(),
                fork: None,
            };
            if self.is_live(d, &af.session_id, &target) {
                return Ok(Step::Deferred);
            }
            self.adopt_or_fork(&src, &dst, Some(r)).await?;
            return Ok(Step::Done);
        }
        let data = self.read_log_range(&key.0, &key.1, 0, r.size).await?;
        if hash::tail_fp(&data) != r.hash {
            return Ok(Step::Deferred);
        }
        if lfs::complete_len(&data) != data.len() {
            bail!(
                "hub log {}/{} does not end with a complete line",
                key.0,
                key.1
            );
        }
        let local = self.smudge_bytes(d, &data, &map);
        let mtime = self.mtime_for(meta.as_ref(), r);
        let t2 = target.clone();
        let placed = tokio::task::spawn_blocking(move || {
            lfs::write_new(&t2, &local, Some(mtime)).map(|ok| (ok, local))
        })
        .await
        .context("write task")??;
        let (ok, local) = placed;
        if !ok {
            return Ok(Step::Deferred); // appeared meanwhile; compare next time
        }
        self.note_written(&target);
        let p = LogPoint {
            local_len: local.len() as u64,
            local_tail: hash::tail_fp(&local),
            native: target.to_string_lossy().to_string(),
        };
        self.set_base(&key.0, &key.1, &log_base(r, p))?;
        tracing::info!("materialized {}/{} at {}", key.0, key.1, target.display());
        Ok(Step::Done)
    }

    // ---------------------------------------------------------------- resume

    async fn resolve(&self, agent: Option<&str>, id: &str) -> Result<SessionInfo> {
        let id = id.trim();
        if id.is_empty() {
            bail!("no session id given");
        }
        let q = Query::Sessions {
            agent: agent.map(str::to_string),
            machine: None,
            text: Some(id.to_string()),
            limit: Some(50),
        };
        let v = self.deps.hub.query(q).await?;
        let list: Vec<SessionInfo> =
            serde_json::from_value(v).context("bad Sessions query result")?;
        let list: Vec<SessionInfo> = list
            .into_iter()
            .filter(|s| {
                self.driver(&s.space).is_some() && agent.map_or(true, |a| s.meta.agent == a)
            })
            .collect();
        if let Some(s) = list.iter().find(|s| s.meta.id == id) {
            return Ok(s.clone());
        }
        let prefixed: Vec<&SessionInfo> =
            list.iter().filter(|s| s.meta.id.starts_with(id)).collect();
        let cands: Vec<&SessionInfo> = if prefixed.is_empty() {
            list.iter().collect()
        } else {
            prefixed
        };
        match cands.len() {
            0 => bail!("no session matches {id:?}"),
            1 => Ok(cands[0].clone()),
            n => {
                let lines: Vec<String> = cands
                    .iter()
                    .take(10)
                    .map(|s| {
                        let label = s
                            .meta
                            .title
                            .as_deref()
                            .or(s.meta.first_prompt.as_deref())
                            .unwrap_or("");
                        format!(
                            "  {} {} {}",
                            s.meta.agent,
                            s.meta.id,
                            crate::drivers::claude::clip(label, 60)
                        )
                    })
                    .collect();
                bail!(
                    "{id:?} matches {n} sessions; use a longer id:\n{}",
                    lines.join("\n")
                )
            }
        }
    }

    /// Learn the latest hub state of a session's logs and mark them wanted.
    async fn want_session(&self, d: &Arc<dyn AgentDriver>, key: &Key) -> Result<()> {
        self.refresh(key).await?;
        let mut keys = vec![key.clone()];
        if let Some(sid) = sid_of(&key.1) {
            let q = Query::Entries {
                space: key.0.clone(),
                prefix: Some(format!("sessions/{sid}/")),
            };
            if let Ok(v) = self.deps.hub.query(q).await {
                let entries: Vec<Entry> = serde_json::from_value(v).unwrap_or_default();
                for e in entries.iter().filter(|e| e.kind == Kind::Log) {
                    self.adopt_entry(e)?;
                    keys.push((e.space.clone(), e.path.clone()));
                }
            }
        }
        let _ = d;
        let mut st = self.st();
        for k in keys {
            st.want.insert(k.clone());
            st.remote.insert(k);
        }
        Ok(())
    }

    /// Bring the local transcript up to the hub entry known now.
    async fn ensure_local(&self, key: &Key, deadline: Instant) -> Result<()> {
        let mut idle_rounds = 0;
        loop {
            let row = self.deps.store.get(&key.0, &key.1)?.unwrap_or_default();
            let r = row
                .remote
                .ok_or_else(|| anyhow!("{} is not on the hub", key.1))?;
            if row
                .base
                .as_ref()
                .is_some_and(|b| b.log.is_some() && b.version >= r.version)
            {
                return Ok(());
            }
            let step = {
                let _g = self.op.lock().await;
                self.load_forks();
                self.reconcile_remote(key).await?
            };
            let row = self.deps.store.get(&key.0, &key.1)?.unwrap_or_default();
            if row
                .base
                .as_ref()
                .is_some_and(|b| b.log.is_some() && b.version >= r.version)
            {
                return Ok(());
            }
            if let Step::Done = step {
                idle_rounds += 1;
                if idle_rounds > 3 {
                    bail!(
                        "cannot place session {} on this machine (unknown working directory?)",
                        sid_of(&key.1).unwrap_or(&key.1)
                    );
                }
            }
            if Instant::now() > deadline {
                bail!(
                    "timed out bringing session {} up to date here; is it still running on this machine?",
                    sid_of(&key.1).unwrap_or(&key.1)
                );
            }
            // pending local lines (pushed by the tick) or a live local agent
            {
                let _g = self.op.lock().await;
                let dirty: Vec<PathBuf> = self.st().dirty.keys().cloned().collect();
                for abs in dirty {
                    self.st().dirty.remove(&abs);
                    if let Err(e) = self.sync_local(&abs).await {
                        tracing::debug!("push before resume: {e:#}");
                        self.st().dirty.insert(abs, Instant::now());
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn resume_as_fork(
        &self,
        d: &Arc<dyn AgentDriver>,
        key: &Key,
        deadline: Instant,
    ) -> Result<ResumePlan> {
        let r = self.refresh(key).await?;
        let old = sid_of(&key.1).unwrap_or_default().to_string();
        let data = self.read_log_range(&key.0, &key.1, 0, r.size).await?;
        let n = lfs::complete_len(&data);
        let new = d.new_session_id();
        let fork_canonical = d.fork_canonical(&key.1, &old, &new);
        let content = map_lines(&data[..n], |l| d.fork_line(l, &old, &new));
        let mut meta = r
            .meta
            .as_ref()
            .and_then(SessionMeta::from_meta)
            .unwrap_or_else(|| SessionMeta {
                agent: d.name().to_string(),
                ..Default::default()
            });
        meta.id = new.clone();
        meta.forked_from = Some(old.clone());
        meta.native_rel = meta.native_rel.map(|x| d.fork_line(&x, &old, &new));
        meta.updated_at = Some(now_ms());
        self.create_log(&key.0, &fork_canonical, &content, Some(&meta))
            .await
            .with_context(|| format!("creating fork of {old}"))?;
        let fkey = (key.0.clone(), fork_canonical);
        self.st().want.insert(fkey.clone());
        self.ensure_local(&fkey, deadline).await?;
        self.plan(d, &fkey, false, Some(new))
    }

    fn plan(
        &self,
        d: &Arc<dyn AgentDriver>,
        key: &Key,
        took_over: bool,
        forked_to: Option<String>,
    ) -> Result<ResumePlan> {
        let row = self.deps.store.get(&key.0, &key.1)?.unwrap_or_default();
        let r = row
            .remote
            .ok_or_else(|| anyhow!("{} is not on the hub", key.1))?;
        let mut meta = r
            .meta
            .as_ref()
            .and_then(SessionMeta::from_meta)
            .unwrap_or_default();
        if meta.id.is_empty() {
            meta.id = sid_of(&key.1).unwrap_or_default().to_string();
        }
        let map = self.map();
        let cwd = meta
            .cwd
            .as_deref()
            .map(|c| map.smudge(c))
            .unwrap_or_else(|| self.deps.home.to_string_lossy().to_string());
        let native_path = row
            .base
            .and_then(|b| b.log)
            .map(|p| p.native)
            .unwrap_or_default();
        Ok(ResumePlan {
            agent: d.name().to_string(),
            id: meta.id.clone(),
            argv: d.resume_argv(&meta, Path::new(&cwd)),
            cwd_missing: !Path::new(&cwd).is_dir(),
            cwd,
            native_path,
            took_over,
            forked_to,
        })
    }
}

/// `projects/<other slug>/<sid>.jsonl` when the transcript `rel` exists locally under another
/// project dir.
fn claude_copy_elsewhere(root: &Path, rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next()?;
    if root.join(rel).exists() {
        return None;
    }
    let rd = std::fs::read_dir(root.join("projects")).ok()?;
    rd.flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .find(|e| e.path().join(name).is_file())
        .map(|e| format!("projects/{}/{name}", e.file_name().to_string_lossy()))
}

/// Classified files under a driver root (only the subtrees sessions live in).
fn walk(d: &Arc<dyn AgentDriver>) -> Vec<(PathBuf, String, AgentFile)> {
    let root = d.root();
    let tops: &[&str] = match d.name() {
        "claude" => &["projects", "file-history"],
        "codex" => &["sessions"],
        _ => &[],
    };
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = tops.iter().map(|t| root.join(t)).collect();
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                if let Some(rel) = crate::paths::rel_canonical(&root, &p) {
                    if let Some(af) = d.classify(&rel) {
                        out.push((p, rel, af));
                    }
                }
            }
        }
    }
    out
}
