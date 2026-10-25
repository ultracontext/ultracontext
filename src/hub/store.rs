//! Hub persistence: hub.db (SQLite WAL), blobs/, logs/. Owner: hub agent.
//!
//! The hub wraps one `Store` in a mutex, so mutations are serialized. Every accepted mutation is
//! one SQLite transaction writing a `log` row (the next global seq) and the entry's new state
//! (DESIGN §3.3). Blobs are immutable content-addressed files. Each log lineage gets its own
//! append-only file named after its epoch (the seq that created or last reset it), so a reset or
//! a re-creation never touches bytes that older changes refer to, and a crash between the file
//! write and the DB commit never leaves the committed state pointing at foreign bytes.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::hash;
use crate::paths;
use crate::proto::{
    Change, Entry, HubStatus, Kind, LogRecord, MachineInfo, MachineRecord, Op, Query, SessionInfo,
    SessionMeta, SpaceInfo, CHUNK, INLINE_APPEND_MAX, VERSION,
};

const SCHEMA_VERSION: i64 = 1;

/// Inline append bytes carried by one `changes_after` batch (soft cap).
pub const BATCH_MAX_BYTES: usize = 8 * 1024 * 1024;

const SCHEMA: &str = "
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE machines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT NOT NULL, home TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE spaces (
    name TEXT PRIMARY KEY, default_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
);
CREATE TABLE entries (
    space TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
    hash TEXT NOT NULL, size INTEGER NOT NULL, exec INTEGER NOT NULL, mtime INTEGER NOT NULL,
    deleted INTEGER NOT NULL, origin TEXT NOT NULL, meta TEXT, owner TEXT,
    owner_at INTEGER NOT NULL, epoch INTEGER NOT NULL,
    PRIMARY KEY (space, path)
) WITHOUT ROWID;
CREATE TABLE log (
    seq INTEGER PRIMARY KEY, op TEXT NOT NULL, at INTEGER NOT NULL,
    space TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL,
    size INTEGER NOT NULL, exec INTEGER NOT NULL, mtime INTEGER NOT NULL,
    deleted INTEGER NOT NULL, origin TEXT NOT NULL, meta TEXT, owner TEXT,
    owner_at INTEGER NOT NULL, epoch INTEGER NOT NULL, off INTEGER, len INTEGER
);
CREATE INDEX log_path ON log (space, path, seq);
CREATE INDEX log_at ON log (at);
CREATE TABLE blobs (
    hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL
) WITHOUT ROWID;
";

const ENTRY_COLS: &str =
    "space, path, kind, version, hash, size, exec, mtime, deleted, origin, meta, owner, owner_at";
const LOG_COLS: &str = "seq, op, at, space, path, kind, hash, size, exec, mtime, deleted, origin, \
                        meta, owner, owner_at, epoch, off, len";

/// A request error carrying a protocol error code (sent back as `Msg::Error{code}`).
#[derive(Debug)]
pub struct HubError {
    pub code: &'static str,
    pub msg: String,
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for HubError {}

pub fn coded(code: &'static str, msg: impl Into<String>) -> anyhow::Error {
    HubError {
        code,
        msg: msg.into(),
    }
    .into()
}

/// Protocol error code of `e`; "internal" for anything unexpected.
pub fn error_code(e: &anyhow::Error) -> &'static str {
    e.downcast_ref::<HubError>().map_or("internal", |h| h.code)
}

/// Result of a mutation.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// `new` is false when the request changed nothing (identical put, repeated delete,
    /// existing space): no log row was written and `seq` is the entry's current version.
    Committed { seq: u64, entry: Entry, new: bool },
    Conflict {
        current: Option<Entry>,
        reason: String,
    },
    Busy {
        owner: String,
        owner_name: String,
        idle_ms: i64,
    },
}

#[derive(Debug, Clone)]
pub struct PutReq {
    pub space: String,
    pub path: String,
    pub base: Option<u64>,
    pub kind: Kind,
    pub hash: String,
    pub size: u64,
    pub exec: bool,
    pub mtime: i64,
    pub meta: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct AppendReq {
    pub space: String,
    pub path: String,
    pub offset: u64,
    pub tail: Option<String>,
    pub meta: Option<Value>,
    pub claim: bool,
}

#[derive(Debug, Clone)]
pub struct ResetReq {
    pub space: String,
    pub path: String,
    pub base: Option<u64>,
    pub hash: String,
    pub size: u64,
    pub meta: Option<Value>,
}

pub fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn missing_blob(hash: &str) -> anyhow::Error {
    coded("missing_blob", format!("blob {hash} has not been uploaded"))
}

/// Content-addressed blob files: `blobs/<2 hex>/<hash>`, uploads staged in `blobs/tmp/`.
#[derive(Debug, Clone)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn new(root: PathBuf) -> BlobStore {
        BlobStore { root }
    }

    fn path(&self, hash: &str) -> PathBuf {
        self.root.join(&hash[..2]).join(hash)
    }

    fn checked(&self, hash: &str) -> Result<PathBuf> {
        if !valid_hash(hash) {
            return Err(coded("bad_request", format!("invalid blob hash {hash:?}")));
        }
        Ok(self.path(hash))
    }

    /// Size of blob `hash`, `None` when the hub does not have it.
    pub fn size(&self, hash: &str) -> Result<Option<u64>> {
        let p = self.checked(hash)?;
        match fs::metadata(&p) {
            Ok(m) => Ok(Some(m.len())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("stat {}", p.display())),
        }
    }

    /// Up to `len` bytes (capped at `CHUNK`) at `offset`. Returns (bytes, eof).
    pub fn read(&self, hash: &str, offset: u64, len: u64) -> Result<(Vec<u8>, bool)> {
        let p = self.checked(hash)?;
        let mut f = match File::open(&p) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(missing_blob(hash)),
            Err(e) => return Err(e).with_context(|| format!("opening {}", p.display())),
        };
        let size = f.metadata()?.len();
        read_range(&mut f, size, offset, len)
    }

    /// Start a chunked upload of blob `hash`.
    pub fn begin(&self, hash: &str) -> Result<Upload> {
        let dest = self.checked(hash)?;
        let tmp = self.root.join("tmp");
        fs::create_dir_all(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        let part = tmp.join(format!("{hash}.{}.part", uuid::Uuid::new_v4().simple()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .with_context(|| format!("creating {}", part.display()))?;
        Ok(Upload {
            hash: hash.to_string(),
            part,
            dest,
            file,
            hasher: blake3::Hasher::new(),
            written: 0,
            done: false,
        })
    }

    /// Store `data` as a blob in one go (hub-internal and tests). Returns its hash.
    pub fn insert(&self, data: &[u8]) -> Result<String> {
        let hash = hash::hash_bytes(data);
        let mut up = self.begin(&hash)?;
        up.write(0, data)?;
        up.finish()?;
        Ok(hash)
    }
}

/// A blob being uploaded. Dropping an unfinished upload removes its partial file.
pub struct Upload {
    hash: String,
    part: PathBuf,
    dest: PathBuf,
    file: File,
    hasher: blake3::Hasher,
    written: u64,
    done: bool,
}

impl Upload {
    pub fn write(&mut self, offset: u64, data: &[u8]) -> Result<()> {
        if offset != self.written {
            return Err(coded(
                "bad_offset",
                format!(
                    "blob {}: expected offset {}, got {offset}",
                    self.hash, self.written
                ),
            ));
        }
        self.file
            .write_all(data)
            .with_context(|| format!("writing {}", self.part.display()))?;
        self.hasher.update(data);
        self.written += data.len() as u64;
        Ok(())
    }

    /// Verify the content hash, fsync, and move the blob into place. Returns its size.
    pub fn finish(mut self) -> Result<u64> {
        let got = self.hasher.finalize().to_hex().to_string();
        if got != self.hash {
            return Err(coded(
                "hash_mismatch",
                format!("uploaded bytes hash to {got}, expected {}", self.hash),
            ));
        }
        self.file.sync_all().context("fsync blob")?;
        let dir = self.dest.parent().map(Path::to_path_buf);
        if let Some(dir) = &dir {
            fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        fs::rename(&self.part, &self.dest)
            .with_context(|| format!("moving blob into {}", self.dest.display()))?;
        self.done = true;
        if let Some(dir) = &dir {
            sync_dir(dir);
        }
        Ok(self.written)
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        if !self.done {
            let _ = fs::remove_file(&self.part);
        }
    }
}

fn sync_dir(dir: &Path) {
    if let Err(e) = File::open(dir).and_then(|f| f.sync_all()) {
        tracing::debug!("fsync {}: {e}", dir.display());
    }
}

fn read_range(f: &mut File, size: u64, offset: u64, len: u64) -> Result<(Vec<u8>, bool)> {
    if offset > size {
        return Err(coded(
            "bad_request",
            format!("offset {offset} is beyond the end ({size})"),
        ));
    }
    let n = len.min(CHUNK as u64).min(size - offset);
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf)?;
    Ok((buf, offset + n >= size))
}

/// Filesystem name for a space or path: percent-encodes everything but `[a-z0-9._-]`, so names
/// stay distinct on case-insensitive and normalizing filesystems; long names get a hash suffix.
fn fs_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    if out.len() > 180 {
        out = format!("{}~{}", &out[..120], &hash::hash_bytes(s.as_bytes())[..32]);
    }
    out
}

fn check_space(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name.len() > 128
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.chars().any(char::is_control);
    if bad {
        return Err(coded("bad_request", format!("invalid space name {name:?}")));
    }
    Ok(())
}

fn check_path(path: &str) -> Result<()> {
    match paths::canonical(path) {
        Ok(c) if c == path => Ok(()),
        Ok(_) => Err(coded(
            "bad_request",
            format!("path {path:?} is not canonical (NFC)"),
        )),
        Err(e) => Err(coded("bad_request", e.to_string())),
    }
}

/// CAS rule (DESIGN §4.2): `base` must equal the current version, or be None while the entry is
/// absent or deleted.
fn base_matches(cur: Option<&Entry>, base: Option<u64>) -> bool {
    match (cur, base) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some(e), None) => e.deleted,
        (Some(e), Some(b)) => e.version == b,
    }
}

