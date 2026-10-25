//! In-memory hub + client DB with the hub's log semantics (DESIGN §4.2, §6.4): offset + tail
//! CAS on append, single owner with an idle lease, explicit claims, Busy, LogReset, LogRead,
//! and a change stream per connected machine.

use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use super::deps::{BoxFut, LogHub, LogStore};
use crate::client::db::{Base, Row};
use crate::client::hubconn::Commit;
use crate::hash;
use crate::paths::now_ms;
use crate::proto::{
    Change, Entry, Kind, MachineInfo, Msg, Op, Query, SessionInfo, SessionMeta, INLINE_APPEND_MAX,
};

struct MEntry {
    e: Entry,
    data: Vec<u8>,
    claimed_by: Option<String>,
}

#[derive(Default)]
struct HubState {
    seq: u64,
    clock_offset: i64,
    entries: BTreeMap<(String, String), MEntry>,
    blobs: HashMap<String, Vec<u8>>,
    subs: Vec<mpsc::UnboundedSender<(Change, Vec<u8>)>>,
    names: HashMap<String, String>,
}

pub struct MockHub {
    st: Mutex<HubState>,
    pub lease_idle_ms: i64,
}

impl MockHub {
    pub fn new() -> Arc<MockHub> {
        Arc::new(MockHub {
            st: Mutex::new(HubState::default()),
            lease_idle_ms: 120_000,
        })
    }

    pub fn connect(
        self: &Arc<Self>,
        me: &MachineInfo,
    ) -> (Arc<MockClient>, mpsc::UnboundedReceiver<(Change, Vec<u8>)>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut st = self.st.lock().unwrap();
        st.subs.push(tx);
        st.names.insert(me.id.clone(), me.name.clone());
        let c = MockClient {
            hub: self.clone(),
            me: me.clone(),
            ids: AtomicU64::new(1),
            online: AtomicBool::new(true),
        };
        (Arc::new(c), rx)
    }

    /// Move the hub clock forward (lease expiry).
    pub fn advance(&self, ms: i64) {
        self.st.lock().unwrap().clock_offset += ms;
    }

    pub fn log(&self, space: &str, path: &str) -> Option<Vec<u8>> {
        let st = self.st.lock().unwrap();
        st.entries
            .get(&(space.into(), path.into()))
            .map(|m| m.data.clone())
    }

    pub fn entry(&self, space: &str, path: &str) -> Option<Entry> {
        let st = self.st.lock().unwrap();
        st.entries
            .get(&(space.into(), path.into()))
            .map(|m| m.e.clone())
    }

    pub fn paths(&self, space: &str) -> Vec<String> {
        let st = self.st.lock().unwrap();
        st.entries
            .keys()
            .filter(|k| k.0 == space)
            .map(|k| k.1.clone())
            .collect()
    }

    fn now(st: &HubState) -> i64 {
        now_ms() + st.clock_offset
    }

    fn emit(st: &mut HubState, change: Change, bin: Vec<u8>) {
        st.subs
            .retain(|tx| tx.send((change.clone(), bin.clone())).is_ok());
    }

    fn may_write(&self, st: &HubState, m: &MEntry, me: &str, claim: bool) -> bool {
        match &m.e.owner {
            None => true,
            Some(o) if o == me => true,
            Some(_) => {
                Self::now(st) - m.e.owner_at >= self.lease_idle_ms
                    || (claim && m.claimed_by.as_deref() == Some(me))
            }
        }
    }

