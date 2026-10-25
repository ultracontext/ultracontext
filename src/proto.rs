//! Wire protocol shared by hub, daemon and CLI (DESIGN §4).
//!
//! A stream starts with `MAGIC` from both sides; everything before the magic is
//! discarded (ssh login banners, shell rc noise). Then frames:
//! `u32 total_len | u32 json_len | json | binary`.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAGIC: &[u8; 8] = b"UCPROTO1";
pub const PROTO_VERSION: u32 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Max frame size (json + binary).
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
/// Blob transfer chunk size.
pub const CHUNK: usize = 4 * 1024 * 1024;
/// Append data up to this size is pushed inline with the `Change`.
pub const INLINE_APPEND_MAX: usize = 1024 * 1024;
/// Max garbage bytes skipped before the magic.
const MAX_PREAMBLE: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Symlink,
    Log,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Put,
    Delete,
    Append,
    Reset,
    Claim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineInfo {
    pub id: String,
    pub name: String,
    /// "macos" | "linux"
    pub os: String,
    /// $HOME on that machine
    pub home: String,
}

/// State of one synced thing on the hub (DESIGN §3.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub space: String,
    pub path: String,
    pub kind: Kind,
    /// seq of the last change to this entry
    pub version: u64,
    /// file/symlink: blake3 hex of content. log: blake3 hex of last <=4096 bytes.
    pub hash: String,
    pub size: u64,
    #[serde(default)]
    pub exec: bool,
    /// ms since epoch, reported by origin
    #[serde(default)]
    pub mtime: i64,
    #[serde(default)]
    pub deleted: bool,
    /// machine id of the last writer
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// logs only: machine id of the single writer (DESIGN §6.4)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// logs only: ms of the owner's last activity (append or claim)
    #[serde(default)]
    pub owner_at: i64,
}

/// One accepted mutation, as replicated to subscribers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub seq: u64,
    pub op: Op,
    /// hub clock, ms since epoch
    pub at: i64,
    /// entry state AFTER this change
    pub entry: Entry,
    /// append: offset at which the appended bytes start
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// append: number of bytes appended
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub len: Option<u64>,
    /// append: the appended bytes are attached as the frame's binary part
    #[serde(default)]
    pub inline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "q", rename_all = "snake_case")]