fn conflict(current: Option<Entry>, reason: &str) -> Outcome {
    Outcome::Conflict {
        current,
        reason: reason.to_string(),
    }
}

fn kind_str(k: Kind) -> &'static str {
    match k {
        Kind::File => "file",
        Kind::Symlink => "symlink",
        Kind::Log => "log",
    }
}

fn parse_kind(s: &str) -> Option<Kind> {
    Some(match s {
        "file" => Kind::File,
        "symlink" => Kind::Symlink,
        "log" => Kind::Log,
        _ => return None,
    })
}

fn op_str(o: Op) -> &'static str {
    match o {
        Op::Put => "put",
        Op::Delete => "delete",
        Op::Append => "append",
        Op::Reset => "reset",
        Op::Claim => "claim",
    }
}

fn parse_op(s: &str) -> Option<Op> {
    Some(match s {
        "put" => Op::Put,
        "delete" => Op::Delete,
        "append" => Op::Append,
        "reset" => Op::Reset,
        "claim" => Op::Claim,
        _ => return None,
    })
}

fn conv_err(i: usize, msg: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(i, rusqlite::types::Type::Text, msg.into())
}

fn col_kind(r: &Row, i: usize) -> rusqlite::Result<Kind> {
    let s: String = r.get(i)?;
    parse_kind(&s).ok_or_else(|| conv_err(i, format!("bad kind {s:?}")))
}

fn col_op(r: &Row, i: usize) -> rusqlite::Result<Op> {
    let s: String = r.get(i)?;
    parse_op(&s).ok_or_else(|| conv_err(i, format!("bad op {s:?}")))
}

fn col_meta(r: &Row, i: usize) -> rusqlite::Result<Option<Value>> {
    match r.get::<_, Option<String>>(i)? {
        Some(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| conv_err(i, e.to_string())),
        None => Ok(None),
    }
}

fn col_u64(r: &Row, i: usize) -> rusqlite::Result<u64> {
    Ok(r.get::<_, i64>(i)? as u64)
}

/// Entry from `ENTRY_COLS` starting at column `i`.
fn read_entry(r: &Row, i: usize) -> rusqlite::Result<Entry> {
    Ok(Entry {
        space: r.get(i)?,
        path: r.get(i + 1)?,
        kind: col_kind(r, i + 2)?,
        version: col_u64(r, i + 3)?,
        hash: r.get(i + 4)?,
        size: col_u64(r, i + 5)?,
        exec: r.get(i + 6)?,
        mtime: r.get(i + 7)?,
        deleted: r.get(i + 8)?,
        origin: r.get(i + 9)?,
        meta: col_meta(r, i + 10)?,
        owner: r.get(i + 11)?,
        owner_at: r.get(i + 12)?,
    })
}

/// A `log` row as a replicated change, plus the log epoch it belongs to.
fn read_change(r: &Row) -> rusqlite::Result<(Change, u64)> {
    let seq = col_u64(r, 0)?;
    let op = col_op(r, 1)?;
    let entry = Entry {
        space: r.get(3)?,
        path: r.get(4)?,
        kind: col_kind(r, 5)?,
        version: seq,
        hash: r.get(6)?,
        size: col_u64(r, 7)?,
        exec: r.get(8)?,
        mtime: r.get(9)?,
        deleted: r.get(10)?,
        origin: r.get(11)?,
        meta: col_meta(r, 12)?,
        owner: r.get(13)?,
        owner_at: r.get(14)?,
    };
    let epoch = col_u64(r, 15)?;
    let off: Option<i64> = r.get(16)?;
    let len: Option<i64> = r.get(17)?;
    let change = Change {
        seq,
        op,
        at: r.get(2)?,
        entry,
        offset: off.map(|v| v as u64),
        len: len.map(|v| v as u64),
        inline: false,
    };
    Ok((change, epoch))
}

/// Read `len` bytes at `offset` of the file at `p`, reusing handles opened earlier in `files`.
fn read_at(
    files: &mut HashMap<PathBuf, File>,
    p: PathBuf,
    offset: u64,
    len: u64,
) -> Result<Vec<u8>> {
    let f = match files.entry(p) {
        std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
        std::collections::hash_map::Entry::Vacant(v) => {
            let f =
                File::open(v.key()).with_context(|| format!("opening {}", v.key().display()))?;
            v.insert(f)
        }
    };
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf)
        .with_context(|| format!("reading {len} bytes at {offset}"))?;
    Ok(buf)
}

/// Write `data` at `offset` of a log file, dropping anything past `offset` first (bytes of a
/// write whose DB commit never happened), then fsync.
fn write_log_at(path: &Path, offset: u64, data: &[u8]) -> Result<()> {
    let dir = path.parent().context("log file has no parent")?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let len = f.metadata()?.len();
    if len < offset {
        bail!(
            "log file {} is shorter ({len} bytes) than its recorded size ({offset})",
            path.display()
        );
    }
    if len > offset {
        f.set_len(offset)?;
    }
    f.seek(SeekFrom::Start(offset))?;
    f.write_all(data)
        .with_context(|| format!("writing {}", path.display()))?;
    f.sync_data().context("fsync log")?;
    if offset == 0 {
        sync_dir(dir);
    }
    Ok(())
}

pub struct Store {
    dir: PathBuf,
    db: Connection,
    blobs: BlobStore,
    hub_id: String,
    head: u64,
    lease_idle_ms: i64,
}

impl Store {
    /// Open (or create) the hub state in `dir` (= `$UC_HOME/hub`).
    pub fn open(dir: &Path, lease_idle_ms: i64) -> Result<Store> {
        for d in [
            dir.to_path_buf(),
            dir.join("blobs"),
            dir.join("blobs/tmp"),
            dir.join("logs"),
        ] {
            fs::create_dir_all(&d).with_context(|| format!("creating {}", d.display()))?;
        }
        // Partial uploads of a previous run can never be resumed (uploads are per connection).
        if let Ok(rd) = fs::read_dir(dir.join("blobs/tmp")) {
            for e in rd.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
        let db_path = dir.join("hub.db");
        let mut db =
            Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
        db.busy_timeout(Duration::from_secs(10))?;
        db.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))?;
        // FULL, not NORMAL: with NORMAL a power loss can roll back the newest commits, and the
        // hub would hand out those seqs again to different changes while clients already hold
        // cursors past them (silent divergence).
        db.pragma_update(None, "synchronous", "FULL")?;
        let v: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        match v {
            0 => {
                let tx = db.transaction()?;
                tx.execute_batch(SCHEMA).context("creating hub schema")?;
                let id = format!("h_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
                tx.execute("INSERT INTO meta (k, v) VALUES ('hub_id', ?1)", [&id])?;
                tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
                tx.commit()?;
                tracing::info!(hub_id = %id, "created hub database {}", db_path.display());
            }
            SCHEMA_VERSION => {}
            v if v > SCHEMA_VERSION => bail!(
                "{} has schema v{v}, newer than this uc understands (v{SCHEMA_VERSION}); upgrade uc",
                db_path.display()
            ),
            v => bail!("{} has unsupported schema v{v}", db_path.display()),
        }
        let hub_id: String = db
            .query_row("SELECT v FROM meta WHERE k = 'hub_id'", [], |r| r.get(0))
            .context("hub.db has no hub_id")?;
        let head: i64 = db.query_row("SELECT COALESCE(MAX(seq), 0) FROM log", [], |r| r.get(0))?;
        Ok(Store {
            dir: dir.to_path_buf(),
            db,
            blobs: BlobStore::new(dir.join("blobs")),
            hub_id,
            head: head as u64,
            lease_idle_ms,
        })
    }

