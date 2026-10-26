//! Client state DB: remote (R), base (B) and local fingerprint per entry (DESIGN §5.1).
//! Owner: client-core agent. Used by engine and logsync.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use crate::proto::{Change, Entry, Kind};

/// Local file fingerprint (cheap change detection without hashing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFp {
    pub size: u64,
    pub mtime_ns: i128,
    pub ino: u64,
    pub exec: bool,
}

impl LocalFp {
    pub fn mtime_ms(&self) -> i64 {
        (self.mtime_ns / 1_000_000) as i64
    }
}

/// Log sync point (DESIGN §6.2): local bytes [0, local_len) correspond to canonical
/// bytes [0, base.size).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogPoint {
    pub local_len: u64,
    /// tail fingerprint of the LOCAL file at local_len (hash::tail_fp_file)
    pub local_tail: String,
    /// native absolute path the log is materialized at on this machine
    pub native: String,
}

/// Last state agreed with the hub (B).
#[derive(Debug, Clone, PartialEq)]
pub struct Base {
    pub version: u64,
    pub kind: Kind,
    /// content hash (file/symlink) or canonical tail fingerprint (log)
    pub hash: String,
    pub size: u64,
    pub exec: bool,
    pub deleted: bool,
    /// local fingerprint right after we agreed (None for deleted)
    pub fp: Option<LocalFp>,
    pub log: Option<LogPoint>,
}

impl Base {
    /// B for a hub entry we now agree with, at local fingerprint `fp`.
    pub fn from_entry(e: &Entry, fp: Option<LocalFp>) -> Base {
        Base {
            version: e.version,
            kind: e.kind,
            hash: e.hash.clone(),
            size: e.size,
            exec: e.exec,
            deleted: e.deleted,
            fp: if e.deleted { None } else { fp },
            log: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Row {
    pub space: String,
    pub path: String,
    /// R: latest known hub state
    pub remote: Option<Entry>,
    /// B: last agreed state
    pub base: Option<Base>,
}

const SCHEMA_VERSION: i32 = 1;

const SCHEMA: &str = "
BEGIN;
CREATE TABLE IF NOT EXISTS entries (
  space TEXT NOT NULL,
  path TEXT NOT NULL,
  r_json TEXT,
  r_version INTEGER,
  r_deleted INTEGER NOT NULL DEFAULT 0,
  b_version INTEGER,
  b_kind TEXT,
  b_hash TEXT,
  b_size INTEGER,
  b_exec INTEGER,
  b_deleted INTEGER,
  fp_size INTEGER,
  fp_mtime_ns INTEGER,
  fp_ino INTEGER,
  fp_exec INTEGER,
  log_local_len INTEGER,
  log_local_tail TEXT,
  log_native TEXT,
  PRIMARY KEY (space, path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
PRAGMA user_version = 1;
COMMIT;
";

const COLS: &str = "space, path, r_json, b_version, b_kind, b_hash, b_size, b_exec, b_deleted, \
                    fp_size, fp_mtime_ns, fp_ino, fp_exec, log_local_len, log_local_tail, log_native";

const CURSOR: &str = "cursor";
const CURSOR_AT: &str = "cursor_at";

pub struct ClientDb {
    conn: Mutex<Connection>,
}

fn kind_str(k: Kind) -> &'static str {
    match k {
        Kind::File => "file",
        Kind::Symlink => "symlink",
        Kind::Log => "log",
    }
}

fn parse_kind(s: &str) -> Kind {
    match s {
        "symlink" => Kind::Symlink,
        "log" => Kind::Log,
        _ => Kind::File,
    }
}

fn conv_err(e: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
}

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    let remote = match r.get::<_, Option<String>>(2)? {
        Some(j) => Some(serde_json::from_str::<Entry>(&j).map_err(conv_err)?),
        None => None,
    };
    let base = match r.get::<_, Option<i64>>(3)? {
        None => None,
        Some(v) => {
            let fp = match r.get::<_, Option<i64>>(9)? {
                Some(size) => Some(LocalFp {
                    size: size as u64,
                    mtime_ns: r.get::<_, i64>(10)? as i128,
                    ino: r.get::<_, i64>(11)? as u64,
                    exec: r.get::<_, i64>(12)? != 0,
                }),
                None => None,
            };
            let log = match r.get::<_, Option<i64>>(13)? {
                Some(len) => Some(LogPoint {
                    local_len: len as u64,
                    local_tail: r.get::<_, Option<String>>(14)?.unwrap_or_default(),
                    native: r.get::<_, Option<String>>(15)?.unwrap_or_default(),
                }),
                None => None,
            };
            Some(Base {
                version: v as u64,
                kind: parse_kind(&r.get::<_, String>(4)?),
                hash: r.get(5)?,
                size: r.get::<_, i64>(6)? as u64,
                exec: r.get::<_, i64>(7)? != 0,
                deleted: r.get::<_, i64>(8)? != 0,
                fp,
                log,
            })
        }
    };
    Ok(Row {
        space: r.get(0)?,
        path: r.get(1)?,
        remote,
        base,
    })
}

fn upsert_remote(c: &Connection, e: &Entry) -> Result<()> {
    let json = serde_json::to_string(e)?;
    c.execute(
        "INSERT INTO entries (space, path, r_json, r_version, r_deleted) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(space, path) DO UPDATE SET
           r_json = excluded.r_json, r_version = excluded.r_version, r_deleted = excluded.r_deleted
         WHERE entries.r_version IS NULL OR excluded.r_version >= entries.r_version",
        params![e.space, e.path, json, e.version as i64, e.deleted as i64],
    )?;
    Ok(())
}

fn kv_get_on(c: &Connection, k: &str) -> Result<Option<String>> {
    Ok(
        c.query_row("SELECT v FROM kv WHERE k = ?1", [k], |r| r.get(0))
            .optional()?,
    )
}

fn kv_set_on(c: &Connection, k: &str, v: &str) -> Result<()> {
    c.execute(
        "INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        params![k, v],
    )?;
    Ok(())
}

fn cursor_on(c: &Connection) -> Result<u64> {
    Ok(kv_get_on(c, CURSOR)?
        .map(|v| v.parse::<u64>())
        .transpose()
        .context("corrupt cursor in client.db")?
        .unwrap_or(0))
}

impl ClientDb {
    pub fn open(path: &Path) -> Result<ClientDb> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(10))?;
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn).with_context(|| format!("initializing {}", path.display()))
    }

