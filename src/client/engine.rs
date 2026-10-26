//! Folder-space sync engine: level-triggered L/B/R reconciliation (DESIGN §5).
//! Owner: client-core agent.
//!
//! Watcher events, remote changes and rescans only mark paths dirty. `run()` reconciles dirty
//! paths one at a time (so a path is never handled concurrently), in §5.5 order, through the
//! pure `decide()` table. Every action re-checks the local file right before touching it.

use anyhow::{bail, Context, Result};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tracing::{debug, info, warn};

use super::apply;
use super::db::{Base, LocalFp, Row};
use super::hubconn::{Commit, HubError};
use super::scan::{self, Ignore, LocalKind, Stat};
use super::{Ctx, Pending};
use crate::paths;
use crate::proto::{Change, Entry, Kind, LogRecord, Msg, Op, Query, SpaceStatus};

/// A path changing for longer than this is pushed anyway, from a stable snapshot (§5.2).
const MAX_DIRTY: Duration = Duration::from_secs(5);
/// Paths reconciled at once (their hub requests pipeline over one connection).
const PARALLEL: usize = 48;
/// Marker file confirming a mass delete in a space (see `check_mass_delete`).
const ALLOW_DELETES: &str = ".uc-allow-deletes";
const TICK: Duration = Duration::from_millis(100);
const RETRY_MIN: Duration = Duration::from_millis(500);
const RETRY_MAX: Duration = Duration::from_secs(60);
const SNAPSHOT_TRIES: u32 = 5;
/// Each Conflict reply refreshes R; give up (and retry later) if it keeps moving.
const MAX_ROUNDS: usize = 4;
const STAGED_UP: &str = "up-";
const STAGED_DOWN: &str = "dl-";

/// Content identity of one side (L, or R/B projected).
#[derive(Debug, Clone, PartialEq)]
pub struct Content {
    pub kind: Kind,
    pub hash: String,
    pub exec: bool,
}

/// What reconciling one path must do (DESIGN §5.1 table).
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Nothing,
    /// local already equals R (or both are deleted): record R as the new base
    Adopt,
    /// push local content as a new version against `base`
    Push {
        base: Option<u64>,
    },
    /// push a local delete
    PushDelete {
        base: u64,
    },
    /// write R over an unchanged (or absent) local path
    Apply,
    /// remote delete of an unchanged local file: move it to trash
    ApplyDelete,
    /// both sides changed to different contents: local becomes a conflict copy, R wins
    Conflict,
}

/// The reconciliation table. `l` = local content (None = absent), `b` = last agreed state,
/// `r` = latest hub state. Pure: all I/O happens in the engine.
pub fn decide(l: Option<&Content>, b: Option<&Base>, r: Option<&Entry>) -> Action {
    let b_live = b.filter(|b| !b.deleted);
    let l_changed = match (l, b_live) {
        (None, None) => false,
        (Some(l), Some(b)) => !(l.kind == b.kind && l.hash == b.hash && l.exec == b.exec),
        _ => true,
    };
    let r_changed = match (r, b) {
        (None, _) => false,
        (Some(r), None) => !r.deleted,
        (Some(r), Some(b)) => r.version > b.version,
    };
    let same_as_r = |l: &Content, r: &Entry| !r.deleted && l.kind == r.kind && l.hash == r.hash;
    match (l_changed, r_changed, l, r) {
        (false, false, _, _) => Action::Nothing,
        (true, false, Some(_), _) => Action::Push {
            base: b.map(|b| b.version).or(r.map(|r| r.version)),
        },
        (true, false, None, _) => match b_live {
            Some(b) => Action::PushDelete { base: b.version },
            None => Action::Nothing,
        },
        (false, true, l, Some(r)) => match l {
            Some(_) if r.deleted => Action::ApplyDelete,
            None if r.deleted => Action::Adopt,
            Some(l) if same_as_r(l, r) && l.exec == r.exec => Action::Adopt,
            _ => Action::Apply,
        },
        // local delete vs remote change: the change wins
        (true, true, None, Some(r)) => {
            if r.deleted {
                Action::Adopt
            } else {
                Action::Apply
            }
        }
        // local change vs remote delete: the change wins, re-created on top of the tombstone
        (true, true, Some(_), Some(r)) if r.deleted => Action::Push {
            base: Some(r.version),
        },
        (true, true, Some(l), Some(r)) => {
            if same_as_r(l, r) {
                Action::Adopt
            } else {
                Action::Conflict
            }
        }
        (_, true, _, None) => Action::Nothing,
    }
}

/// §5.5 push/apply order: git objects, then everything else, then refs, then the index.
pub fn order_class(rel: &str) -> u8 {
    let parts: Vec<&str> = rel.split('/').collect();
    let Some(g) = parts.iter().position(|p| *p == ".git") else {
        return 1;
    };
    match &parts[g + 1..] {
        ["objects", ..] => 0,
        ["refs", ..] | ["packed-refs"] | ["HEAD"] => 2,
        ["index"] => 3,
        _ => 1,
    }
}

struct SpaceState {
    root: PathBuf,
    /// (respect_gitignore, always_include) the matcher was built with
    rules: (bool, Vec<String>),
    /// symlink-resolved root: FSEvents reports real paths (/private/tmp/..)
    real_root: Option<PathBuf>,
    ignore: Arc<Ignore>,
    case_insensitive: Option<bool>,
    collisions: BTreeSet<String>,
    /// the DB's bases were checked to belong to this root
    bound: bool,
}

struct Dirty {
    first: Instant,
    last: Instant,
    local: bool,
    remote: bool,
    gen: u64,
    attempts: u32,
    not_before: Option<Instant>,
}

#[derive(Default)]
struct State {
    spaces: HashMap<String, SpaceState>,
    dirty: HashMap<(String, String), Dirty>,
    /// (space, dir rel; "" = whole space) to rescan
    subtrees: BTreeSet<(String, String)>,
    conflicts: Vec<String>,
    gen: u64,
    debounce: Duration,
    /// spaces where most tracked files vanished at once: deletes are not pushed (§5.1)
    deletes_paused: HashSet<String>,
}

/// A stable local snapshot (§5.2): content identity + staged copy to upload from.
struct Snap {
    content: Content,
    size: u64,
    fp: LocalFp,
    staged: Option<Staged>,
    link_target: Option<String>,
}

/// Staged copy, removed when dropped.
struct Staged(PathBuf);

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

enum Step {
    Done,
    Again,
}

/// Directory listings (NFC names) for exact-name checks on case-insensitive filesystems,
/// reused within one batch.
type Listings = HashMap<PathBuf, Arc<HashSet<String>>>;

pub struct Engine {
    ctx: Arc<Ctx>,
    st: Mutex<State>,
    listings: Mutex<Listings>,
    wake: Notify,
}