pub enum Query {
    /// All sessions (entries with meta.session), newest first. Result: Vec<SessionInfo>
    Sessions {
        #[serde(default)]
        agent: Option<String>,
        /// machine id or name (owner)
        #[serde(default)]
        machine: Option<String>,
        /// case-insensitive substring over id/title/first_prompt/cwd
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// Recent changes, newest first. Result: Vec<LogRecord>
    Log {
        #[serde(default)]
        space: Option<String>,
        /// exact path or prefix ending in '/'
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        since_ms: Option<i64>,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// Versions of one path, newest first. Result: Vec<LogRecord>
    History {
        space: String,
        path: String,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// Result: Option<Entry>
    Entry { space: String, path: String },
    /// Live (non-deleted) entries of a space, optional path prefix. Result: Vec<Entry>
    Entries {
        space: String,
        #[serde(default)]
        prefix: Option<String>,
    },
    /// Result: Vec<SpaceInfo>
    Spaces,
    /// Result: Vec<MachineRecord>
    Machines,
    /// Result: HubStatus
    Status,
}

/// One row of the hub change log, for `uc log` / `uc history`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogRecord {
    pub seq: u64,
    pub op: Op,
    pub at: i64,
    pub space: String,
    pub path: String,
    pub kind: Kind,
    pub hash: String,
    pub size: u64,
    pub origin: String,
    #[serde(default)]
    pub origin_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpaceInfo {
    pub name: String,
    /// home-relative default path, e.g. "~/Code"
    pub default_path: String,
    pub created_at: i64,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineRecord {
    pub info: MachineInfo,
    pub last_seen: i64,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HubStatus {
    pub hub_id: String,
    pub version: String,
    pub head_seq: u64,
    pub machines: Vec<MachineRecord>,
    pub spaces: Vec<SpaceInfo>,
    pub blobs: u64,
    pub blob_bytes: u64,
}

/// Session metadata carried in `Entry.meta["session"]` (DESIGN §6.3).
/// Paths (cwd) are canonical (tokenized, see pathmap).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    /// "claude" | "codex"
    pub agent: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    /// ms since epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// driver-specific native relative path hint (e.g. codex "sessions/2026/10/25/rollout-...jsonl")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_rel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<String>,
    /// number of transcript lines (approximate, informational)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
}

impl SessionMeta {
    pub fn to_meta(&self) -> Value {
        serde_json::json!({ "session": self })
    }
    pub fn from_meta(meta: &Value) -> Option<SessionMeta> {
        serde_json::from_value(meta.get("session")?.clone()).ok()
    }
}

/// A session as listed by `uc sessions` (hub fills everything but `local_cwd`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub space: String,
    pub path: String,
    pub meta: SessionMeta,
    /// owner machine id / name (last writer)
    pub owner: Option<String>,
    pub owner_name: Option<String>,
    /// owner appended within the lease window (DESIGN §6.4)
    pub live: bool,
    pub idle_ms: i64,
    pub size: u64,
    pub version: u64,
    /// filled by the daemon: cwd translated for this machine
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_cwd: Option<String>,
    /// filled by the daemon: transcript present locally
    #[serde(default)]
    pub local: bool,
}

/// Control API between the CLI and the local daemon (over daemon.sock).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Ctl {
    /// Result: StatusReport
    Status,
    /// Full rescan, then wait until nothing is pending (or timeout). Result: SyncReport
    Sync { timeout_ms: u64 },
    /// Pass-through hub query; for Sessions the daemon fills local_cwd/local. Result: per Query
    Query { query: Query },
    /// Start syncing a folder as space `name` (absolute path). Creates the space on the hub if new.
    /// Result: SpaceStatus
    AddSpace { name: String, path: String },
    /// Stop syncing a space on this machine (files kept). Result: null
    RmSpace { name: String },
    /// Materialize + claim a session. `id` may be a prefix. Result: ResumePlan (or error code "busy")
    Resume {
        #[serde(default)]
        agent: Option<String>,
        id: String,
        #[serde(default)]
        takeover: bool,
        #[serde(default)]
        fork: bool,
    },
    /// Restore `path` to the content it had at `seq` (pushed as a new change). Result: null
    Restore { space: String, path: String, seq: u64 },
    /// Re-read config.toml. Result: null
    Reload,
    /// Stop the daemon. Result: null
    Shutdown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SpaceStatus {
    pub name: String,
    pub path: String,
    pub files: u64,
    pub pending_up: u64,
    pub pending_down: u64,
    #[serde(default)]
    pub case_collisions: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StatusReport {
    pub machine: Option<MachineInfo>,
    pub hub: String,
    pub connected: bool,
    pub hub_version: Option<String>,
    pub cursor: u64,
    pub head_seq: u64,
    pub spaces: Vec<SpaceStatus>,
    pub pending_up: u64,
    pub pending_down: u64,
    pub conflicts: Vec<String>,
    pub sessions_live: Vec<SessionInfo>,
    pub last_error: Option<String>,
    pub daemon_pid: u32,
    pub daemon_version: String,
    pub uptime_s: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SyncReport {
    pub ok: bool,
    pub timed_out: bool,
    pub pending_up: u64,
    pub pending_down: u64,
    pub conflicts: Vec<String>,
    pub head_seq: u64,
    pub cursor: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ResumePlan {
    pub agent: String,
    pub id: String,
    /// local working directory to run the agent in
    pub cwd: String,
    /// full argv, e.g. ["claude","--resume","<id>"]
    pub argv: Vec<String>,
    /// local transcript path
    pub native_path: String,
    pub took_over: bool,
    /// set when --fork: the new session id
    pub forked_to: Option<String>,
    /// the cwd does not exist on this machine
    pub cwd_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    // ---- handshake
    Hello {
        id: u64,
        proto: u32,
        machine: MachineInfo,
        version: String,
        #[serde(default)]
        token: Option<String>,
    },
    Welcome {
        re: u64,
        hub_id: String,
        head_seq: u64,
        version: String,
    },
    // ---- replication
    Subscribe {
        id: u64,
        since: u64,
    },
    Change(Change),
    CaughtUp {
        seq: u64,
    },
    // ---- blobs
    HasBlobs {
        id: u64,
        hashes: Vec<String>,
    },
    Missing {
        re: u64,
        hashes: Vec<String>,
    },
    /// binary = chunk bytes at `offset`; `last` closes and verifies the blob
    BlobPut {
        id: u64,
        hash: String,
        offset: u64,
        last: bool,
    },
    BlobGet {
        id: u64,
        hash: String,
        offset: u64,
        len: u64,
    },
    /// binary = bytes at `offset`
    Blob {
        re: u64,
        offset: u64,
        eof: bool,
    },
    // ---- mutations
    Put {
        id: u64,
        space: String,
        path: String,
        base: Option<u64>,
        kind: Kind,
        hash: String,
        size: u64,
        exec: bool,
        mtime: i64,
        #[serde(default)]
        meta: Option<Value>,
    },
    Delete {
        id: u64,
        space: String,
        path: String,
        base: u64,
    },
    /// binary = appended bytes (complete lines)
    Append {
        id: u64,
        space: String,
        path: String,
        offset: u64,
        /// tail fingerprint of the hub content up to `offset` (None when offset == 0)
        #[serde(default)]
        tail: Option<String>,
        #[serde(default)]
        meta: Option<Value>,
        #[serde(default)]
        claim: bool,
    },
    /// Replace a log's whole content with blob `hash` (must be uploaded). Owner only.
    LogReset {
        id: u64,
        space: String,
        path: String,
        base: Option<u64>,
        hash: String,
        size: u64,
        #[serde(default)]
        meta: Option<Value>,
    },
    LogRead {
        id: u64,
        space: String,
        path: String,
        offset: u64,
        len: u64,
    },
    /// Take ownership of a log. Sent by the current owner it is a lease heartbeat (no log row).
    Claim {
        id: u64,
        space: String,
        path: String,
        force: bool,
    },
    /// The owner's agent is still working on the session: refresh the lease (never acquires
    /// it). Answered with Ok; no-op unless the sender is the owner.
    Heartbeat {
        id: u64,
        space: String,
        path: String,
    },
    /// The owner's agent stopped running the session: drop the lease so another machine can
    /// continue it without a takeover (DESIGN §6.4). Answered with Ok; no-op for non-owners.
    Release {
        id: u64,
        space: String,
        path: String,
    },
    SpaceCreate {
        id: u64,
        name: String,
        default_path: String,
    },
    Query {
        id: u64,
        query: Query,
    },
    // ---- responses
    Ok {
        re: u64,
    },
    Committed {
        re: u64,
        seq: u64,
        entry: Entry,
    },
    Conflict {
        re: u64,
        current: Option<Entry>,
        reason: String,
    },
    Busy {
        re: u64,
        owner: String,
        owner_name: String,
        idle_ms: i64,
    },
    Result {
        re: u64,
        data: Value,
    },
    Error {
        #[serde(default)]
        re: Option<u64>,
        code: String,
        msg: String,
    },
    Ping {
        id: u64,
    },
    Pong {
        re: u64,
    },
    // ---- control API (CLI <-> daemon)
    Ctl {
        id: u64,
        cmd: Ctl,
    },
}

impl Msg {
    /// Request id (for requests).
    pub fn id(&self) -> Option<u64> {
        use Msg::*;
        match self {
            Hello { id, .. }
            | Subscribe { id, .. }
            | HasBlobs { id, .. }
            | BlobPut { id, .. }
            | BlobGet { id, .. }
            | Put { id, .. }
            | Delete { id, .. }
            | Append { id, .. }
            | LogReset { id, .. }
            | LogRead { id, .. }
            | Claim { id, .. }
            | Release { id, .. }
            | Heartbeat { id, .. }
            | SpaceCreate { id, .. }
            | Query { id, .. }
            | Ping { id }
            | Ctl { id, .. } => Some(*id),
            _ => None,
        }
    }

    /// Correlation id (for responses).
    pub fn re(&self) -> Option<u64> {
        use Msg::*;
        match self {
            Welcome { re, .. }
            | Missing { re, .. }
            | Blob { re, .. }
            | Ok { re }
            | Committed { re, .. }
            | Conflict { re, .. }
            | Busy { re, .. }
            | Result { re, .. }
            | Pong { re } => Some(*re),
            Error { re, .. } => *re,
            _ => None,
        }
    }

    pub fn error(re: Option<u64>, code: &str, msg: impl Into<String>) -> Msg {
        Msg::Error {
            re,
            code: code.to_string(),
            msg: msg.into(),
        }
    }
}

/// A decoded frame.
#[derive(Debug, Clone)]
pub struct Frame {
    pub msg: Msg,
    pub bin: Vec<u8>,
}

pub async fn write_magic<W: AsyncWrite + Unpin>(w: &mut W) -> Result<()> {
    w.write_all(MAGIC).await?;
    w.flush().await?;
    Ok(())
}

/// Read until the magic has been seen, discarding any preamble garbage.
pub async fn read_magic<R: AsyncRead + Unpin>(r: &mut R) -> Result<()> {
    let mut window: Vec<u8> = Vec::with_capacity(MAGIC.len());
    let mut skipped = 0usize;
    let mut byte = [0u8; 1];
    loop {
        let n = r.read(&mut byte).await?;
        if n == 0 {
            bail!("connection closed before protocol handshake (is `uc` installed on the hub host?)");
        }
        window.push(byte[0]);
        if window.len() > MAGIC.len() {
            window.remove(0);
            skipped += 1;
            if skipped > MAX_PREAMBLE {
                bail!("no protocol magic within {MAX_PREAMBLE} bytes");
            }
        }
        if window.as_slice() == MAGIC {
            return Ok(());
        }
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, msg: &Msg, bin: &[u8]) -> Result<()> {
    let json = serde_json::to_vec(msg)?;
    let total = 4 + json.len() + bin.len();
    if total > MAX_FRAME {
        bail!("frame too large: {total} bytes");
    }
    let mut buf = Vec::with_capacity(8 + json.len() + bin.len());
    buf.extend_from_slice(&(total as u32).to_be_bytes());
    buf.extend_from_slice(&(json.len() as u32).to_be_bytes());
    buf.extend_from_slice(&json);
    buf.extend_from_slice(bin);
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

/// Read one frame. `Ok(None)` on clean EOF at a frame boundary.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Frame>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let total = u32::from_be_bytes(len) as usize;
    if !(4..=MAX_FRAME).contains(&total) {
        bail!("bad frame length {total}");
    }
    let mut body = vec![0u8; total];
    r.read_exact(&mut body).await.context("truncated frame")?;
    let json_len = u32::from_be_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if 4 + json_len > total {
        bail!("bad json length {json_len}");
    }
    let msg: Msg = serde_json::from_slice(&body[4..4 + json_len]).context("bad frame json")?;
    let bin = body[4 + json_len..].to_vec();
    Ok(Some(Frame { msg, bin }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_roundtrip_with_garbage_preamble() {
        let mut buf: Vec<u8> = b"Last login: Mon\nwelcome!\n".to_vec();
        write_magic(&mut buf).await.unwrap();
        let msg = Msg::Append {
            id: 7,
            space: "@claude".into(),
            path: "sessions/abc.jsonl".into(),
            offset: 10,
            tail: Some("ff".into()),
            meta: None,
            claim: false,
        };
        write_frame(&mut buf, &msg, b"{\"a\":1}\n").await.unwrap();
        let mut r = &buf[..];
        read_magic(&mut r).await.unwrap();
        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(f.msg.id(), Some(7));
        assert_eq!(f.bin, b"{\"a\":1}\n");
        assert!(read_frame(&mut r).await.unwrap().is_none());
    }

    #[test]
    fn change_is_internally_tagged() {
        let c = Change {
            seq: 3,
            op: Op::Put,
            at: 1,
            entry: Entry {
                space: "code".into(),
                path: "a.txt".into(),
                kind: Kind::File,
                version: 3,
                hash: "h".into(),
                size: 1,
                exec: false,
                mtime: 0,
                deleted: false,
                origin: "m1".into(),
                meta: None,
                owner: None,
                owner_at: 0,
            },
            offset: None,
            len: None,
            inline: false,
        };
        let s = serde_json::to_string(&Msg::Change(c.clone())).unwrap();
        assert!(s.contains("\"t\":\"change\""));
        match serde_json::from_str::<Msg>(&s).unwrap() {
            Msg::Change(c2) => assert_eq!(c, c2),
            _ => panic!(),
        }
    }
}