    pub fn open_in_memory() -> Result<ClientDb> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<ClientDb> {
        let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        match v {
            0 => conn.execute_batch(SCHEMA)?,
            SCHEMA_VERSION => {}
            v if v > SCHEMA_VERSION => {
                bail!("client.db schema v{v} is newer than this uc understands (v{SCHEMA_VERSION}); upgrade uc")
            }
            v => bail!("unsupported client.db schema v{v}"),
        }
        Ok(ClientDb {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// last applied hub seq (0 = none)
    pub fn cursor(&self) -> Result<u64> {
        cursor_on(&self.lock())
    }

    pub fn get(&self, space: &str, path: &str) -> Result<Option<Row>> {
        let c = self.lock();
        let sql = format!("SELECT {COLS} FROM entries WHERE space = ?1 AND path = ?2");
        Ok(c.query_row(&sql, params![space, path], read_row)
            .optional()?)
    }

    /// Upsert R from a change and advance the cursor to change.seq, atomically.
    /// Replays (seq <= cursor) are ignored.
    pub fn record_remote(&self, change: &Change) -> Result<()> {
        let mut c = self.lock();
        let tx = c.transaction()?;
        if change.seq <= cursor_on(&tx)? {
            return Ok(());
        }
        upsert_remote(&tx, &change.entry)?;
        kv_set_on(&tx, CURSOR, &change.seq.to_string())?;
        // identity of the change at the cursor: lets the daemon detect a hub rolled back to an
        // older backup even after it has moved past our cursor again
        let e = &change.entry;
        kv_set_on(
            &tx,
            CURSOR_AT,
            &format!("{}\t{}\t{}\t{}", change.seq, e.space, e.path, e.hash),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// (seq, space, path, hash) of the last change recorded with the cursor.
    pub fn cursor_at(&self) -> Result<Option<(u64, String, String, String)>> {
        let Some(v) = kv_get_on(&self.lock(), CURSOR_AT)? else {
            return Ok(None);
        };
        let mut it = v.splitn(4, '\t');
        let (Some(seq), Some(space), Some(path), Some(hash)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            return Ok(None);
        };
        Ok(seq
            .parse()
            .ok()
            .map(|s| (s, space.to_string(), path.to_string(), hash.to_string())))
    }

    /// Upsert R only (e.g. from a Conflict/Committed response), no cursor change.
    /// Never moves R backwards (an older version than the stored one is ignored).
    pub fn set_remote(&self, entry: &Entry) -> Result<()> {
        upsert_remote(&self.lock(), entry)
    }

    pub fn set_base(&self, space: &str, path: &str, base: Option<&Base>) -> Result<()> {
        let c = self.lock();
        match base {
            None => {
                c.execute(
                    "UPDATE entries SET b_version = NULL, b_kind = NULL, b_hash = NULL, b_size = NULL,
                       b_exec = NULL, b_deleted = NULL, fp_size = NULL, fp_mtime_ns = NULL, fp_ino = NULL,
                       fp_exec = NULL, log_local_len = NULL, log_local_tail = NULL, log_native = NULL
                     WHERE space = ?1 AND path = ?2",
                    params![space, path],
                )?;
                c.execute(
                    "DELETE FROM entries WHERE space = ?1 AND path = ?2 AND r_json IS NULL",
                    params![space, path],
                )?;
            }
            Some(b) => {
                let fp = b.fp.as_ref();
                let log = b.log.as_ref();
                c.execute(
                    "INSERT INTO entries (space, path, b_version, b_kind, b_hash, b_size, b_exec, b_deleted,
                       fp_size, fp_mtime_ns, fp_ino, fp_exec, log_local_len, log_local_tail, log_native)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                     ON CONFLICT(space, path) DO UPDATE SET
                       b_version = excluded.b_version, b_kind = excluded.b_kind, b_hash = excluded.b_hash,
                       b_size = excluded.b_size, b_exec = excluded.b_exec, b_deleted = excluded.b_deleted,
                       fp_size = excluded.fp_size, fp_mtime_ns = excluded.fp_mtime_ns,
                       fp_ino = excluded.fp_ino, fp_exec = excluded.fp_exec,
                       log_local_len = excluded.log_local_len, log_local_tail = excluded.log_local_tail,
                       log_native = excluded.log_native",
                    params![
                        space,
                        path,
                        b.version as i64,
                        kind_str(b.kind),
                        b.hash,
                        b.size as i64,
                        b.exec as i64,
                        b.deleted as i64,
                        fp.map(|f| f.size as i64),
                        fp.map(|f| f.mtime_ns.clamp(i64::MIN as i128, i64::MAX as i128) as i64),
                        fp.map(|f| f.ino as i64),
                        fp.map(|f| f.exec as i64),
                        log.map(|l| l.local_len as i64),
                        log.map(|l| l.local_tail.clone()),
                        log.map(|l| l.native.clone()),
                    ],
                )?;
            }
        }
        Ok(())
    }

    /// Forget every B of a space but keep R (the space now lives in another folder: re-join).
    pub fn clear_bases(&self, space: &str) -> Result<()> {
        let c = self.lock();
        c.execute(
            "UPDATE entries SET b_version = NULL, b_kind = NULL, b_hash = NULL, b_size = NULL,
               b_exec = NULL, b_deleted = NULL, fp_size = NULL, fp_mtime_ns = NULL, fp_ino = NULL,
               fp_exec = NULL, log_local_len = NULL, log_local_tail = NULL, log_native = NULL
             WHERE space = ?1",
            [space],
        )?;
        c.execute(
            "DELETE FROM entries WHERE space = ?1 AND r_json IS NULL",
            [space],
        )?;
        Ok(())
    }

    /// Drop all rows of a space (uc rm).
    pub fn forget_space(&self, space: &str) -> Result<()> {
        self.lock()
            .execute("DELETE FROM entries WHERE space = ?1", [space])?;
        Ok(())
    }

    pub fn rows(&self, space: &str) -> Result<Vec<Row>> {
        let c = self.lock();
        let sql = format!("SELECT {COLS} FROM entries WHERE space = ?1 ORDER BY path");
        let mut st = c.prepare(&sql)?;
        let rows = st
            .query_map([space], read_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Rows of `space` whose path starts with `prefix` (e.g. "dir/"; "" = all).
    pub fn rows_prefix(&self, space: &str, prefix: &str) -> Result<Vec<Row>> {
        if prefix.is_empty() {
            return self.rows(space);
        }
        // an index range [prefix, prefix with its last char bumped) instead of a scan
        let mut upper: Vec<char> = prefix.chars().collect();
        let bumped = upper.last().and_then(|c| char::from_u32(*c as u32 + 1));
        let c = self.lock();
        let rows = match bumped {
            Some(b) => {
                if let Some(last) = upper.last_mut() {
                    *last = b;
                }
                let upper: String = upper.into_iter().collect();
                let sql = format!(
                    "SELECT {COLS} FROM entries WHERE space = ?1 AND path >= ?2 AND path < ?3 ORDER BY path"
                );
                let mut st = c.prepare(&sql)?;
                let rows = st.query_map(params![space, prefix, upper], read_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            None => {
                let sql = format!(
                    "SELECT {COLS} FROM entries WHERE space = ?1 AND substr(path, 1, ?3) = ?2 ORDER BY path"
                );
                let mut st = c.prepare(&sql)?;
                let n = prefix.chars().count() as i64;
                let rows = st.query_map(params![space, prefix, n], read_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(rows)
    }

    /// Rows whose remote version is newer than base (pending down). A remote tombstone for a
    /// path we never had is not pending.
    pub fn rows_behind(&self, space: Option<&str>) -> Result<Vec<Row>> {
        let c = self.lock();
        let sql = format!(
            "SELECT {COLS} FROM entries
             WHERE r_version IS NOT NULL
               AND (b_version IS NULL OR r_version > b_version)
               AND NOT (b_version IS NULL AND r_deleted = 1)
               AND (?1 IS NULL OR space = ?1)
             ORDER BY space, path"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st
            .query_map([space], read_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Number of live entries this machine has in sync for `space`.
    pub fn count_synced(&self, space: &str) -> Result<u64> {
        let n: i64 = self.lock().query_row(
            "SELECT COUNT(*) FROM entries WHERE space = ?1 AND b_version IS NOT NULL AND b_deleted = 0",
            [space],
            |r| r.get(0),
        )?;
        Ok(n as u64)
    }

    pub fn kv_get(&self, k: &str) -> Result<Option<String>> {
        kv_get_on(&self.lock(), k)
    }

    pub fn kv_set(&self, k: &str, v: &str) -> Result<()> {
        kv_set_on(&self.lock(), k, v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::Op;

    pub(crate) fn entry(space: &str, path: &str, version: u64, hash: &str, deleted: bool) -> Entry {
        Entry {
            space: space.into(),
            path: path.into(),
            kind: Kind::File,
            version,
            hash: hash.into(),
            size: 3,
            exec: false,
            mtime: 0,
            deleted,
            origin: "m_other".into(),
            meta: None,
            owner: None,
            owner_at: 0,
        }
    }

    fn change(seq: u64, e: Entry) -> Change {
        Change {
            seq,
            op: Op::Put,
            at: 0,
            entry: e,
            offset: None,
            len: None,
            inline: false,
        }
    }

    #[test]
    fn record_remote_is_idempotent_and_advances_cursor() {
        let db = ClientDb::open_in_memory().unwrap();
        assert_eq!(db.cursor().unwrap(), 0);
        db.record_remote(&change(3, entry("code", "a.txt", 3, "h3", false)))
            .unwrap();
        assert_eq!(db.cursor().unwrap(), 3);
        db.record_remote(&change(5, entry("code", "a.txt", 5, "h5", false)))
            .unwrap();
        // replay of an older change is ignored: R stays at v5, cursor at 5
        db.record_remote(&change(3, entry("code", "a.txt", 3, "h3", false)))
            .unwrap();
        let row = db.get("code", "a.txt").unwrap().unwrap();
        assert_eq!(row.remote.as_ref().unwrap().hash, "h5");
        assert_eq!(db.cursor().unwrap(), 5);
        // set_remote never regresses either
        db.set_remote(&entry("code", "a.txt", 4, "h4", false))
            .unwrap();
        assert_eq!(
            db.get("code", "a.txt")
                .unwrap()
                .unwrap()
                .remote
                .unwrap()
                .version,
            5
        );
    }

    #[test]
    fn base_roundtrip_and_behind() {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let db = ClientDb::open(&dir.path().join("client.db")).unwrap();
        db.record_remote(&change(1, entry("code", "a.txt", 1, "h1", false)))
            .unwrap();
        db.record_remote(&change(2, entry("code", "gone.txt", 2, "", true)))
            .unwrap();
        db.record_remote(&change(3, entry("code", "d/b.txt", 3, "hb", false)))
            .unwrap();
        let behind: Vec<String> = db
            .rows_behind(Some("code"))
            .unwrap()
            .into_iter()
            .map(|r| r.path)
            .collect();
        assert_eq!(behind, vec!["a.txt", "d/b.txt"]);

        let base = Base {
            version: 1,
            kind: Kind::File,
            hash: "h1".into(),
            size: 3,
            exec: true,
            deleted: false,
            fp: Some(LocalFp {
                size: 3,
                mtime_ns: 1_700_000_000_123_456_789,
                ino: u64::MAX - 1,
                exec: true,
            }),
            log: Some(LogPoint {
                local_len: 9,
                local_tail: "t".into(),
                native: "/x".into(),
            }),
        };
        db.set_base("code", "a.txt", Some(&base)).unwrap();
        assert_eq!(
            db.get("code", "a.txt").unwrap().unwrap().base.unwrap(),
            base
        );
        assert_eq!(db.rows_behind(None).unwrap().len(), 1);
        assert_eq!(db.count_synced("code").unwrap(), 1);
        assert_eq!(db.rows_prefix("code", "d/").unwrap().len(), 1);
        assert_eq!(db.rows_prefix("code", "").unwrap().len(), 3);
        db.set_remote(&entry("code", "d0.txt", 9, "x", false))
            .unwrap();
        db.set_remote(&entry("code", "dd/x", 9, "x", false))
            .unwrap();
        db.set_remote(&entry("code", "d/é/y", 9, "x", false))
            .unwrap();
        let under: Vec<String> = db
            .rows_prefix("code", "d/")
            .unwrap()
            .into_iter()
            .map(|r| r.path)
            .collect();
        assert_eq!(under, vec!["d/b.txt", "d/é/y"]);
        assert_eq!(db.rows_prefix("code", "d/é").unwrap().len(), 1);

        // base-only row disappears entirely when its base is cleared and R is unknown
        db.set_base("code", "local-only", Some(&base)).unwrap();
        db.set_base("code", "local-only", None).unwrap();
        assert!(db.get("code", "local-only").unwrap().is_none());

        db.kv_set("k", "v").unwrap();
        assert_eq!(db.kv_get("k").unwrap().as_deref(), Some("v"));
        db.forget_space("code").unwrap();
        assert!(db.rows("code").unwrap().is_empty());
        drop(db);
        // reopen: schema gate passes, cursor persisted
        let db = ClientDb::open(&dir.path().join("client.db")).unwrap();
        assert_eq!(db.cursor().unwrap(), 3);
    }

    #[test]
    fn newer_schema_is_refused() {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let p = dir.path().join("client.db");
        {
            let c = Connection::open(&p).unwrap();
            c.pragma_update(None, "user_version", 99).unwrap();
        }
        assert!(ClientDb::open(&p).is_err());
    }
}