    fn commit(&self, me: &MachineInfo, msg: Msg, bin: Vec<u8>) -> Result<Commit> {
        let mut st = self.st.lock().unwrap();
        let now = Self::now(&st);
        match msg {
            Msg::Append {
                space,
                path,
                offset,
                tail,
                meta,
                claim,
                ..
            } => {
                let key = (space.clone(), path.clone());
                if let Some(m) = st.entries.get(&key) {
                    let cur = Some(m.e.clone());
                    if !m.e.deleted {
                        if offset != m.e.size {
                            return Ok(Commit::Conflict {
                                current: cur,
                                reason: "offset".into(),
                            });
                        }
                        if offset > 0 && tail.as_deref() != Some(m.e.hash.as_str()) {
                            return Ok(Commit::Conflict {
                                current: cur,
                                reason: "tail".into(),
                            });
                        }
                    } else if offset != 0 {
                        return Ok(Commit::Conflict {
                            current: cur,
                            reason: "offset".into(),
                        });
                    }
                    if !self.may_write(&st, m, &me.id, claim) {
                        return Ok(Commit::Conflict {
                            current: cur,
                            reason: "owner".into(),
                        });
                    }
                } else if offset != 0 {
                    return Ok(Commit::Conflict {
                        current: None,
                        reason: "offset".into(),
                    });
                }
                if bin.is_empty() || bin.last() != Some(&b'\n') {
                    bail!("append must be complete lines");
                }
                if bin.len() > crate::proto::MAX_FRAME - 64 * 1024 {
                    bail!("frame too large");
                }
                st.seq += 1;
                let seq = st.seq;
                let m = st.entries.entry(key).or_insert_with(|| MEntry {
                    e: Entry {
                        space: space.clone(),
                        path: path.clone(),
                        kind: Kind::Log,
                        version: 0,
                        hash: String::new(),
                        size: 0,
                        exec: false,
                        mtime: 0,
                        deleted: false,
                        origin: String::new(),
                        meta: None,
                        owner: None,
                        owner_at: 0,
                    },
                    data: Vec::new(),
                    claimed_by: None,
                });
                if m.e.deleted {
                    m.data.clear();
                    m.e.deleted = false;
                }
                m.data.extend_from_slice(&bin);
                m.e.size = m.data.len() as u64;
                m.e.hash = hash::tail_fp(&m.data);
                m.e.version = seq;
                m.e.mtime = now;
                m.e.origin = me.id.clone();
                m.e.owner = Some(me.id.clone());
                m.e.owner_at = now;
                if meta.is_some() {
                    m.e.meta = meta;
                }
                let entry = m.e.clone();
                let inline = bin.len() <= INLINE_APPEND_MAX;
                let change = Change {
                    seq,
                    op: Op::Append,
                    at: now,
                    entry: entry.clone(),
                    offset: Some(offset),
                    len: Some(bin.len() as u64),
                    inline,
                };
                Self::emit(&mut st, change, if inline { bin } else { Vec::new() });
                Ok(Commit::Committed { seq, entry })
            }
            Msg::LogReset {
                space,
                path,
                base,
                hash: h,
                size,
                meta,
                ..
            } => {
                let key = (space, path);
                let blob = st
                    .blobs
                    .get(&h)
                    .cloned()
                    .ok_or_else(|| anyhow!("blob {h} missing"))?;
                if blob.len() as u64 != size {
                    bail!("size mismatch");
                }
                let Some(m) = st.entries.get(&key) else {
                    return Ok(Commit::Conflict {
                        current: None,
                        reason: "absent".into(),
                    });
                };
                if base != Some(m.e.version) {
                    return Ok(Commit::Conflict {
                        current: Some(m.e.clone()),
                        reason: "base".into(),
                    });
                }
                if !self.may_write(&st, m, &me.id, false) {
                    return Ok(Commit::Conflict {
                        current: Some(m.e.clone()),
                        reason: "owner".into(),
                    });
                }
                st.seq += 1;
                let seq = st.seq;
                let m = st.entries.get_mut(&key).unwrap();
                m.data = blob;
                m.e.size = size;
                m.e.hash = hash::tail_fp(&m.data);
                m.e.version = seq;
                m.e.origin = me.id.clone();
                m.e.owner = Some(me.id.clone());
                m.e.owner_at = now;
                if meta.is_some() {
                    m.e.meta = meta;
                }
                let entry = m.e.clone();
                let change = Change {
                    seq,
                    op: Op::Reset,
                    at: now,
                    entry: entry.clone(),
                    offset: None,
                    len: None,
                    inline: false,
                };
                Self::emit(&mut st, change, Vec::new());
                Ok(Commit::Committed { seq, entry })
            }
            Msg::Claim {
                space, path, force, ..
            } => {
                let key = (space, path);
                let Some(m) = st.entries.get(&key) else {
                    bail!("no such log")
                };
                if let Some(o) = m.e.owner.clone() {
                    let idle = now - m.e.owner_at;
                    if o != me.id && idle < self.lease_idle_ms && !force {
                        let owner_name = st.names.get(&o).cloned().unwrap_or_else(|| o.clone());
                        return Ok(Commit::Busy {
                            owner: o,
                            owner_name,
                            idle_ms: idle,
                        });
                    }
                }
                st.seq += 1;
                let seq = st.seq;
                let m = st.entries.get_mut(&key).unwrap();
                m.e.owner = Some(me.id.clone());
                m.e.owner_at = now;
                m.e.version = seq;
                m.e.origin = me.id.clone();
                m.claimed_by = Some(me.id.clone());
                let entry = m.e.clone();
                let change = Change {
                    seq,
                    op: Op::Claim,
                    at: now,
                    entry: entry.clone(),
                    offset: None,
                    len: None,
                    inline: false,
                };
                Self::emit(&mut st, change, Vec::new());
                Ok(Commit::Committed { seq, entry })
            }
            Msg::Put {
                space,
                path,
                base,
                kind,
                hash: h,
                size,
                exec,
                mtime,
                meta,
                ..
            } => {
                if !st.blobs.contains_key(&h) {
                    bail!("blob {h} missing");
                }
                let key = (space.clone(), path.clone());
                let cur = st.entries.get(&key).map(|m| m.e.clone());
                let ok = match &cur {
                    None => base.is_none(),
                    Some(e) if e.deleted => base.is_none() || base == Some(e.version),
                    Some(e) => base == Some(e.version),
                };
                if !ok {
                    return Ok(Commit::Conflict {
                        current: cur,
                        reason: "base".into(),
                    });
                }
                st.seq += 1;
                let seq = st.seq;
                let entry = Entry {
                    space,
                    path,
                    kind,
                    version: seq,
                    hash: h,
                    size,
                    exec,
                    mtime,
                    deleted: false,
                    origin: me.id.clone(),
                    meta,
                    owner: None,
                    owner_at: 0,
                };
                st.entries.insert(
                    key,
                    MEntry {
                        e: entry.clone(),
                        data: Vec::new(),
                        claimed_by: None,
                    },
                );
                let change = Change {
                    seq,
                    op: Op::Put,
                    at: now,
                    entry: entry.clone(),
                    offset: None,
                    len: None,
                    inline: false,
                };
                Self::emit(&mut st, change, Vec::new());
                Ok(Commit::Committed { seq, entry })
            }
            other => bail!("mock hub: unsupported mutation {other:?}"),
        }
    }