    pub fn hub_id(&self) -> &str {
        &self.hub_id
    }

    /// Seq of the last accepted mutation.
    pub fn head(&self) -> u64 {
        self.head
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    fn log_file(&self, space: &str, path: &str, epoch: u64) -> PathBuf {
        self.dir
            .join("logs")
            .join(fs_name(space))
            .join(format!("{}.{epoch}", fs_name(path)))
    }

    fn load(&self, space: &str, path: &str) -> Result<Option<(Entry, u64)>> {
        let mut st = self.db.prepare_cached(&format!(
            "SELECT {ENTRY_COLS}, epoch FROM entries WHERE space = ?1 AND path = ?2"
        ))?;
        Ok(st
            .query_row(params![space, path], |r| {
                Ok((read_entry(r, 0)?, col_u64(r, 13)?))
            })
            .optional()?)
    }

    pub fn entry(&self, space: &str, path: &str) -> Result<Option<Entry>> {
        Ok(self.load(space, path)?.map(|(e, _)| e))
    }

    /// Owner rule of DESIGN §6.4 (offset/tail are checked separately).
    fn may_write(&self, e: &Entry, origin: &str, now: i64) -> bool {
        match &e.owner {
            None => true,
            Some(o) if o == origin => true,
            Some(_) => now - e.owner_at > self.lease_idle_ms,
        }
    }

    fn ensure_space(&mut self, space: &str, origin: &str, now: i64) -> Result<()> {
        check_space(space)?;
        if space.starts_with('@') {
            self.db.execute(
                "INSERT OR IGNORE INTO spaces (name, default_path, created_at, created_by)
                 VALUES (?1, '', ?2, ?3)",
                params![space, now, origin],
            )?;
            return Ok(());
        }
        let exists = self
            .db
            .query_row("SELECT 1 FROM spaces WHERE name = ?1", [space], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(coded(
                "no_space",
                format!("space {space:?} does not exist on the hub"),
            ));
        }
        Ok(())
    }

    /// One transaction: log row with the next seq + the entry's new state. `e.version` must be
    /// `head + 1`.
    fn commit(
        &mut self,
        op: Op,
        e: &Entry,
        epoch: u64,
        off: Option<u64>,
        len: Option<u64>,
        now: i64,
    ) -> Result<()> {
        let seq = self.head + 1;
        debug_assert_eq!(e.version, seq);
        let meta = e.meta.as_ref().map(Value::to_string);
        let tx = self.db.transaction()?;
        tx.execute(
            &format!(
                "INSERT INTO log ({LOG_COLS}) VALUES \
                 (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"
            ),
            params![
                seq as i64,
                op_str(op),
                now,
                e.space,
                e.path,
                kind_str(e.kind),
                e.hash,
                e.size as i64,
                e.exec,
                e.mtime,
                e.deleted,
                e.origin,
                meta,
                e.owner,
                e.owner_at,
                epoch as i64,
                off.map(|v| v as i64),
                len.map(|v| v as i64),
            ],
        )?;
        tx.execute(
            &format!(
                "INSERT OR REPLACE INTO entries ({ENTRY_COLS}, epoch) VALUES \
                 (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
            ),
            params![
                e.space,
                e.path,
                kind_str(e.kind),
                seq as i64,
                e.hash,
                e.size as i64,
                e.exec,
                e.mtime,
                e.deleted,
                e.origin,
                meta,
                e.owner,
                e.owner_at,
                epoch as i64,
            ],
        )?;
        tx.commit().context("committing change")?;
        self.head = seq;
        Ok(())
    }

    pub fn touch_machine(&mut self, m: &MachineInfo, version: &str, now: i64) -> Result<()> {
        self.db.execute(
            "INSERT INTO machines (id, name, os, home, version, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, os = excluded.os,
                 home = excluded.home, version = excluded.version, last_seen = excluded.last_seen",
            params![m.id, m.name, m.os, m.home, version, now],
        )?;
        Ok(())
    }

    pub fn machine_seen(&mut self, id: &str, now: i64) -> Result<()> {
        self.db.execute(
            "UPDATE machines SET last_seen = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    }

    fn machine_name(&self, id: &str) -> Result<String> {
        Ok(self
            .db
            .query_row("SELECT name FROM machines WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .unwrap_or_default())
    }

    fn machine_names(&self) -> Result<HashMap<String, String>> {
        let mut st = self.db.prepare_cached("SELECT id, name FROM machines")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn record_blob(&mut self, hash: &str, size: u64, now: i64) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO blobs (hash, size, created_at) VALUES (?1, ?2, ?3)",
            params![hash, size as i64, now],
        )?;
        Ok(())
    }

    /// Idempotent. Spaces are not changes (no seq); the returned entry is a placeholder
    /// describing the space (`path` empty, `meta.space`).
    pub fn space_create(
        &mut self,
        name: &str,
        default_path: &str,
        origin: &str,
        now: i64,
    ) -> Result<Outcome> {
        check_space(name)?;
        let n = self.db.execute(
            "INSERT OR IGNORE INTO spaces (name, default_path, created_at, created_by)
             VALUES (?1, ?2, ?3, ?4)",
            params![name, default_path, now, origin],
        )?;
        let (dp, created_at, by): (String, i64, String) = self.db.query_row(
            "SELECT default_path, created_at, created_by FROM spaces WHERE name = ?1",
            [name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let entry = Entry {
            space: name.to_string(),
            path: String::new(),
            kind: Kind::File,
            version: self.head,
            hash: String::new(),
            size: 0,
            exec: false,
            mtime: created_at,
            deleted: false,
            origin: by,
            meta: Some(
                json!({"space": {"name": name, "default_path": dp, "created_at": created_at}}),
            ),
            owner: None,
            owner_at: 0,
        };
        Ok(Outcome::Committed {
            seq: self.head,
            entry,
            new: n > 0,
        })
    }

    pub fn put(&mut self, req: &PutReq, origin: &str, now: i64) -> Result<Outcome> {
        check_path(&req.path)?;
        if req.kind == Kind::Log {
            return Err(coded(
                "bad_request",
                "logs are created with append, not put",
            ));
        }
        self.ensure_space(&req.space, origin, now)?;
        let blob_size = self
            .blobs
            .size(&req.hash)?
            .ok_or_else(|| missing_blob(&req.hash))?;
        if blob_size != req.size {
            return Err(coded(
                "bad_request",
                format!("size {} does not match blob size {blob_size}", req.size),
            ));
        }
        let cur = self.load(&req.space, &req.path)?;
        let cur_entry = cur.as_ref().map(|(e, _)| e);
        let exec = req.kind == Kind::File && req.exec;
        if let Some(e) = cur_entry {
            if !e.deleted && e.kind == req.kind && e.hash == req.hash && e.exec == exec {
                return Ok(Outcome::Committed {
                    seq: e.version,
                    entry: e.clone(),
                    new: false,
                });
            }
        }
        if !base_matches(cur_entry, req.base) {
            return Ok(conflict(cur_entry.cloned(), "base"));
        }
        let live = cur_entry.filter(|e| !e.deleted);
        if let Some(e) = live {
            if e.kind == Kind::Log && !self.may_write(e, origin, now) {
                return Ok(conflict(cur_entry.cloned(), "owner"));
            }
        }
        let seq = self.head + 1;
        let entry = Entry {
            space: req.space.clone(),
            path: req.path.clone(),
            kind: req.kind,
            version: seq,
            hash: req.hash.clone(),
            size: req.size,
            exec,
            mtime: req.mtime,
            deleted: false,
            origin: origin.to_string(),
            meta: req
                .meta
                .clone()
                .or_else(|| live.and_then(|e| e.meta.clone())),
            owner: None,
            owner_at: 0,
        };
        self.commit(Op::Put, &entry, 0, None, None, now)?;
        Ok(Outcome::Committed {
            seq,
            entry,
            new: true,
        })
    }

    pub fn delete(
        &mut self,
        space: &str,
        path: &str,
        base: u64,
        origin: &str,
        now: i64,
    ) -> Result<Outcome> {
        check_path(path)?;
        self.ensure_space(space, origin, now)?;
        let Some((e, epoch)) = self.load(space, path)? else {
            return Ok(conflict(None, "base"));
        };
        if e.deleted {
            return Ok(Outcome::Committed {
                seq: e.version,
                entry: e,
                new: false,
            });
        }
        if e.version != base {
            return Ok(conflict(Some(e), "base"));
        }
        if e.kind == Kind::Log && !self.may_write(&e, origin, now) {
            return Ok(conflict(Some(e), "owner"));
        }
        let seq = self.head + 1;
        let entry = Entry {
            version: seq,
            deleted: true,
            origin: origin.to_string(),
            owner: None,
            owner_at: 0,
            ..e
        };
        self.commit(Op::Delete, &entry, epoch, None, None, now)?;
        Ok(Outcome::Committed {
            seq,
            entry,
            new: true,
        })
    }

    pub fn append(
        &mut self,
        req: &AppendReq,
        data: &[u8],
        origin: &str,
        now: i64,
    ) -> Result<Outcome> {
        check_path(&req.path)?;
        self.ensure_space(&req.space, origin, now)?;
        let cur = self.load(&req.space, &req.path)?;
        let current = || cur.as_ref().map(|(e, _)| e.clone());
        let live = cur.as_ref().filter(|(e, _)| !e.deleted);
        if let Some((e, _)) = live {
            if e.kind != Kind::Log {
                return Ok(conflict(current(), "kind"));
            }
        }
        let size = live.map_or(0, |(e, _)| e.size);
        if req.offset != size {
            return Ok(conflict(current(), "offset"));
        }
        let tail_ok = match (&req.tail, live) {
            (None, _) => size == 0,
            (Some(t), _) if size == 0 => *t == hash::tail_fp(b""),
            (Some(t), Some((e, _))) => *t == e.hash,
            (Some(_), None) => false,
        };
        if !tail_ok {
            return Ok(conflict(current(), "tail"));
        }
        if let Some((e, _)) = live {
            // `claim: true` grants nothing beyond the owner rule: a Claim already made this
            // machine the owner, and anything else would bypass Busy.
            if !self.may_write(e, origin, now) {
                return Ok(conflict(current(), "owner"));
            }
        }
        let seq = self.head + 1;
        let epoch = live.map_or(seq, |(_, ep)| *ep);
        let file = self.log_file(&req.space, &req.path, epoch);
        let new_size = size + data.len() as u64;
        write_log_at(&file, size, data)?;
        let tail = hash::tail_fp_file(&file, new_size)
            .with_context(|| format!("fingerprinting {}", file.display()))?;
        let entry = Entry {
            space: req.space.clone(),
            path: req.path.clone(),
            kind: Kind::Log,
            version: seq,
            hash: tail,
            size: new_size,
            exec: false,
            mtime: now,
            deleted: false,
            origin: origin.to_string(),
            meta: req
                .meta
                .clone()
                .or_else(|| live.and_then(|(e, _)| e.meta.clone())),
            owner: Some(origin.to_string()),
            owner_at: now,
        };
        if let Err(e) = self.commit(
            Op::Append,
            &entry,
            epoch,
            Some(size),
            Some(data.len() as u64),
            now,
        ) {
            if let Ok(f) = OpenOptions::new().write(true).open(&file) {
                let _ = f.set_len(size);
            }
            return Err(e);
        }
        Ok(Outcome::Committed {
            seq,
            entry,
            new: true,
        })
    }

    pub fn log_reset(&mut self, req: &ResetReq, origin: &str, now: i64) -> Result<Outcome> {
        check_path(&req.path)?;
        self.ensure_space(&req.space, origin, now)?;
        let blob_size = self
            .blobs
            .size(&req.hash)?
            .ok_or_else(|| missing_blob(&req.hash))?;
        if blob_size != req.size {
            return Err(coded(
                "bad_request",
                format!("size {} does not match blob size {blob_size}", req.size),
            ));
        }
        let cur = self.load(&req.space, &req.path)?;
        let cur_entry = cur.as_ref().map(|(e, _)| e);
        if !base_matches(cur_entry, req.base) {
            return Ok(conflict(cur_entry.cloned(), "base"));
        }
        let live = cur_entry.filter(|e| !e.deleted);
        if let Some(e) = live {
            if e.kind == Kind::Log && !self.may_write(e, origin, now) {
                return Ok(conflict(cur_entry.cloned(), "owner"));
            }
        }
        let seq = self.head + 1;
        let file = self.log_file(&req.space, &req.path, seq);
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        fs::copy(self.blobs.path(&req.hash), &file)
            .with_context(|| format!("writing {}", file.display()))?;
        File::open(&file)
            .and_then(|f| f.sync_all())
            .context("fsync log")?;
        let tail = hash::tail_fp_file(&file, req.size)?;
        let entry = Entry {
            space: req.space.clone(),
            path: req.path.clone(),
            kind: Kind::Log,
            version: seq,
            hash: tail,
            size: req.size,
            exec: false,
            mtime: now,
            deleted: false,
            origin: origin.to_string(),
            meta: req
                .meta
                .clone()
                .or_else(|| live.and_then(|e| e.meta.clone())),
            owner: Some(origin.to_string()),
            owner_at: now,
        };
        if let Err(e) = self.commit(Op::Reset, &entry, seq, None, None, now) {
            let _ = fs::remove_file(&file);
            return Err(e);
        }
        Ok(Outcome::Committed {
            seq,
            entry,
            new: true,
        })
    }

    pub fn claim(
        &mut self,
        space: &str,
        path: &str,
        force: bool,
        origin: &str,
        now: i64,
    ) -> Result<Outcome> {
        check_path(path)?;
        check_space(space)?;
        let not_found = || coded("not_found", format!("no live log {space}/{path}"));
        let Some((e, epoch)) = self.load(space, path)? else {
            return Err(not_found());
        };
        if e.deleted || e.kind != Kind::Log {
            return Err(not_found());
        }
        if let Some(o) = &e.owner {
            let idle_ms = now - e.owner_at;
            if o != origin && idle_ms <= self.lease_idle_ms && !force {
                return Ok(Outcome::Busy {
                    owner: o.clone(),
                    owner_name: self.machine_name(o)?,
                    idle_ms: idle_ms.max(0),
                });
            }
            if o == origin {
                // the owner re-claiming is a lease heartbeat: refresh owner_at, no log row
                self.db.execute(
                    "UPDATE entries SET owner_at = ?3 WHERE space = ?1 AND path = ?2",
                    rusqlite::params![space, path, now],
                )?;
                let seq = e.version;
                return Ok(Outcome::Committed {
                    seq,
                    entry: Entry { owner_at: now, ..e },
                    new: false,
                });
            }
        }
        let seq = self.head + 1;
        let entry = Entry {
            version: seq,
            origin: origin.to_string(),
            owner: Some(origin.to_string()),
            owner_at: now,
            ..e
        };
        self.commit(Op::Claim, &entry, epoch, None, None, now)?;
        Ok(Outcome::Committed {
            seq,
            entry,
            new: true,
        })
    }

    /// The owner gives up its lease (its agent is no longer running the session), so another
    /// machine can continue it without a takeover. No-op unless `origin` is the owner.
    pub fn release(&mut self, space: &str, path: &str, origin: &str) -> Result<()> {
        check_path(path)?;
        check_space(space)?;
        self.db.execute(
            "UPDATE entries SET owner = NULL, owner_at = 0 WHERE space = ?1 AND path = ?2 AND owner = ?3",
            rusqlite::params![space, path, origin],
        )?;
        Ok(())
    }

    /// `[offset, offset+len)` of a live log (len capped at `CHUNK`). Returns (bytes, eof).
    pub fn log_read(
        &self,
        space: &str,
        path: &str,
        offset: u64,
        len: u64,
    ) -> Result<(Vec<u8>, bool)> {
        let Some((e, epoch)) = self.load(space, path)? else {
            return Err(coded("not_found", format!("no log {space}/{path}")));
        };
        if e.deleted || e.kind != Kind::Log {
            return Err(coded("not_found", format!("no live log {space}/{path}")));
        }
        if offset > e.size {
            return Err(coded(
                "bad_request",
                format!("offset {offset} is beyond the end ({})", e.size),
            ));
        }
        let n = len.min(CHUNK as u64).min(e.size - offset);
        let bytes = self.read_log_bytes(space, path, epoch, offset, n)?;
        Ok((bytes, offset + n >= e.size))
    }

    fn read_log_bytes(
        &self,
        space: &str,
        path: &str,
        epoch: u64,
        offset: u64,
        len: u64,
    ) -> Result<Vec<u8>> {
        let p = self.log_file(space, path, epoch);
        read_at(&mut HashMap::new(), p, offset, len)
    }

    /// Changes with seq > `since`, in seq order (at most `max_rows`, and about
    /// `BATCH_MAX_BYTES` of inline data), plus the head seq at the time of the read. Appends of
    /// at most `INLINE_APPEND_MAX` bytes carry their bytes inline.
    pub fn changes_after(
        &self,
        since: u64,
        max_rows: usize,
    ) -> Result<(Vec<(Change, Vec<u8>)>, u64)> {
        let mut st = self.db.prepare_cached(&format!(
            "SELECT {LOG_COLS} FROM log WHERE seq > ?1 ORDER BY seq LIMIT ?2"
        ))?;
        let rows = st
            .query_map(params![since as i64, max_rows as i64], read_change)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(rows.len());
        let mut bytes = 0usize;
        let mut files: HashMap<PathBuf, File> = HashMap::new();
        for (mut change, epoch) in rows {
            if bytes >= BATCH_MAX_BYTES {
                break;
            }
            let mut bin = Vec::new();
            if let (Op::Append, Some(off), Some(len)) = (change.op, change.offset, change.len) {
                if len as usize <= INLINE_APPEND_MAX {
                    let e = &change.entry;
                    let p = self.log_file(&e.space, &e.path, epoch);
                    match read_at(&mut files, p, off, len) {
                        Ok(b) => {
                            bin = b;
                            change.inline = true;
                        }
                        Err(err) => {
                            tracing::warn!(seq = change.seq, "append bytes unavailable: {err:#}")
                        }
                    }
                }
            }
            bytes += bin.len();
            out.push((change, bin));
        }
        Ok((out, self.head))
    }

    pub fn query(&self, q: &Query, connected: &HashSet<String>, now: i64) -> Result<Value> {
        let nonempty = |s: &Option<String>| s.clone().filter(|s| !s.is_empty());
        Ok(match q {
            Query::Sessions {
                agent,
                machine,
                text,
                limit,
            } => serde_json::to_value(self.sessions(
                nonempty(agent).as_deref(),
                nonempty(machine).as_deref(),
                nonempty(text).as_deref(),
                *limit,
                now,
            )?)?,
            Query::Log {
                space,
                path,
                since_ms,
                limit,
            } => serde_json::to_value(self.log_records(
                nonempty(space).as_deref(),
                nonempty(path).as_deref(),
                *since_ms,
                limit.unwrap_or(100),
            )?)?,
            Query::History { space, path, limit } => {
                serde_json::to_value(self.history(space, path, limit.unwrap_or(100))?)?
            }
            Query::Entry { space, path } => serde_json::to_value(self.entry(space, path)?)?,
            Query::Entries { space, prefix } => {
                serde_json::to_value(self.entries(space, nonempty(prefix).as_deref())?)?
            }
            Query::Spaces => serde_json::to_value(self.spaces()?)?,
            Query::Machines => serde_json::to_value(self.machines(connected)?)?,
            Query::Status => serde_json::to_value(self.status(connected)?)?,
        })
    }

    /// Sessions newest first (by `meta.session.updated_at`, falling back to the entry mtime).
    pub fn sessions(
        &self,
        agent: Option<&str>,
        machine: Option<&str>,
        text: Option<&str>,
        limit: Option<u32>,
        now: i64,
    ) -> Result<Vec<SessionInfo>> {
        let names = self.machine_names()?;
        let mut st = self.db.prepare_cached(&format!(
            "SELECT {ENTRY_COLS} FROM entries WHERE deleted = 0 AND meta IS NOT NULL"
        ))?;
        let entries = st
            .query_map([], |r| read_entry(r, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let text = text.map(str::to_lowercase);
        let mut found: Vec<(i64, SessionInfo)> = Vec::new();
        for e in entries {
            let Some(meta) = e.meta.as_ref().and_then(SessionMeta::from_meta) else {
                continue;
            };
            if agent.is_some_and(|a| !meta.agent.eq_ignore_ascii_case(a)) {
                continue;
            }
            let owner = e.owner.clone().unwrap_or_else(|| e.origin.clone());
            let owner_name = names.get(&owner).cloned();
            if let Some(m) = machine {
                let name_hit = owner_name
                    .as_deref()
                    .is_some_and(|n| n.eq_ignore_ascii_case(m));
                if owner != m && !name_hit {
                    continue;
                }
            }
            if let Some(t) = &text {
                let hit = [
                    Some(&meta.id),
                    meta.title.as_ref(),
                    meta.first_prompt.as_ref(),
                    meta.cwd.as_ref(),
                ]
                .into_iter()
                .flatten()
                .any(|s| s.to_lowercase().contains(t.as_str()));
                if !hit {
                    continue;
                }
            }
            let live = e.owner.is_some() && now - e.owner_at <= self.lease_idle_ms;
            let last_active = if e.owner_at > 0 { e.owner_at } else { e.mtime };
            let key = meta.updated_at.unwrap_or(e.mtime);
            found.push((
                key,
                SessionInfo {
                    space: e.space,
                    path: e.path,
                    meta,
                    owner: Some(owner),
                    owner_name,
                    live,
                    idle_ms: (now - last_active).max(0),
                    size: e.size,
                    version: e.version,
                    local_cwd: None,
                    local: false,
                },
            ));
        }
        found.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.version.cmp(&a.1.version)));
        // A session is one canonical log (DESIGN §6.1); keep one row per (agent, id) even if a
        // driver tags sidecars with the same session meta.
        let mut seen = HashSet::new();
        let mut out: Vec<SessionInfo> = found
            .into_iter()
            .map(|(_, s)| s)
            .filter(|s| seen.insert((s.meta.agent.clone(), s.meta.id.clone())))
            .collect();
        if let Some(l) = limit {
            out.truncate(l as usize);
        }
        Ok(out)
    }

    fn log_record(r: &Row) -> rusqlite::Result<LogRecord> {
        Ok(LogRecord {
            seq: col_u64(r, 0)?,
            op: col_op(r, 1)?,
            at: r.get(2)?,
            space: r.get(3)?,
            path: r.get(4)?,
            kind: col_kind(r, 5)?,
            hash: r.get(6)?,
            size: col_u64(r, 7)?,
            origin: r.get(8)?,
            origin_name: r.get(9)?,
        })
    }

    fn log_records(
        &self,
        space: Option<&str>,
        path: Option<&str>,
        since_ms: Option<i64>,
        limit: u32,
    ) -> Result<Vec<LogRecord>> {
        let mut st = self.db.prepare_cached(
            "SELECT l.seq, l.op, l.at, l.space, l.path, l.kind, l.hash, l.size, l.origin,
                    COALESCE(m.name, '')
             FROM log l LEFT JOIN machines m ON m.id = l.origin
             WHERE (?1 IS NULL OR l.space = ?1)
               AND (?2 IS NULL OR l.path = ?2
                    OR (substr(?2, -1) = '/' AND substr(l.path, 1, length(?2)) = ?2))
               AND (?3 IS NULL OR l.at >= ?3)
             ORDER BY l.seq DESC LIMIT ?4",
        )?;
        let rows = st.query_map(params![space, path, since_ms, limit], Self::log_record)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn history(&self, space: &str, path: &str, limit: u32) -> Result<Vec<LogRecord>> {
        let mut st = self.db.prepare_cached(
            "SELECT l.seq, l.op, l.at, l.space, l.path, l.kind, l.hash, l.size, l.origin,
                    COALESCE(m.name, '')
             FROM log l LEFT JOIN machines m ON m.id = l.origin
             WHERE l.space = ?1 AND l.path = ?2
             ORDER BY l.seq DESC LIMIT ?3",
        )?;
        let rows = st.query_map(params![space, path, limit], Self::log_record)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn entries(&self, space: &str, prefix: Option<&str>) -> Result<Vec<Entry>> {
        let mut st = self.db.prepare_cached(&format!(
            "SELECT {ENTRY_COLS} FROM entries
             WHERE space = ?1 AND deleted = 0
               AND (?2 IS NULL OR substr(path, 1, length(?2)) = ?2)
             ORDER BY path"
        ))?;
        let rows = st.query_map(params![space, prefix], |r| read_entry(r, 0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn spaces(&self) -> Result<Vec<SpaceInfo>> {
        let mut st = self.db.prepare_cached(
            "SELECT s.name, s.default_path, s.created_at, COUNT(e.path), COALESCE(SUM(e.size), 0)
             FROM spaces s LEFT JOIN entries e ON e.space = s.name AND e.deleted = 0
             GROUP BY s.name ORDER BY s.name",
        )?;
        let rows = st.query_map([], |r| {
            Ok(SpaceInfo {
                name: r.get(0)?,
                default_path: r.get(1)?,
                created_at: r.get(2)?,
                files: col_u64(r, 3)?,
                bytes: col_u64(r, 4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn machines(&self, connected: &HashSet<String>) -> Result<Vec<MachineRecord>> {
        let mut st = self.db.prepare_cached(
            "SELECT id, name, os, home, last_seen FROM machines ORDER BY last_seen DESC",
        )?;
        let rows = st.query_map([], |r| {
            let id: String = r.get(0)?;
            Ok(MachineRecord {
                connected: connected.contains(&id),
                info: MachineInfo {
                    id,
                    name: r.get(1)?,
                    os: r.get(2)?,
                    home: r.get(3)?,
                },
                last_seen: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn status(&self, connected: &HashSet<String>) -> Result<HubStatus> {
        let (blobs, blob_bytes): (i64, i64) = self.db.query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM blobs",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(HubStatus {
            hub_id: self.hub_id.clone(),
            version: VERSION.to_string(),
            head_seq: self.head,
            machines: self.machines(connected)?,
            spaces: self.spaces()?,
            blobs: blobs as u64,
            blob_bytes: blob_bytes as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASE: i64 = 120_000;
    const M1: &str = "m_one";
    const M2: &str = "m_two";

    fn tmp() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap()
    }

    fn open(dir: &Path) -> Store {
        let mut s = Store::open(&dir.join("hub"), LEASE).unwrap();
        for (id, name) in [(M1, "mac"), (M2, "linux")] {
            let m = MachineInfo {
                id: id.into(),
                name: name.into(),
                os: "linux".into(),
                home: "/home/x".into(),
            };
            s.touch_machine(&m, VERSION, 1).unwrap();
        }
        s
    }

    fn put_req(space: &str, path: &str, base: Option<u64>, hash: &str, size: u64) -> PutReq {
        PutReq {
            space: space.into(),
            path: path.into(),
            base,
            kind: Kind::File,
            hash: hash.into(),
            size,
            exec: false,
            mtime: 5,
            meta: None,
        }
    }

    fn app(path: &str, offset: u64, tail: Option<String>) -> AppendReq {
        AppendReq {
            space: "@claude".into(),
            path: path.into(),
            offset,
            tail,
            meta: None,
            claim: false,
        }
    }

    fn committed(o: Outcome) -> (u64, Entry) {
        match o {
            Outcome::Committed { seq, entry, .. } => (seq, entry),
            other => panic!("expected commit, got {other:?}"),
        }
    }

    fn reason(o: Outcome) -> String {
        match o {
            Outcome::Conflict { reason, .. } => reason,
            other => panic!("expected conflict, got {other:?}"),
        }
    }

    #[test]
    fn put_cas_idempotent_and_delete() {
        let d = tmp();
        let mut s = open(d.path());
        s.space_create("code", "~/Code", M1, 1).unwrap();
        let h1 = s.blobs().insert(b"one").unwrap();
        let h2 = s.blobs().insert(b"two").unwrap();

        let (seq, e) = committed(
            s.put(&put_req("code", "a.txt", None, &h1, 3), M1, 10)
                .unwrap(),
        );
        assert_eq!((seq, e.version, e.origin.as_str()), (1, 1, M1));
        // stale base (None while it exists) with different content
        assert_eq!(
            reason(
                s.put(&put_req("code", "a.txt", None, &h2, 3), M2, 11)
                    .unwrap()
            ),
            "base"
        );
        // identical content: current entry, no new row, whatever the base
        match s
            .put(&put_req("code", "a.txt", Some(77), &h1, 3), M2, 12)
            .unwrap()
        {
            Outcome::Committed { seq, new, entry } => {
                assert_eq!((seq, new, entry.origin.as_str()), (1, false, M1))
            }
            o => panic!("{o:?}"),
        }
        assert_eq!(s.head(), 1);
        let (seq, _) = committed(
            s.put(&put_req("code", "a.txt", Some(1), &h2, 3), M2, 13)
                .unwrap(),
        );
        assert_eq!(seq, 2);

        assert_eq!(
            reason(s.delete("code", "a.txt", 1, M1, 14).unwrap()),
            "base"
        );
        let (seq, e) = committed(s.delete("code", "a.txt", 2, M1, 15).unwrap());
        assert!(e.deleted);
        assert_eq!((seq, e.hash.as_str()), (3, h2.as_str()));
        // repeated delete is a no-op
        match s.delete("code", "a.txt", 2, M1, 16).unwrap() {
            Outcome::Committed { seq, new, .. } => assert_eq!((seq, new), (3, false)),
            o => panic!("{o:?}"),
        }
        // recreate over the tombstone with base None
        let (seq, e) = committed(
            s.put(&put_req("code", "a.txt", None, &h1, 3), M2, 17)
                .unwrap(),
        );
        assert_eq!(seq, 4);
        assert!(!e.deleted);
        assert_eq!(reason(s.delete("code", "nope", 1, M1, 18).unwrap()), "base");
    }

    #[test]
    fn put_errors() {
        let d = tmp();
        let mut s = open(d.path());
        s.space_create("code", "~/Code", M1, 1).unwrap();
        let missing = hash::hash_bytes(b"never uploaded");
        let err = s
            .put(&put_req("code", "a", None, &missing, 14), M1, 2)
            .unwrap_err();
        assert_eq!(error_code(&err), "missing_blob");
        let h = s.blobs().insert(b"x").unwrap();
        let err = s
            .put(&put_req("nospace", "a", None, &h, 1), M1, 2)
            .unwrap_err();
        assert_eq!(error_code(&err), "no_space");
        let err = s
            .put(&put_req("code", "../a", None, &h, 1), M1, 2)
            .unwrap_err();
        assert_eq!(error_code(&err), "bad_request");
        let err = s
            .put(&put_req("code", "a", None, &h, 2), M1, 2)
            .unwrap_err();
        assert_eq!(error_code(&err), "bad_request");
        let err = s
            .put(&put_req("code", "a", None, "../../etc", 1), M1, 2)
            .unwrap_err();
        assert_eq!(error_code(&err), "bad_request");
        // '@' spaces are created on demand
        committed(
            s.put(&put_req("@claude", "x.json", None, &h, 1), M1, 3)
                .unwrap(),
        );
        // SpaceCreate is idempotent and keeps the first default path
        match s.space_create("code", "~/Other", M2, 9).unwrap() {
            Outcome::Committed { new, entry, .. } => {
                assert!(!new);
                assert_eq!(entry.meta.unwrap()["space"]["default_path"], "~/Code");
            }
            o => panic!("{o:?}"),
        }
        assert_eq!(s.head(), 1);
    }

    #[test]
    fn upload_chunks_and_verify() {
        let d = tmp();
        let s = open(d.path());
        let data = b"hello chunked world".to_vec();
        let h = hash::hash_bytes(&data);
        let mut up = s.blobs().begin(&h).unwrap();
        up.write(0, &data[..5]).unwrap();
        assert_eq!(error_code(&up.write(3, b"zz").unwrap_err()), "bad_offset");
        up.write(5, &data[5..]).unwrap();
        assert_eq!(up.finish().unwrap(), data.len() as u64);
        assert_eq!(s.blobs().size(&h).unwrap(), Some(data.len() as u64));
        let (b, eof) = s.blobs().read(&h, 6, 7).unwrap();
        assert_eq!((b.as_slice(), eof), (&b"chunked"[..], false));
        let (b, eof) = s.blobs().read(&h, 14, 100).unwrap();
        assert_eq!((b.as_slice(), eof), (&b"world"[..], true));

        let mut bad = s.blobs().begin(&hash::hash_bytes(b"other")).unwrap();
        bad.write(0, b"not other").unwrap();
        assert_eq!(error_code(&bad.finish().unwrap_err()), "hash_mismatch");
        let leftovers = fs::read_dir(d.path().join("hub/blobs/tmp"))
            .unwrap()
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn append_offset_tail_owner_and_lease() {
        let d = tmp();
        let mut s = open(d.path());
        let p = "sessions/abc.jsonl";
        let l1 = b"{\"a\":1}\n";
        let (seq, e) = committed(s.append(&app(p, 0, None), l1, M1, 1000).unwrap());
        assert_eq!(seq, 1);
        assert_eq!(e.kind, Kind::Log);
        assert_eq!(e.size, l1.len() as u64);
        assert_eq!(e.hash, hash::tail_fp(l1));
        assert_eq!(e.owner.as_deref(), Some(M1));
        let tail = Some(e.hash.clone());

        assert_eq!(
            reason(
                s.append(&app(p, 3, tail.clone()), b"x\n", M1, 1001)
                    .unwrap()
            ),
            "offset"
        );
        let wrong = Some(hash::tail_fp(b"nope"));
        assert_eq!(
            reason(s.append(&app(p, 8, wrong), b"x\n", M1, 1001).unwrap()),
            "tail"
        );
        assert_eq!(
            reason(s.append(&app(p, 8, None), b"x\n", M1, 1001).unwrap()),
            "tail"
        );
        // another machine while the owner is live
        assert_eq!(
            reason(
                s.append(&app(p, 8, tail.clone()), b"x\n", M2, 2000)
                    .unwrap()
            ),
            "owner"
        );
        let mut claim = app(p, 8, tail.clone());
        claim.claim = true;
        assert_eq!(reason(s.append(&claim, b"x\n", M2, 2000).unwrap()), "owner");

        let l2 = b"{\"b\":2}\n";
        let (_, e) = committed(s.append(&app(p, 8, tail), l2, M1, 3000).unwrap());
        let all = [&l1[..], &l2[..]].concat();
        assert_eq!(e.hash, hash::tail_fp(&all));
        // owner idle past the lease: another machine may continue and becomes the owner
        let later = 3000 + LEASE + 1;
        let (_, e) = committed(
            s.append(&app(p, 16, Some(e.hash)), b"{}\n", M2, later)
                .unwrap(),
        );
        assert_eq!(e.owner.as_deref(), Some(M2));
        assert_eq!(e.size, 19);
        let (bytes, eof) = s.log_read("@claude", p, 0, 1 << 20).unwrap();
        assert_eq!(bytes, [&all[..], b"{}\n"].concat());
        assert!(eof);
        let (bytes, eof) = s.log_read("@claude", p, 8, 8).unwrap();
        assert_eq!((bytes.as_slice(), eof), (&l2[..], false));

        // tail Some(fp of empty) is accepted for a new log, and appends to files are refused
        let (_, e) = committed(
            s.append(&app("n.jsonl", 0, Some(hash::tail_fp(b""))), b"1\n", M1, 1)
                .unwrap(),
        );
        assert_eq!(e.size, 2);
        let h = s.blobs().insert(b"f").unwrap();
        committed(
            s.put(&put_req("@claude", "f.json", None, &h, 1), M1, 1)
                .unwrap(),
        );
        assert_eq!(
            reason(s.append(&app("f.json", 1, None), b"x", M1, 1).unwrap()),
            "kind"
        );
    }

    #[test]
    fn claim_busy_force_and_reset() {
        let d = tmp();
        let mut s = open(d.path());
        let p = "sessions/s1.jsonl";
        let (_, e) = committed(s.append(&app(p, 0, None), b"one\n", M1, 1000).unwrap());
        match s.claim("@claude", p, false, M2, 2000).unwrap() {
            Outcome::Busy {
                owner,
                owner_name,
                idle_ms,
            } => {
                assert_eq!(
                    (owner.as_str(), owner_name.as_str(), idle_ms),
                    (M1, "mac", 1000)
                )
            }
            o => panic!("{o:?}"),
        }
        let (seq, c) = committed(s.claim("@claude", p, true, M2, 2001).unwrap());
        assert_eq!(seq, 2);
        assert_eq!(
            (c.owner.as_deref(), c.owner_at, c.size),
            (Some(M2), 2001, 4)
        );
        // the old owner has lost the log
        assert_eq!(
            reason(
                s.append(&app(p, 4, Some(e.hash.clone())), b"x\n", M1, 2002)
                    .unwrap()
            ),
            "owner"
        );
        // the claimer continues (claim:true is fine)
        let mut a = app(p, 4, Some(e.hash));
        a.claim = true;
        committed(s.append(&a, b"two\n", M2, 2003).unwrap());
        // claim of an idle log needs no force; claim of a missing log is an error
        committed(s.claim("@claude", p, false, M1, 2003 + LEASE + 1).unwrap());
        assert_eq!(
            error_code(&s.claim("@claude", "nope.jsonl", false, M1, 1).unwrap_err()),
            "not_found"
        );

        // reset: owner only, CAS on version, content replaced from a blob
        let cur = s.entry("@claude", p).unwrap().unwrap();
        let content = b"rewritten\n".to_vec();
        let h = s.blobs().insert(&content).unwrap();
        let req = |base| ResetReq {
            space: "@claude".into(),
            path: p.into(),
            base,
            hash: h.clone(),
            size: content.len() as u64,
            meta: None,
        };
        let now = 2003 + LEASE + 2;
        assert_eq!(
            reason(s.log_reset(&req(Some(cur.version)), M2, now).unwrap()),
            "owner"
        );
        assert_eq!(reason(s.log_reset(&req(Some(1)), M1, now).unwrap()), "base");
        let (seq, e) = committed(s.log_reset(&req(Some(cur.version)), M1, now).unwrap());
        assert_eq!(
            (e.size, e.hash.clone()),
            (content.len() as u64, hash::tail_fp(&content))
        );
        assert_eq!(s.log_read("@claude", p, 0, 100).unwrap().0, content);
        // appends continue on the new content
        committed(
            s.append(&app(p, e.size, Some(e.hash)), b"more\n", M1, now + 1)
                .unwrap(),
        );
        assert_eq!(
            s.log_read("@claude", p, 0, 100).unwrap().0,
            b"rewritten\nmore\n"
        );

        // catch-up still serves the bytes of appends from before the reset
        let (changes, head) = s.changes_after(0, 100).unwrap();
        assert_eq!(head, seq + 1);
        let ops: Vec<Op> = changes.iter().map(|(c, _)| c.op).collect();
        assert_eq!(
            ops,
            [
                Op::Append,
                Op::Claim,
                Op::Append,
                Op::Claim,
                Op::Reset,
                Op::Append
            ]
        );
        assert_eq!(changes[0].1, b"one\n");
        assert!(changes[0].0.inline);
        assert_eq!(changes[2].1, b"two\n");
        assert_eq!(changes[2].0.offset, Some(4));
        assert_eq!(changes[5].1, b"more\n");
        assert!(changes[1].1.is_empty() && !changes[1].0.inline);
        let (rest, _) = s.changes_after(seq, 100).unwrap();
        assert_eq!(rest.len(), 1);
    }

    #[test]
    fn deleted_log_is_recreated_as_new_lineage() {
        let d = tmp();
        let mut s = open(d.path());
        let p = "sessions/d.jsonl";
        let (v, _) = committed(s.append(&app(p, 0, None), b"old\n", M1, 1).unwrap());
        assert_eq!(reason(s.delete("@claude", p, v, M2, 2).unwrap()), "owner");
        committed(s.delete("@claude", p, v, M1, 3).unwrap());
        assert_eq!(
            reason(s.append(&app(p, 4, None), b"x\n", M1, 4).unwrap()),
            "offset"
        );
        let (_, e) = committed(s.append(&app(p, 0, None), b"new\n", M2, 5).unwrap());
        assert_eq!(e.size, 4);
        assert_eq!(s.log_read("@claude", p, 0, 10).unwrap().0, b"new\n");
        let (changes, _) = s.changes_after(0, 10).unwrap();
        assert_eq!(changes[0].1, b"old\n");
        assert_eq!(changes[2].1, b"new\n");
    }

    #[test]
    fn sessions_query() {
        let d = tmp();
        let mut s = open(d.path());
        let mk = |id: &str, agent: &str, title: &str, updated: i64| AppendReq {
            space: format!("@{agent}"),
            path: format!("sessions/{id}.jsonl"),
            offset: 0,
            tail: None,
            meta: Some(
                SessionMeta {
                    agent: agent.into(),
                    id: id.into(),
                    title: Some(title.into()),
                    cwd: Some("@@UC_SPACE:code@@/proj".into()),
                    updated_at: Some(updated),
                    ..Default::default()
                }
                .to_meta(),
            ),
            claim: false,
        };
        committed(
            s.append(
                &mk("aaa", "claude", "Fix the parser", 300),
                b"1\n",
                M1,
                1000,
            )
            .unwrap(),
        );
        committed(
            s.append(&mk("bbb", "codex", "Write docs", 100), b"1\n", M2, 1000)
                .unwrap(),
        );
        committed(
            s.append(
                &mk("ccc", "claude", "Refactor hub", 200),
                b"1\n",
                M2,
                500_000,
            )
            .unwrap(),
        );
        // a plain file without session meta is not a session
        let h = s.blobs().insert(b"x").unwrap();
        committed(
            s.put(&put_req("@claude", "settings.json", None, &h, 1), M1, 1)
                .unwrap(),
        );

        let now = 500_001;
        let all = s.sessions(None, None, None, None, now).unwrap();
        let ids: Vec<&str> = all.iter().map(|x| x.meta.id.as_str()).collect();
        assert_eq!(ids, ["aaa", "ccc", "bbb"]);
        assert_eq!(all[0].owner_name.as_deref(), Some("mac"));
        assert!(!all[0].live);
        assert!(all[1].live);
        assert_eq!(all[1].idle_ms, 1);

        let ids = |v: Vec<SessionInfo>| v.into_iter().map(|x| x.meta.id).collect::<Vec<_>>();
        assert_eq!(
            ids(s.sessions(Some("claude"), None, None, None, now).unwrap()),
            ["aaa", "ccc"]
        );
        assert_eq!(
            ids(s.sessions(None, Some("linux"), None, None, now).unwrap()),
            ["ccc", "bbb"]
        );
        assert_eq!(
            ids(s.sessions(None, Some(M1), None, None, now).unwrap()),
            ["aaa"]
        );
        assert_eq!(
            ids(s.sessions(None, None, Some("REFACTOR"), None, now).unwrap()),
            ["ccc"]
        );
        assert_eq!(
            ids(s.sessions(None, None, Some("proj"), Some(2), now).unwrap()),
            ["aaa", "ccc"]
        );

        let q = Query::Sessions {
            agent: None,
            machine: None,
            text: Some("docs".into()),
            limit: None,
        };
        let v = s.query(&q, &HashSet::new(), now).unwrap();
        let back: Vec<SessionInfo> = serde_json::from_value(v).unwrap();
        assert_eq!(back.len(), 1);
    }

    #[test]
    fn other_queries() {
        let d = tmp();
        let mut s = open(d.path());
        s.space_create("code", "~/Code", M1, 1).unwrap();
        let h = s.blobs().insert(b"abc").unwrap();
        s.record_blob(&h, 3, 1).unwrap();
        committed(
            s.put(&put_req("code", "dir/a.txt", None, &h, 3), M1, 10)
                .unwrap(),
        );
        committed(
            s.put(&put_req("code", "dir/b.txt", None, &h, 3), M2, 11)
                .unwrap(),
        );
        committed(
            s.put(&put_req("code", "top.txt", None, &h, 3), M2, 12)
                .unwrap(),
        );
        committed(s.delete("code", "dir/b.txt", 2, M1, 13).unwrap());
        let none = HashSet::new();

        let q = |q: Query| s.query(&q, &none, 20).unwrap();
        let log: Vec<LogRecord> = serde_json::from_value(q(Query::Log {
            space: Some("code".into()),
            path: Some("dir/".into()),
            since_ms: None,
            limit: None,
        }))
        .unwrap();
        let seqs: Vec<u64> = log.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, [4, 2, 1]);
        assert_eq!(log[0].origin_name, "mac");
        let log: Vec<LogRecord> = serde_json::from_value(q(Query::Log {
            space: None,
            path: None,
            since_ms: Some(12),
            limit: Some(1),
        }))
        .unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].op, Op::Delete);

        let hist: Vec<LogRecord> = serde_json::from_value(q(Query::History {
            space: "code".into(),
            path: "dir/b.txt".into(),
            limit: None,
        }))
        .unwrap();
        assert_eq!(
            hist.iter().map(|r| r.op).collect::<Vec<_>>(),
            [Op::Delete, Op::Put]
        );

        let e: Option<Entry> = serde_json::from_value(q(Query::Entry {
            space: "code".into(),
            path: "dir/b.txt".into(),
        }))
        .unwrap();
        assert!(e.unwrap().deleted);
        let es: Vec<Entry> = serde_json::from_value(q(Query::Entries {
            space: "code".into(),
            prefix: Some("dir/".into()),
        }))
        .unwrap();
        assert_eq!(es.len(), 1);

        let spaces: Vec<SpaceInfo> = serde_json::from_value(q(Query::Spaces)).unwrap();
        assert_eq!(spaces.len(), 1);
        assert_eq!((spaces[0].files, spaces[0].bytes), (2, 6));

        let connected: HashSet<String> = [M2.to_string()].into();
        let st: HubStatus =
            serde_json::from_value(s.query(&Query::Status, &connected, 20).unwrap()).unwrap();
        assert_eq!((st.head_seq, st.blobs, st.blob_bytes), (4, 1, 3));
        assert_eq!(st.hub_id, s.hub_id());
        let m2 = st.machines.iter().find(|m| m.info.id == M2).unwrap();
        assert!(m2.connected);
        assert!(
            !st.machines
                .iter()
                .find(|m| m.info.id == M1)
                .unwrap()
                .connected
        );
    }

    #[test]
    fn reopen_keeps_state_and_rejects_newer_schema() {
        let d = tmp();
        let id = {
            let mut s = open(d.path());
            committed(s.append(&app("x.jsonl", 0, None), b"a\n", M1, 1).unwrap());
            s.hub_id().to_string()
        };
        let s = Store::open(&d.path().join("hub"), LEASE).unwrap();
        assert_eq!((s.hub_id(), s.head()), (id.as_str(), 1));
        drop(s);
        let db = Connection::open(d.path().join("hub/hub.db")).unwrap();
        db.execute_batch("PRAGMA user_version = 99").unwrap();
        drop(db);
        let err = Store::open(&d.path().join("hub"), LEASE).err().unwrap();
        assert!(format!("{err:#}").contains("upgrade uc"));
    }

    #[test]
    fn large_appends_are_not_inlined_and_read_in_chunks() {
        let d = tmp();
        let mut s = open(d.path());
        let big = vec![b'x'; INLINE_APPEND_MAX + 1];
        committed(s.append(&app("big.jsonl", 0, None), &big, M1, 1).unwrap());
        let (changes, _) = s.changes_after(0, 10).unwrap();
        assert!(!changes[0].0.inline && changes[0].1.is_empty());
        assert_eq!(changes[0].0.len, Some(big.len() as u64));
        let (first, eof) = s.log_read("@claude", "big.jsonl", 0, u64::MAX).unwrap();
        assert_eq!((first.len(), eof), (big.len(), true));
        let (tail, eof) = s.log_read("@claude", "big.jsonl", 10, 5).unwrap();
        assert_eq!((tail.len(), eof), (5, false));
        assert_eq!(
            error_code(
                &s.log_read("@claude", "big.jsonl", big.len() as u64 + 1, 1)
                    .unwrap_err()
            ),
            "bad_request"
        );
    }

    #[test]
    fn fs_names_are_safe() {
        assert_eq!(fs_name("sessions/abc.jsonl"), "sessions%2Fabc.jsonl");
        assert_ne!(fs_name("A"), fs_name("a"));
        assert!(!fs_name("../x").contains('/'));
        assert!(fs_name(&"x/".repeat(200)).len() <= 180);
    }
}