/// Agent roots never synced as plain folders, even inside a synced home (§6 owns them).
fn agent_roots() -> Vec<PathBuf> {
    let env_or = |var: &str, dflt: &str| match std::env::var_os(var) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => paths::home().join(dflt),
    };
    vec![
        env_or("CLAUDE_CONFIG_DIR", ".claude"),
        env_or("CODEX_HOME", ".codex"),
    ]
}

impl Engine {
    pub fn new(ctx: Arc<Ctx>) -> Arc<Engine> {
        let e = Engine {
            ctx,
            st: Mutex::new(State::default()),
            listings: Mutex::new(HashMap::new()),
            wake: Notify::new(),
        };
        e.sync_spaces();
        e.clean_staging();
        Arc::new(e)
    }

    /// Staged copies left behind by a crash are garbage (only our own prefixes: logsync may
    /// share the directory).
    fn clean_staging(&self) {
        let Ok(rd) = std::fs::read_dir(self.ctx.paths.staging()) else {
            return;
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with(STAGED_UP) || name.starts_with(STAGED_DOWN) {
                let _ = std::fs::remove_file(ent.path());
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn listings(&self) -> MutexGuard<'_, Listings> {
        self.listings.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn make_space(&self, root: PathBuf) -> SpaceState {
        let cfg = self.ctx.cfg();
        let mut ignore =
            match Ignore::new(&root, cfg.sync.respect_gitignore, &cfg.sync.always_include) {
                Ok(i) => i,
                Err(e) => {
                    warn!("bad always_include patterns ({e:#}); ignoring them");
                    Ignore::new(&root, cfg.sync.respect_gitignore, &[])
                        .expect("built-in ignore globs are valid")
                }
            };
        ignore.exclude(&self.ctx.paths.root);
        for r in agent_roots() {
            ignore.exclude(&r);
        }
        SpaceState {
            rules: (cfg.sync.respect_gitignore, cfg.sync.always_include.clone()),
            real_root: std::fs::canonicalize(&root).ok().filter(|r| *r != root),
            root,
            ignore: Arc::new(ignore),
            case_insensitive: None,
            collisions: BTreeSet::new(),
            bound: false,
        }
    }

    /// Bring the in-memory space list in line with the config (folder spaces only).
    fn sync_spaces(&self) {
        let cfg = self.ctx.cfg();
        let want: HashMap<String, PathBuf> = cfg
            .spaces
            .iter()
            .filter(|s| !s.name.starts_with('@'))
            .map(|s| (s.name.clone(), s.local_path()))
            .collect();
        let rules = (cfg.sync.respect_gitignore, cfg.sync.always_include.clone());
        let mut st = self.lock();
        st.debounce = Duration::from_millis(cfg.sync.debounce_ms);
        st.spaces
            .retain(|name, sp| want.get(name) == Some(&sp.root) && sp.rules == rules);
        for (name, root) in want {
            if let std::collections::hash_map::Entry::Vacant(v) = st.spaces.entry(name) {
                v.insert(self.make_space(root));
            }
        }
        let names: HashSet<String> = st.spaces.keys().cloned().collect();
        st.dirty.retain(|(s, _), _| names.contains(s));
    }

    /// Space roots currently synced (for the watcher). Agent spaces ('@...') are not here.
    pub fn roots(&self) -> Vec<(String, PathBuf)> {
        let mut v: Vec<_> = self
            .lock()
            .spaces
            .iter()
            .map(|(n, s)| (n.clone(), s.root.clone()))
            .collect();
        v.sort();
        v
    }

    /// (space, rel) for a path inside a space; rel is "" for the root itself.
    fn locate_any(&self, abs: &Path) -> Option<(String, String)> {
        let st = self.lock();
        let mut best: Option<(usize, String, String)> = None;
        for (name, sp) in &st.spaces {
            for root in std::iter::once(&sp.root).chain(sp.real_root.iter()) {
                if !abs.starts_with(root) {
                    continue;
                }
                let depth = root.components().count();
                if best.as_ref().is_some_and(|b| b.0 >= depth) {
                    continue;
                }
                let rel = if abs == root.as_path() {
                    String::new()
                } else {
                    match paths::rel_canonical(root, abs) {
                        Some(r) => r,
                        None => continue,
                    }
                };
                best = Some((depth, name.clone(), rel));
            }
        }
        best.map(|(_, n, r)| (n, r))
    }

    /// Does this absolute path belong to a folder space? Returns (space, canonical rel).
    pub fn locate(&self, abs: &Path) -> Option<(String, String)> {
        self.locate_any(abs).filter(|(_, rel)| !rel.is_empty())
    }

    fn space_parts(&self, space: &str) -> Option<(PathBuf, Arc<Ignore>)> {
        self.lock()
            .spaces
            .get(space)
            .map(|s| (s.root.clone(), s.ignore.clone()))
    }

    fn mark(&self, space: &str, rel: &str, local: bool, ready_now: bool) {
        let now = Instant::now();
        let mut st = self.lock();
        let stamp = if ready_now {
            now.checked_sub(st.debounce).unwrap_or(now)
        } else {
            now
        };
        st.gen += 1;
        let gen = st.gen;
        let d = st
            .dirty
            .entry((space.to_string(), rel.to_string()))
            .or_insert(Dirty {
                first: stamp,
                last: stamp,
                local: false,
                remote: false,
                gen,
                attempts: 0,
                not_before: None,
            });
        d.gen = gen;
        if local {
            if !d.local {
                d.first = stamp;
            }
            d.local = true;
            d.last = stamp;
        } else {
            d.remote = true;
        }
        drop(st);
        self.wake.notify_one();
    }

    fn mark_subtree(&self, space: &str, rel: &str) {
        self.lock()
            .subtrees
            .insert((space.to_string(), rel.to_string()));
        self.wake.notify_one();
    }

    /// Mark local paths dirty (from the watcher). Debounced; never blocks long.
    pub async fn on_local(&self, abs: PathBuf) {
        let Some((space, rel)) = self.locate_any(&abs) else {
            return;
        };
        if rel.is_empty() {
            self.mark_subtree(&space, "");
            return;
        }
        let Some((root, ignore)) = self.space_parts(&space) else {
            return;
        };
        let local = paths::join_canonical(&root, &rel);
        if matches!(scan::stat(&local), Ok(Stat::Dir)) {
            if !ignore.is_ignored(&local, true) {
                self.mark_subtree(&space, &rel);
            }
            return;
        }
        if ignore.is_ignored(&local, false) {
            return;
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        if Ignore::is_rules_file(name) {
            let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            self.mark_subtree(&space, parent);
        }
        self.mark(&space, &rel, true, false);
    }

    /// Handle a replicated change for a folder space. MUST call ctx.db.record_remote(&change)
    /// before returning (cursor advances there); applying may be deferred.
    pub async fn on_remote(&self, change: Change) -> Result<()> {
        self.ctx.db.record_remote(&change)?;
        let e = &change.entry;
        if e.kind == Kind::Log || !matches!(change.op, Op::Put | Op::Delete) {
            return Ok(());
        }
        if !is_canonical(&e.path) {
            warn!(
                "ignoring remote change with a non-canonical path {:?}",
                e.path
            );
            return Ok(());
        }
        if !self.lock().spaces.contains_key(&e.space) {
            return Ok(());
        }
        if e.origin == self.ctx.machine.id {
            let base = self.ctx.db.get(&e.space, &e.path)?.and_then(|r| r.base);
            if base.is_some_and(|b| b.version >= e.version) {
                return Ok(());
            }
        }
        self.mark(&e.space, &e.path, false, true);
        Ok(())
    }

    /// Full rescan of all folder spaces + reconcile everything (startup, reconnect, every 5 min).
    pub async fn rescan(&self) -> Result<()> {
        self.sync_spaces();
        let names: Vec<String> = self.lock().spaces.keys().cloned().collect();
        let mut first_err = None;
        for name in names {
            if let Err(e) = self.rescan_space(&name, "").await {
                warn!("rescan {name}: {e:#}");
                self.ctx.set_error(format!("{name}: {e:#}"));
                first_err.get_or_insert(e);
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Scan `sub` ("" = whole space), compare with the DB and mark what differs.
    async fn rescan_space(&self, space: &str, sub: &str) -> Result<()> {
        let Some((root, ignore)) = self.space_parts(space) else {
            return Ok(());
        };
        if !root.is_dir() {
            bail!(
                "space folder {} is missing; not syncing it until it is back",
                root.display()
            );
        }
        self.bind_root(space, &root)?;
        self.ensure_case_probe(space, &root);
        let dir = if sub.is_empty() {
            root.clone()
        } else {
            paths::join_canonical(&root, sub)
        };
        if !sub.is_empty() && (ignore.is_ignored(&dir, true) || !dir.is_dir()) {
            // the directory is gone or ignored now: re-check what we track under it
            for r in self.ctx.db.rows_prefix(space, &format!("{sub}/"))? {
                self.mark(space, &r.path, true, true);
            }
            return Ok(());
        }
        let (r2, i2) = (root.clone(), ignore.clone());
        let scanned = tokio::task::spawn_blocking(move || scan::scan_dir(&r2, &dir, &i2))
            .await
            .context("scan task failed")??;
        let prefix = if sub.is_empty() {
            String::new()
        } else {
            format!("{sub}/")
        };
        let rows: HashMap<String, Row> = self
            .ctx
            .db
            .rows_prefix(space, &prefix)?
            .into_iter()
            .map(|r| (r.path.clone(), r))
            .collect();
        let mut seen = HashSet::new();
        let mut marks = Vec::new();
        for s in &scanned {
            seen.insert(s.rel.as_str());
            let unchanged = rows
                .get(&s.rel)
                .and_then(|r| r.base.as_ref())
                .is_some_and(|b| {
                    !b.deleted
                        && b.fp.as_ref().is_some_and(|fp| apply::same_fp(fp, &s.fp))
                        && b.kind == kind_of(&s.kind)
                });
            if !unchanged {
                marks.push(s.rel.clone());
            }
        }
        if sub.is_empty() {
            self.check_mass_delete(space, &root, &rows, &seen);
        }
        for (path, r) in &rows {
            let live_base = r.base.as_ref().is_some_and(|b| !b.deleted);
            let behind = is_behind(r);
            if behind || (live_base && !seen.contains(path.as_str())) {
                marks.push(path.clone());
            }
        }
        debug!(
            "rescan {space}/{sub}: {} files, {} to reconcile",
            scanned.len(),
            marks.len()
        );
        for m in marks {
            self.mark(space, &m, true, true);
        }
        Ok(())
    }

    /// An emptied, replaced or unmounted space folder looks like "everything was deleted". When
    /// most tracked files vanish at once, stop pushing deletes for that space so the other
    /// machines keep their copies, until the files come back or the user confirms with
    /// `<space>/.uc-allow-deletes`.
    fn check_mass_delete(
        &self,
        space: &str,
        root: &Path,
        rows: &HashMap<String, Row>,
        seen: &HashSet<&str>,
    ) {
        let live: Vec<&String> = rows
            .iter()
            .filter(|(_, r)| r.base.as_ref().is_some_and(|b| !b.deleted))
            .map(|(p, _)| p)
            .collect();
        let missing = live.iter().filter(|p| !seen.contains(p.as_str())).count();
        let allow = root.join(ALLOW_DELETES);
        let mass = live.len() >= 10 && missing * 2 > live.len();
        let mut st = self.lock();
        if mass && !allow.exists() {
            if st.deletes_paused.insert(space.to_string()) {
                let msg = format!(
                    "{missing} of {} files vanished from space '{space}' ({}) at once; not deleting them on \
                     your other machines. If you really deleted them: touch {}",
                    live.len(),
                    paths::tilde(root),
                    paths::tilde(&allow)
                );
                warn!("{msg}");
                drop(st);
                self.ctx.set_error(msg);
            }
        } else {
            if mass {
                let _ = std::fs::remove_file(&allow);
                info!("space {space}: mass delete confirmed with {ALLOW_DELETES}");
            }
            st.deletes_paused.remove(space);
        }
    }

    /// Bases describe files in one specific folder. If a space now points at another folder,
    /// its files would all read as deleted: forget the bases instead and re-join (adopt or
    /// conflict-copy, never delete).
    fn bind_root(&self, space: &str, root: &Path) -> Result<()> {
        if self.lock().spaces.get(space).is_some_and(|s| s.bound) {
            return Ok(());
        }
        let key = format!("root:{space}");
        let here = root.to_string_lossy().to_string();
        match self.ctx.db.kv_get(&key)? {
            Some(prev) if prev == here => {}
            Some(prev) => {
                warn!("space {space} moved from {prev} to {here}; re-joining without deleting anything");
                self.ctx.db.clear_bases(space)?;
                self.ctx.db.kv_set(&key, &here)?;
            }
            None => self.ctx.db.kv_set(&key, &here)?,
        }
        if let Some(s) = self.lock().spaces.get_mut(space) {
            s.bound = true;
        }
        Ok(())
    }

    fn ensure_case_probe(&self, space: &str, root: &Path) {
        if self
            .lock()
            .spaces
            .get(space)
            .is_some_and(|s| s.case_insensitive.is_some())
        {
            return;
        }
        let ci = match scan::probe_case_insensitive(root) {
            Ok(v) => v,
            Err(e) => {
                warn!("case probe failed for {}: {e:#}", root.display());
                cfg!(target_os = "macos")
            }
        };
        // the root may not have existed when the space was set up
        let real = std::fs::canonicalize(root).ok().filter(|r| r != root);
        if let Some(s) = self.lock().spaces.get_mut(space) {
            s.case_insensitive = Some(ci);
            s.real_root = real;
        }
    }

    /// Background loop: debounced pushes, retries, deferred applies. Runs until shutdown.
    pub async fn run(self: Arc<Self>) -> Result<()> {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = self.wake.notified() => {}
            }
            if !self.ctx.hub.is_connected() {
                continue;
            }
            self.listings().clear();
            let subs: Vec<(String, String)> = std::mem::take(&mut self.lock().subtrees)
                .into_iter()
                .collect();
            for (space, sub) in subs {
                if let Err(e) = self.rescan_space(&space, &sub).await {
                    warn!("rescan {space}/{sub}: {e:#}");
                }
            }
            let batch = self.ready();
            // refs/index wait while git objects of the same space are still in flight (§5.5)
            let mut objects_pending = self.spaces_with_unready_objects(&batch);
            // §5.5 order holds between classes (objects, tree, refs, index); paths within one
            // class are independent, so they run concurrently and their hub requests pipeline
            // over the one connection instead of paying a round trip each.
            let mut by_class: std::collections::BTreeMap<u8, Vec<(String, String, u64)>> =
                std::collections::BTreeMap::new();
            for item in batch {
                by_class.entry(order_class(&item.1)).or_default().push(item);
            }
            for (class, items) in by_class {
                if !self.ctx.hub.is_connected() {
                    break;
                }
                let mut queue = items.into_iter();
                let mut running = tokio::task::JoinSet::new();
                loop {
                    while running.len() < PARALLEL {
                        let Some((space, rel, gen)) = queue.next() else {
                            break;
                        };
                        if class >= 2 && objects_pending.contains(&space) {
                            continue;
                        }
                        let me = self.clone();
                        running.spawn(async move {
                            let res = me.reconcile(&space, &rel).await;
                            (space, rel, gen, res)
                        });
                    }
                    match running.join_next().await {
                        Some(Ok((space, rel, gen, res))) => {
                            if res.is_err() && class == 0 {
                                objects_pending.insert(space.clone());
                            }
                            self.finish(&space, &rel, gen, res);
                        }
                        Some(Err(e)) => warn!("sync task failed: {e}"),
                        None => break,
                    }
                }
            }
        }
    }

    fn spaces_with_unready_objects(&self, batch: &[(String, String, u64)]) -> HashSet<String> {
        let in_batch: HashSet<(&str, &str)> = batch
            .iter()
            .map(|(s, r, _)| (s.as_str(), r.as_str()))
            .collect();
        self.lock()
            .dirty
            .keys()
            .filter(|(s, r)| order_class(r) == 0 && !in_batch.contains(&(s.as_str(), r.as_str())))
            .map(|(s, _)| s.clone())
            .collect()
    }

    /// Dirty paths whose quiet period is over, in §5.5 order.
    fn ready(&self) -> Vec<(String, String, u64)> {
        let now = Instant::now();
        let st = self.lock();
        let debounce = st.debounce;
        let mut v: Vec<(u8, String, String, u64)> = st
            .dirty
            .iter()
            .filter(|(_, d)| d.not_before.map_or(true, |t| t <= now))
            .filter(|(_, d)| {
                !d.local
                    || now.duration_since(d.last) >= debounce
                    || now.duration_since(d.first) >= MAX_DIRTY
            })
            .map(|((s, r), d)| (order_class(r), s.clone(), r.clone(), d.gen))
            .collect();
        v.sort();
        v.into_iter().map(|(_, s, r, g)| (s, r, g)).collect()
    }

    fn finish(&self, space: &str, rel: &str, gen: u64, res: Result<()>) {
        let mut st = self.lock();
        let key = (space.to_string(), rel.to_string());
        match res {
            Ok(()) => {
                if st.dirty.get(&key).is_some_and(|d| d.gen == gen) {
                    st.dirty.remove(&key);
                } else if let Some(d) = st.dirty.get_mut(&key) {
                    d.first = d.last;
                    d.attempts = 0;
                    d.not_before = None;
                }
            }
            Err(e) => {
                warn!("{space}/{rel}: {e:#}");
                drop(st);
                self.ctx.set_error(format!("{space}/{rel}: {e:#}"));
                let mut st = self.lock();
                if let Some(d) = st.dirty.get_mut(&key) {
                    d.attempts += 1;
                    let backoff = RETRY_MIN
                        .saturating_mul(1u32 << d.attempts.min(10))
                        .min(RETRY_MAX);
                    d.not_before = Some(Instant::now() + backoff);
                }
            }
        }
    }

    async fn reconcile(&self, space: &str, rel: &str) -> Result<()> {
        for _ in 0..MAX_ROUNDS {
            if let Step::Done = self.reconcile_once(space, rel).await? {
                return Ok(());
            }
        }
        bail!("still changing on both sides after {MAX_ROUNDS} rounds; will retry")
    }

    async fn reconcile_once(&self, space: &str, rel: &str) -> Result<Step> {
        let Some((root, ignore)) = self.space_parts(space) else {
            return Ok(Step::Done);
        };
        if !root.is_dir() {
            bail!("space folder {} is missing", root.display());
        }
        if !is_canonical(rel) {
            return Ok(Step::Done);
        }
        self.bind_root(space, &root)?;
        self.ensure_case_probe(space, &root);
        let abs = match paths::safe_join(&root, rel) {
            Ok(a) => a,
            Err(e) => {
                warn!("{space}/{rel}: {e:#}");
                return Ok(Step::Done);
            }
        };
        if ignore.is_ignored(&abs, false) {
            return Ok(Step::Done);
        }
        let row = self.ctx.db.get(space, rel)?.unwrap_or_default();
        let r = row.remote.clone();
        let mut b = row.base.clone();
        if r.as_ref().is_some_and(|r| r.kind == Kind::Log) {
            return Ok(Step::Done);
        }
        let mut local = match scan::stat(&abs).with_context(|| format!("stat {}", abs.display()))? {
            Stat::Special => return Ok(Step::Done),
            Stat::Missing | Stat::Dir => None,
            Stat::Entry(kind, fp) => Some((kind, fp)),
        };
        self.forget_collision(space, rel);
        let case_clash = self.case_insensitive(space) && !self.exact_path_ok(&root, &abs)?;
        if case_clash && local.is_none() {
            // a parent folder exists here under another case: writing would land in it (§5.6)
            let remote_new = r
                .as_ref()
                .is_some_and(|r| !r.deleted && b.as_ref().map_or(true, |b| r.version > b.version));
            if remote_new {
                info!("{space}/{rel}: a folder on the way differs only in case; not applied");
                if let Some(s) = self.lock().spaces.get_mut(space) {
                    s.collisions.insert(rel.to_string());
                }
                return Ok(Step::Done);
            }
        }
        if local.is_some() && case_clash {
            // stat matched a file whose name differs only in case (§5.6)
            let remote_new = r
                .as_ref()
                .is_some_and(|r| !r.deleted && b.as_ref().map_or(true, |b| r.version > b.version));
            if remote_new {
                info!(
                    "{space}/{rel}: collides case-insensitively with an existing file; not applied"
                );
                if let Some(s) = self.lock().spaces.get_mut(space) {
                    s.collisions.insert(rel.to_string());
                }
                return Ok(Step::Done);
            }
            // renamed by case only: this exact path is gone, the new name is its own entry
            local = None;
        }
        if local.is_none() && row.base.is_none() && row.remote.is_none() {
            // a vanished directory: whatever we track below it needs a look
            for under in self.ctx.db.rows_prefix(space, &format!("{rel}/"))? {
                self.mark(space, &under.path, true, true);
            }
            return Ok(Step::Done);
        }

        // L: unchanged fingerprint means unchanged content; otherwise take a stable snapshot
        let mut snap = None;
        let l = match &local {
            None => None,
            Some((kind, fp)) => {
                let unchanged = b.as_ref().is_some_and(|b| {
                    !b.deleted
                        && b.kind == kind_of(kind)
                        && b.fp.as_ref().is_some_and(|f| apply::same_fp(f, fp))
                });
                if unchanged {
                    b.as_ref().map(|b| Content {
                        kind: b.kind,
                        hash: b.hash.clone(),
                        exec: b.exec,
                    })
                } else {
                    let s = self.snapshot(&abs, kind).await?;
                    let c = s.content.clone();
                    // touched but identical to B: just remember the new fingerprint
                    if let Some(base) = b.as_mut().filter(|b| {
                        !b.deleted && b.hash == c.hash && b.kind == c.kind && b.exec == c.exec
                    }) {
                        base.fp = Some(s.fp.clone());
                        self.ctx.db.set_base(space, rel, Some(base))?;
                    }
                    snap = Some(s);
                    Some(c)
                }
            }
        };
        let observed_fp = snap
            .as_ref()
            .map(|s| s.fp.clone())
            .or_else(|| local.as_ref().map(|(_, fp)| fp.clone()));

        let action = decide(l.as_ref(), b.as_ref(), r.as_ref());
        debug!("{space}/{rel}: {action:?}");
        match action {
            Action::Nothing => Ok(Step::Done),
            Action::Adopt => {
                let r = r.context("adopt without remote state")?;
                self.ctx
                    .db
                    .set_base(space, rel, Some(&Base::from_entry(&r, observed_fp)))?;
                self.forget_collision(space, rel);
                Ok(Step::Done)
            }
            Action::Push { base } => {
                let snap = snap.context("push without a snapshot")?;
                self.push(space, rel, base, snap).await
            }
            Action::PushDelete { base } => self.push_delete(space, rel, &abs, base).await,
            Action::Apply => {
                let r = r.context("apply without remote state")?;
                self.apply_remote(space, rel, &abs, &r, observed_fp.as_ref())
                    .await
            }
            Action::ApplyDelete => {
                let r = r.context("delete without remote state")?;
                let fp = observed_fp.context("delete without local state")?;
                if !apply::precondition_holds(&abs, Some(&fp))? {
                    return Ok(Step::Again);
                }
                let to = apply::move_to_trash(&self.ctx.paths.trash(), &abs)?;
                self.touched(&abs);
                info!("{space}/{rel}: deleted remotely, moved to {}", to.display());
                self.ctx
                    .db
                    .set_base(space, rel, Some(&Base::from_entry(&r, None)))?;
                prune_empty_dirs(&root, &abs);
                self.retry_collisions(space, rel);
                Ok(Step::Done)
            }
            Action::Conflict => {
                let copy =
                    apply::rename_to_conflict(&abs, &self.ctx.machine.name, paths::now_ms())?;
                self.touched(&abs);
                let shown = paths::tilde(&copy);
                warn!("conflict on {space}/{rel}: kept your version as {shown}");
                self.lock().conflicts.push(shown);
                if let Some(crel) = paths::rel_canonical(&root, &copy) {
                    self.mark(space, &crel, true, true);
                }
                Ok(Step::Again)
            }
        }
    }

    fn case_insensitive(&self, space: &str) -> bool {
        self.lock()
            .spaces
            .get(space)
            .and_then(|s| s.case_insensitive)
            .unwrap_or(false)
    }

    /// Is there a directory entry named exactly (NFC) like `abs`? A cached listing may be stale,
    /// so a miss is confirmed with a fresh one.
    fn exact_name_exists(&self, abs: &Path) -> Result<bool> {
        use unicode_normalization::UnicodeNormalization;
        let (Some(dir), Some(name)) = (abs.parent(), abs.file_name().and_then(|n| n.to_str()))
        else {
            return Ok(true);
        };
        let want: String = name.nfc().collect();
        if self.listings().get(dir).is_some_and(|l| l.contains(&want)) {
            return Ok(true);
        }
        let mut names = HashSet::new();
        for ent in std::fs::read_dir(dir).with_context(|| format!("listing {}", dir.display()))? {
            if let Some(n) = ent?.file_name().to_str() {
                names.insert(n.nfc().collect::<String>());
            }
        }
        let found = names.contains(&want);
        self.listings().insert(dir.to_path_buf(), Arc::new(names));
        Ok(found)
    }

    /// Every existing component of `abs` below `root` has exactly this name (NFC), not just a
    /// case-insensitive match (macOS). Missing components are fine: they will be created as named.
    fn exact_path_ok(&self, root: &Path, abs: &Path) -> Result<bool> {
        let Ok(rest) = abs.strip_prefix(root) else {
            return Ok(true);
        };
        let mut p = root.to_path_buf();
        for c in rest.components() {
            p.push(c);
            if !matches!(std::fs::symlink_metadata(&p), Ok(_)) {
                return Ok(true);
            }
            if !self.exact_name_exists(&p)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// We changed `abs`'s directory ourselves: cached listings of it are stale.
    fn touched(&self, abs: &Path) {
        if let Some(dir) = abs.parent() {
            self.listings().remove(dir);
        }
    }

    fn forget_collision(&self, space: &str, rel: &str) {
        if let Some(s) = self.lock().spaces.get_mut(space) {
            s.collisions.remove(rel);
        }
    }

    /// A path was freed: remote paths that collided with it by case may apply now.
    fn retry_collisions(&self, space: &str, rel: &str) {
        let lower = rel.to_lowercase();
        let hits: Vec<String> = self
            .lock()
            .spaces
            .get(space)
            .map(|s| {
                s.collisions
                    .iter()
                    .filter(|c| c.to_lowercase() == lower)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for h in hits {
            self.mark(space, &h, false, true);
        }
    }

    /// Stable read (§5.2): stat, copy to staging while hashing, stat again; retry if it moved.
    async fn snapshot(&self, abs: &Path, kind: &LocalKind) -> Result<Snap> {
        if let LocalKind::Symlink(target) = kind {
            let fp = scan::fingerprint(abs).context("symlink vanished")?.1;
            return Ok(Snap {
                content: Content {
                    kind: Kind::Symlink,
                    hash: crate::hash::hash_bytes(target.as_bytes()),
                    exec: false,
                },
                size: target.len() as u64,
                fp,
                staged: None,
                link_target: Some(target.clone()),
            });
        }
        let staging = self.ctx.paths.staging();
        std::fs::create_dir_all(&staging)
            .with_context(|| format!("creating {}", staging.display()))?;
        let mut delay = Duration::from_millis(100);
        for _ in 0..SNAPSHOT_TRIES {
            let (src, dir) = (abs.to_path_buf(), staging.clone());
            let res = tokio::task::spawn_blocking(move || stage_copy(&src, &dir))
                .await
                .context("snapshot task failed")??;
            if let Some(snap) = res {
                return Ok(snap);
            }
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
        bail!("{} keeps changing; will retry", abs.display())
    }

    async fn push(&self, space: &str, rel: &str, base: Option<u64>, snap: Snap) -> Result<Step> {
        let hub = &self.ctx.hub;
        match (&snap.staged, &snap.link_target) {
            (Some(staged), _) => hub.upload_file(&staged.0, &snap.content.hash).await?,
            (None, Some(t)) => hub.upload_bytes(t.as_bytes(), &snap.content.hash).await?,
            (None, None) => bail!("nothing to upload"),
        }
        let msg = Msg::Put {
            id: hub.next_id(),
            space: space.to_string(),
            path: rel.to_string(),
            base,
            kind: snap.content.kind,
            hash: snap.content.hash.clone(),
            size: snap.size,
            exec: snap.content.exec,
            mtime: snap.fp.mtime_ms(),
            meta: None,
        };
        match hub.commit(msg, Vec::new()).await? {
            Commit::Committed { entry, .. } => {
                self.ctx.db.set_remote(&entry)?;
                self.ctx
                    .db
                    .set_base(space, rel, Some(&Base::from_entry(&entry, Some(snap.fp))))?;
                debug!("{space}/{rel}: pushed v{}", entry.version);
                Ok(Step::Done)
            }
            Commit::Conflict { current, reason } => {
                debug!("{space}/{rel}: push refused ({reason}); re-deciding");
                if let Some(c) = current {
                    self.ctx.db.set_remote(&c)?;
                }
                Ok(Step::Again)
            }
            Commit::Busy { .. } => bail!("hub answered busy to a file put"),
        }
    }

    /// Is there still a file at exactly this path (case included)?
    fn present_exact(&self, space: &str, abs: &Path) -> Result<bool> {
        if !matches!(scan::stat(abs)?, Stat::Entry(..)) {
            return Ok(false);
        }
        if !self.case_insensitive(space) {
            return Ok(true);
        }
        self.touched(abs);
        match self.space_parts(space) {
            Some((root, _)) => self.exact_path_ok(&root, abs),
            None => self.exact_name_exists(abs),
        }
    }

    async fn push_delete(&self, space: &str, rel: &str, abs: &Path, base: u64) -> Result<Step> {
        if self.lock().deletes_paused.contains(space) {
            debug!("{space}/{rel}: delete held (mass delete guard)");
            return Ok(Step::Done);
        }
        if self.present_exact(space, abs)? {
            return Ok(Step::Again);
        }
        let hub = &self.ctx.hub;
        let msg = Msg::Delete {
            id: hub.next_id(),
            space: space.to_string(),
            path: rel.to_string(),
            base,
        };
        match hub.commit(msg, Vec::new()).await? {
            Commit::Committed { entry, .. } => {
                self.ctx.db.set_remote(&entry)?;
                self.ctx
                    .db
                    .set_base(space, rel, Some(&Base::from_entry(&entry, None)))?;
                self.retry_collisions(space, rel);
                Ok(Step::Done)
            }
            Commit::Conflict { current, .. } => {
                if let Some(c) = current {
                    self.ctx.db.set_remote(&c)?;
                }
                Ok(Step::Again)
            }
            Commit::Busy { .. } => bail!("hub answered busy to a delete"),
        }
    }

    async fn apply_remote(
        &self,
        space: &str,
        rel: &str,
        abs: &Path,
        r: &Entry,
        expect: Option<&LocalFp>,
    ) -> Result<Step> {
        let hub = &self.ctx.hub;
        // Like `git checkout`: a synced file gets the current time, never the origin's mtime,
        // or make/cargo would consider stale outputs fresh.
        let mtime = None;
        let placed = match r.kind {
            Kind::File => {
                let tmp = apply::temp_beside(abs)?;
                hub.download_blob(&r.hash, &tmp).await?;
                apply::atomic_replace(&tmp, abs, expect, r.exec, mtime)?
            }
            Kind::Symlink => {
                let staging = self.ctx.paths.staging();
                std::fs::create_dir_all(&staging)?;
                let tmp =
                    Staged(staging.join(format!("{STAGED_DOWN}{}", uuid::Uuid::new_v4().simple())));
                hub.download_blob(&r.hash, &tmp.0).await?;
                let target = String::from_utf8(std::fs::read(&tmp.0)?)
                    .context("symlink target is not UTF-8")?;
                std::fs::create_dir_all(abs.parent().context("no parent")?)?;
                apply::atomic_symlink(abs, &target, expect)?
            }
            Kind::Log => return Ok(Step::Done),
        };
        self.touched(abs);
        let Some(fp) = placed else {
            debug!("{space}/{rel}: changed locally while applying; re-deciding");
            return Ok(Step::Again);
        };
        self.ctx
            .db
            .set_base(space, rel, Some(&Base::from_entry(r, Some(fp))))?;
        self.forget_collision(space, rel);
        if let Some(name) = abs.file_name().and_then(|n| n.to_str()) {
            if Ignore::is_rules_file(name) {
                if let (Some(dir), Some((_, ignore))) = (abs.parent(), self.space_parts(space)) {
                    ignore.invalidate(dir);
                    let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                    self.mark_subtree(space, parent);
                }
            }
        }
        debug!("{space}/{rel}: applied v{}", r.version);
        Ok(Step::Done)
    }

    pub fn pending(&self) -> Pending {
        let (up, conflicts, spaces) = {
            let st = self.lock();
            let up = st.dirty.values().filter(|d| d.local).count() as u64;
            let spaces: Vec<(String, PathBuf, Arc<Ignore>, BTreeSet<String>)> = st
                .spaces
                .iter()
                .map(|(n, s)| {
                    (
                        n.clone(),
                        s.root.clone(),
                        s.ignore.clone(),
                        s.collisions.clone(),
                    )
                })
                .collect();
            (up, st.conflicts.clone(), spaces)
        };
        let mut down = 0;
        for (name, root, ignore, collisions) in spaces {
            down += self.behind_count(&name, &root, &ignore, &collisions);
        }
        Pending {
            up,
            down,
            conflicts,
        }
    }

    fn behind_count(
        &self,
        space: &str,
        root: &Path,
        ignore: &Ignore,
        collisions: &BTreeSet<String>,
    ) -> u64 {
        match self.ctx.db.rows_behind(Some(space)) {
            Ok(rows) => rows
                .iter()
                .filter(|r| !collisions.contains(&r.path))
                .filter(|r| r.remote.as_ref().is_some_and(|e| e.kind != Kind::Log))
                .filter(|r| !ignore.is_ignored(&paths::join_canonical(root, &r.path), false))
                .count() as u64,
            Err(e) => {
                warn!("pending down for {space}: {e:#}");
                0
            }
        }
    }

    pub fn space_status(&self) -> Vec<SpaceStatus> {
        let spaces: Vec<(String, PathBuf, Arc<Ignore>, BTreeSet<String>)> = self
            .lock()
            .spaces
            .iter()
            .map(|(n, s)| {
                (
                    n.clone(),
                    s.root.clone(),
                    s.ignore.clone(),
                    s.collisions.clone(),
                )
            })
            .collect();
        let mut out: Vec<SpaceStatus> = spaces
            .into_iter()
            .map(|(name, root, ignore, collisions)| {
                let pending_up = self
                    .lock()
                    .dirty
                    .iter()
                    .filter(|((s, _), d)| *s == name && d.local)
                    .count() as u64;
                SpaceStatus {
                    files: self.ctx.db.count_synced(&name).unwrap_or(0),
                    pending_up,
                    pending_down: self.behind_count(&name, &root, &ignore, &collisions),
                    case_collisions: collisions.into_iter().collect(),
                    path: root.to_string_lossy().to_string(),
                    name,
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Start syncing a folder (config already updated by caller). Creates the space on the hub
    /// if it does not exist (default_path = tilde form), then rescans it.
    pub async fn add_space(&self, name: &str, path: &Path) -> Result<SpaceStatus> {
        if name.is_empty() || name.starts_with('@') || name.contains('/') {
            bail!("invalid space name {name:?}");
        }
        let hub = &self.ctx.hub;
        if !hub.wait_connected(Duration::from_secs(10)).await {
            bail!("not connected to the hub");
        }
        let msg = Msg::SpaceCreate {
            id: hub.next_id(),
            name: name.to_string(),
            default_path: paths::tilde(path),
        };
        match hub.request(msg, Vec::new()).await {
            Ok(_) => {}
            Err(e)
                if e.downcast_ref::<HubError>()
                    .is_some_and(|h| h.code == "exists") => {}
            Err(e) => return Err(e).context("creating the space on the hub"),
        }
        std::fs::create_dir_all(path).with_context(|| format!("creating {}", path.display()))?;
        self.sync_spaces();
        let known = self.lock().spaces.get(name).is_some_and(|s| s.root == path);
        if !known {
            let sp = self.make_space(path.to_path_buf());
            self.lock().spaces.insert(name.to_string(), sp);
        }
        // learn R for every path first, so existing local files adopt or conflict, never duplicate
        let data = hub
            .query(Query::Entries {
                space: name.to_string(),
                prefix: None,
            })
            .await?;
        let entries: Vec<Entry> = serde_json::from_value(data).context("bad Entries result")?;
        for e in &entries {
            self.ctx.db.set_remote(e)?;
        }
        self.rescan_space(name, "").await?;
        info!(
            "syncing space {name} at {} ({} entries on the hub)",
            path.display(),
            entries.len()
        );
        Ok(self
            .space_status()
            .into_iter()
            .find(|s| s.name == name)
            .unwrap_or_default())
    }

    pub async fn remove_space(&self, name: &str) -> Result<()> {
        {
            let mut st = self.lock();
            st.spaces.remove(name);
            st.dirty.retain(|(s, _), _| s != name);
            st.subtrees.retain(|(s, _)| s != name);
        }
        self.ctx.db.forget_space(name)
    }

    /// Push the content `path` had at `seq` as a new change.
    pub async fn restore(&self, space: &str, path: &str, seq: u64) -> Result<()> {
        let hub = &self.ctx.hub;
        let hist: Vec<LogRecord> = serde_json::from_value(
            hub.query(Query::History {
                space: space.to_string(),
                path: path.to_string(),
                limit: None,
            })
            .await?,
        )
        .context("bad History result")?;
        let rec = hist
            .iter()
            .find(|r| r.seq == seq)
            .with_context(|| format!("{space}/{path} has no version at seq {seq}"))?;
        if rec.op != Op::Put || rec.kind == Kind::Log {
            bail!(
                "seq {seq} of {space}/{path} is not a file version (it was a {:?})",
                rec.op
            );
        }
        let cur: Option<Entry> = serde_json::from_value(
            hub.query(Query::Entry {
                space: space.to_string(),
                path: path.to_string(),
            })
            .await?,
        )
        .context("bad Entry result")?;
        if let Some(c) = &cur {
            self.ctx.db.set_remote(c)?;
        }
        let exec = cur
            .as_ref()
            .filter(|c| c.kind == rec.kind && !c.deleted)
            .is_some_and(|c| c.exec);
        let msg = Msg::Put {
            id: hub.next_id(),
            space: space.to_string(),
            path: path.to_string(),
            base: cur.as_ref().map(|c| c.version),
            kind: rec.kind,
            hash: rec.hash.clone(),
            size: rec.size,
            exec,
            mtime: paths::now_ms(),
            meta: None,
        };
        match hub.commit(msg, Vec::new()).await? {
            Commit::Committed { entry, .. } => {
                self.ctx.db.set_remote(&entry)?;
                self.mark(space, path, false, true);
                Ok(())
            }
            Commit::Conflict { .. } => bail!("{space}/{path} changed while restoring; try again"),
            Commit::Busy { .. } => bail!("hub answered busy to a restore"),
        }
    }
}

fn kind_of(k: &LocalKind) -> Kind {
    match k {
        LocalKind::File => Kind::File,
        LocalKind::Symlink(_) => Kind::Symlink,
    }
}

/// Only well-formed relative paths may ever be joined onto a space root.
fn is_canonical(rel: &str) -> bool {
    paths::canonical(rel).is_ok_and(|c| c == rel)
}

fn is_behind(r: &Row) -> bool {
    match (&r.remote, &r.base) {
        (None, _) => false,
        (Some(e), None) => !e.deleted,
        (Some(e), Some(b)) => e.version > b.version,
    }
}

/// Copy `src` into `staging` while hashing; None if the file moved under us (retry).
fn stage_copy(src: &Path, staging: &Path) -> Result<Option<Snap>> {
    let before = match scan::stat(src)? {
        Stat::Entry(LocalKind::File, fp) => fp,
        _ => bail!("{} is no longer a regular file", src.display()),
    };
    let staged = Staged(staging.join(format!("{STAGED_UP}{}", uuid::Uuid::new_v4().simple())));
    let mut f = std::fs::File::open(src).with_context(|| format!("opening {}", src.display()))?;
    let mut out = std::fs::File::create(&staged.0)
        .with_context(|| format!("creating {}", staged.0.display()))?;
    let mut h = blake3::Hasher::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        size += n as u64;
    }
    out.flush()?;
    let after = match scan::stat(src)? {
        Stat::Entry(LocalKind::File, fp) => fp,
        _ => return Ok(None),
    };
    if !apply::same_fp(&before, &after) || size != before.size {
        return Ok(None);
    }
    Ok(Some(Snap {
        content: Content {
            kind: Kind::File,
            hash: h.finalize().to_hex().to_string(),
            exec: before.exec,
        },
        size,
        fp: before,
        staged: Some(staged),
        link_target: None,
    }))
}

/// Remove directories left empty by a remote delete, up to (not including) the root.
fn prune_empty_dirs(root: &Path, abs: &Path) {
    let mut dir = abs.parent();
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

#[cfg(test)]
#[path = "engine_e2e.rs"]
mod e2e;

#[cfg(test)]
mod tests {
    use super::*;

    fn c(hash: &str) -> Content {
        Content {
            kind: Kind::File,
            hash: hash.into(),
            exec: false,
        }
    }
    fn base(v: u64, hash: &str, deleted: bool) -> Base {
        Base {
            version: v,
            kind: Kind::File,
            hash: hash.into(),
            size: 1,
            exec: false,
            deleted,
            fp: None,
            log: None,
        }
    }
    fn rem(v: u64, hash: &str, deleted: bool) -> Entry {
        let mut e = super::super::hubconn::testhub::file_entry("s", "p", hash, v);
        e.deleted = deleted;
        e
    }

    #[test]
    fn decide_table() {
        use Action::*;
        let cases: Vec<(&str, Option<Content>, Option<Base>, Option<Entry>, Action)> = vec![
            // nothing anywhere / everything agrees
            ("empty", None, None, None, Nothing),
            (
                "in sync",
                Some(c("a")),
                Some(base(3, "a", false)),
                Some(rem(3, "a", false)),
                Nothing,
            ),
            (
                "both deleted, agreed",
                None,
                Some(base(4, "", true)),
                Some(rem(4, "", true)),
                Nothing,
            ),
            (
                "remote tombstone never had",
                None,
                None,
                Some(rem(4, "", true)),
                Nothing,
            ),
            // local changes only
            (
                "new local file",
                Some(c("a")),
                None,
                None,
                Push { base: None },
            ),
            (
                "local edit",
                Some(c("b")),
                Some(base(3, "a", false)),
                Some(rem(3, "a", false)),
                Push { base: Some(3) },
            ),
            (
                "local exec flip",
                Some(Content {
                    exec: true,
                    ..c("a")
                }),
                Some(base(3, "a", false)),
                Some(rem(3, "a", false)),
                Push { base: Some(3) },
            ),
            (
                "local delete",
                None,
                Some(base(3, "a", false)),
                Some(rem(3, "a", false)),
                PushDelete { base: 3 },
            ),
            (
                "recreate after agreed delete",
                Some(c("a")),
                Some(base(4, "", true)),
                Some(rem(4, "", true)),
                Push { base: Some(4) },
            ),
            (
                "create over unseen tombstone",
                Some(c("a")),
                None,
                Some(rem(4, "", true)),
                Push { base: Some(4) },
            ),
            // remote changes only
            (
                "remote new file",
                None,
                None,
                Some(rem(5, "r", false)),
                Apply,
            ),
            (
                "remote edit",
                Some(c("a")),
                Some(base(3, "a", false)),
                Some(rem(5, "r", false)),
                Apply,
            ),
            (
                "remote delete",
                Some(c("a")),
                Some(base(3, "a", false)),
                Some(rem(5, "", true)),
                ApplyDelete,
            ),
            (
                "remote re-create after delete",
                None,
                Some(base(4, "", true)),
                Some(rem(6, "r", false)),
                Apply,
            ),
            (
                "remote new version same content",
                Some(c("a")),
                Some(base(3, "a", false)),
                Some(rem(5, "a", false)),
                Adopt,
            ),
            (
                "remote delete of deleted",
                None,
                Some(base(4, "", true)),
                Some(rem(6, "", true)),
                Adopt,
            ),
            // both changed
            (
                "same edit both sides",
                Some(c("x")),
                Some(base(3, "a", false)),
                Some(rem(5, "x", false)),
                Adopt,
            ),
            (
                "different edits",
                Some(c("x")),
                Some(base(3, "a", false)),
                Some(rem(5, "y", false)),
                Conflict,
            ),
            (
                "local delete vs remote edit",
                None,
                Some(base(3, "a", false)),
                Some(rem(5, "y", false)),
                Apply,
            ),
            (
                "local edit vs remote delete",
                Some(c("x")),
                Some(base(3, "a", false)),
                Some(rem(5, "", true)),
                Push { base: Some(5) },
            ),
            (
                "both deleted",
                None,
                Some(base(3, "a", false)),
                Some(rem(5, "", true)),
                Adopt,
            ),
            // first join of a non-empty folder
            (
                "join: same content",
                Some(c("a")),
                None,
                Some(rem(5, "a", false)),
                Adopt,
            ),
            (
                "join: different content",
                Some(c("b")),
                None,
                Some(rem(5, "a", false)),
                Conflict,
            ),
            // stale R (older than B) is not a remote change
            (
                "stale remote",
                Some(c("a")),
                Some(base(7, "a", false)),
                Some(rem(5, "z", false)),
                Nothing,
            ),
            (
                "kind change local",
                Some(Content {
                    kind: Kind::Symlink,
                    ..c("a")
                }),
                Some(base(3, "a", false)),
                Some(rem(3, "a", false)),
                Push { base: Some(3) },
            ),
        ];
        for (name, l, b, r, want) in cases {
            assert_eq!(
                decide(l.as_ref(), b.as_ref(), r.as_ref()),
                want,
                "case: {name}"
            );
        }
    }

    #[test]
    fn git_order() {
        let mut v = vec![
            "p/.git/index",
            "p/.git/refs/heads/main",
            "p/src/a.rs",
            "p/.git/HEAD",
            "p/.git/objects/ab/cd",
            "p/.git/packed-refs",
            "p/.git/config",
        ];
        v.sort_by_key(|r| (order_class(r), r.to_string()));
        assert_eq!(
            v,
            vec![
                "p/.git/objects/ab/cd",
                "p/.git/config",
                "p/src/a.rs",
                "p/.git/HEAD",
                "p/.git/packed-refs",
                "p/.git/refs/heads/main",
                "p/.git/index",
            ]
        );
    }
}