    fn query(&self, q: Query) -> Result<Value> {
        let st = self.st.lock().unwrap();
        let now = Self::now(&st);
        Ok(match q {
            Query::Entry { space, path } => {
                serde_json::to_value(st.entries.get(&(space, path)).map(|m| m.e.clone()))?
            }
            Query::Entries { space, prefix } => {
                let v: Vec<Entry> = st
                    .entries
                    .values()
                    .filter(|m| m.e.space == space && !m.e.deleted)
                    .filter(|m| prefix.as_deref().map_or(true, |p| m.e.path.starts_with(p)))
                    .map(|m| m.e.clone())
                    .collect();
                serde_json::to_value(v)?
            }
            Query::Sessions {
                agent, text, limit, ..
            } => {
                let mut v: Vec<SessionInfo> = st
                    .entries
                    .values()
                    .filter_map(|m| {
                        let meta = SessionMeta::from_meta(m.e.meta.as_ref()?)?;
                        if agent.as_deref().is_some_and(|a| a != meta.agent) {
                            return None;
                        }
                        if let Some(t) = &text {
                            let t = t.to_lowercase();
                            let hay = format!(
                                "{} {} {} {}",
                                meta.id,
                                meta.title.clone().unwrap_or_default(),
                                meta.first_prompt.clone().unwrap_or_default(),
                                meta.cwd.clone().unwrap_or_default()
                            )
                            .to_lowercase();
                            if !hay.contains(&t) {
                                return None;
                            }
                        }
                        let idle_ms = now - m.e.owner_at;
                        Some(SessionInfo {
                            space: m.e.space.clone(),
                            path: m.e.path.clone(),
                            owner: m.e.owner.clone(),
                            owner_name: m.e.owner.as_ref().and_then(|o| st.names.get(o).cloned()),
                            live: m.e.owner.is_some() && idle_ms < self.lease_idle_ms,
                            idle_ms,
                            size: m.e.size,
                            version: m.e.version,
                            local_cwd: None,
                            local: false,
                            meta,
                        })
                    })
                    .collect();
                v.sort_by_key(|s| std::cmp::Reverse(s.meta.updated_at));
                v.truncate(limit.unwrap_or(1000) as usize);
                serde_json::to_value(v)?
            }
            other => bail!("mock hub: unsupported query {other:?}"),
        })
    }
}

pub struct MockClient {
    hub: Arc<MockHub>,
    me: MachineInfo,
    ids: AtomicU64,
    pub online: AtomicBool,
}

impl MockClient {
    fn check(&self) -> Result<()> {
        if self.online.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(anyhow!("not connected to hub"))
        }
    }
}

impl LogHub for MockClient {
    fn next_id(&self) -> u64 {
        self.ids.fetch_add(1, Ordering::SeqCst)
    }
    fn is_connected(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }
    fn commit(&self, msg: Msg, bin: Vec<u8>) -> BoxFut<'_, Result<Commit>> {
        Box::pin(async move {
            self.check()?;
            self.hub.commit(&self.me, msg, bin)
        })
    }
    fn read_log<'a>(
        &'a self,
        space: &'a str,
        path: &'a str,
        offset: u64,
        len: u64,
    ) -> BoxFut<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            self.check()?;
            let data = self
                .hub
                .log(space, path)
                .ok_or_else(|| anyhow!("no such log"))?;
            let start = (offset as usize).min(data.len());
            let end = (offset.saturating_add(len) as usize).min(data.len());
            Ok(data[start..end].to_vec())
        })
    }
    fn query(&self, q: Query) -> BoxFut<'_, Result<Value>> {
        Box::pin(async move {
            self.check()?;
            self.hub.query(q)
        })
    }
    fn upload_bytes<'a>(&'a self, data: &'a [u8], h: &'a str) -> BoxFut<'a, Result<()>> {
        Box::pin(async move {
            self.check()?;
            if hash::hash_bytes(data) != h {
                bail!("blob hash mismatch");
            }
            self.hub
                .st
                .lock()
                .unwrap()
                .blobs
                .insert(h.to_string(), data.to_vec());
            Ok(())
        })
    }
    fn download_blob<'a>(&'a self, h: &'a str, dest: &'a Path) -> BoxFut<'a, Result<()>> {
        Box::pin(async move {
            self.check()?;
            let data = self
                .hub
                .st
                .lock()
                .unwrap()
                .blobs
                .get(h)
                .cloned()
                .ok_or_else(|| anyhow!("no blob"))?;
            std::fs::write(dest, data)?;
            Ok(())
        })
    }
}

/// ClientDb semantics in memory.
#[derive(Default)]
pub struct MemStore {
    rows: Mutex<BTreeMap<(String, String), Row>>,
    kv: Mutex<HashMap<String, String>>,
    cursor: AtomicU64,
}

impl LogStore for MemStore {
    fn get(&self, space: &str, path: &str) -> Result<Option<Row>> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .get(&(space.into(), path.into()))
            .cloned())
    }
    fn record_remote(&self, change: &Change) -> Result<()> {
        self.set_remote(&change.entry)?;
        self.cursor.fetch_max(change.seq, Ordering::SeqCst);
        Ok(())
    }
    fn set_remote(&self, entry: &Entry) -> Result<()> {
        let mut rows = self.rows.lock().unwrap();
        let row = rows
            .entry((entry.space.clone(), entry.path.clone()))
            .or_insert_with(|| Row {
                space: entry.space.clone(),
                path: entry.path.clone(),
                ..Default::default()
            });
        row.remote = Some(entry.clone());
        Ok(())
    }
    fn set_base(&self, space: &str, path: &str, base: Option<&Base>) -> Result<()> {
        let mut rows = self.rows.lock().unwrap();
        let row = rows
            .entry((space.into(), path.into()))
            .or_insert_with(|| Row {
                space: space.into(),
                path: path.into(),
                ..Default::default()
            });
        row.base = base.cloned();
        Ok(())
    }
    fn rows(&self, space: &str) -> Result<Vec<Row>> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .values()
            .filter(|r| r.space == space)
            .cloned()
            .collect())
    }
    fn kv_get(&self, k: &str) -> Result<Option<String>> {
        Ok(self.kv.lock().unwrap().get(k).cloned())
    }
    fn kv_set(&self, k: &str, v: &str) -> Result<()> {
        self.kv.lock().unwrap().insert(k.into(), v.into());
        Ok(())
    }
}
