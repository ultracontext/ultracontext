//! In-process fake hub for client tests: speaks the real wire protocol (§4) over in-memory
//! duplex streams and implements enough of the hub's semantics (log, entries, blobs, base
//! checks, subscriptions) to drive HubClient and Engine end to end.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use super::{ConnectFuture, Connector};
use crate::proto::{self, Change, Entry, Kind, LogRecord, Msg, Op, Query, SpaceInfo};
use crate::transport::Conn;

type Out = mpsc::UnboundedSender<(Msg, Vec<u8>)>;

#[derive(Default)]
struct State {
    seq: u64,
    entries: HashMap<(String, String), Entry>,
    log: Vec<Change>,
    blobs: HashMap<String, Vec<u8>>,
    partial: HashMap<String, Vec<u8>>,
    spaces: Vec<SpaceInfo>,
    subscribers: Vec<Out>,
    sessions: Vec<AbortHandle>,
    connections: usize,
    last_token: Option<String>,
    hang_queries: bool,
}

#[derive(Clone, Default)]
pub struct FakeHub {
    st: Arc<Mutex<State>>,
}

pub fn file_entry(space: &str, path: &str, hash: &str, version: u64) -> Entry {
    Entry {
        space: space.into(),
        path: path.into(),
        kind: Kind::File,
        version,
        hash: hash.into(),
        size: 0,
        exec: false,
        mtime: 0,
        deleted: false,
        origin: "m_fake".into(),
        meta: None,
        owner: None,
        owner_at: 0,
    }
}

impl FakeHub {
    pub fn new() -> FakeHub {
        FakeHub::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn connector(&self) -> Connector {
        let hub = self.clone();
        Arc::new(move || -> ConnectFuture {
            let hub = hub.clone();
            Box::pin(async move {
                let (client, server) = tokio::io::duplex(1 << 20);
                let h2 = hub.clone();
                let task = tokio::spawn(async move {
                    let _ = h2.serve(server).await;
                });
                hub.lock().sessions.push(task.abort_handle());
                let (r, w) = tokio::io::split(client);
                Ok(Conn {
                    reader: Box::new(r),
                    writer: Box::new(w),
                    child: None,
                })
            })
        })
    }

    pub fn connections(&self) -> usize {
        self.lock().connections
    }

    pub fn last_hello_token(&self) -> Option<String> {
        self.lock().last_token.clone()
    }

    pub fn hang_queries(&self, on: bool) {
        self.lock().hang_queries = on;
    }

    /// Kill every live session (clients see EOF).
    pub fn drop_connections(&self) {
        let mut st = self.lock();
        for s in st.sessions.drain(..) {
            s.abort();
        }
        st.subscribers.clear();
    }

    pub fn entry(&self, space: &str, path: &str) -> Option<Entry> {
        self.lock()
            .entries
            .get(&(space.to_string(), path.to_string()))
            .cloned()
    }

    pub fn blob(&self, hash: &str) -> Option<Vec<u8>> {
        self.lock().blobs.get(hash).cloned()
    }

    /// Commit a put as if another machine did it (no blob needed).
    pub fn inject_put(&self, mut e: Entry) -> u64 {
        let mut st = self.lock();
        st.seq += 1;
        e.version = st.seq;
        let c = Change {
            seq: st.seq,
            op: Op::Put,
            at: 0,
            entry: e.clone(),
            offset: None,
            len: None,
            inline: false,
        };
        st.entries.insert((e.space.clone(), e.path.clone()), e);
        broadcast(&mut st, c);
        st.seq
    }

    /// Commit a delete as if machine `origin` did it.
    pub fn inject_delete(&self, space: &str, path: &str, origin: &str) -> u64 {
        let mut st = self.lock();
        let key = (space.to_string(), path.to_string());
        let Some(cur) = st.entries.get(&key).cloned() else {
            return st.seq;
        };
        st.seq += 1;
        let e = Entry {
            version: st.seq,
            hash: String::new(),
            size: 0,
            deleted: true,
            origin: origin.into(),
            ..cur
        };
        let c = Change {
            seq: st.seq,
            op: Op::Delete,
            at: 0,
            entry: e.clone(),
            offset: None,
            len: None,
            inline: false,
        };
        st.entries.insert(key, e);
        broadcast(&mut st, c);
        st.seq
    }

    /// Store `data` and commit it at `space/path` from machine `origin`.
    pub fn inject_file(&self, space: &str, path: &str, data: &[u8], origin: &str) -> u64 {
        let hash = crate::hash::hash_bytes(data);
        self.lock().blobs.insert(hash.clone(), data.to_vec());
        let mut e = file_entry(space, path, &hash, 0);
        e.size = data.len() as u64;
        e.origin = origin.into();
        self.inject_put(e)
    }

    async fn serve(self, stream: tokio::io::DuplexStream) -> Result<()> {
        let (mut r, mut w) = tokio::io::split(stream);
        proto::read_magic(&mut r).await?;
        proto::write_magic(&mut w).await?;
        let Some(f) = proto::read_frame(&mut r).await? else {
            return Ok(());
        };
        let Msg::Hello {
            id, machine, token, ..
        } = f.msg
        else {
            anyhow::bail!("expected hello");
        };
        let head = {
            let mut st = self.lock();
            st.connections += 1;
            st.last_token = token;
            st.seq
        };
        let welcome = Msg::Welcome {
            re: id,
            hub_id: "h_fake".into(),
            head_seq: head,
            version: "test".into(),
        };
        proto::write_frame(&mut w, &welcome, &[]).await?;
        let (tx, mut rx) = mpsc::unbounded_channel::<(Msg, Vec<u8>)>();
        let writer = tokio::spawn(async move {
            while let Some((m, b)) = rx.recv().await {
                if proto::write_frame(&mut w, &m, &b).await.is_err() {
                    break;
                }
            }
        });
        // the writer dies with this session (abort of serve drops it via the guard below)
        struct Guard(AbortHandle);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _g = Guard(writer.abort_handle());
        while let Some(f) = proto::read_frame(&mut r).await? {
            self.handle(&machine.id, f.msg, f.bin, &tx);
        }
        Ok(())
    }

    fn handle(&self, origin: &str, msg: Msg, bin: Vec<u8>, tx: &Out) {
        let mut st = self.lock();
        let reply = |m: Msg, b: Vec<u8>| {
            let _ = tx.send((m, b));
        };
        match msg {
            Msg::Ping { id } => reply(Msg::Pong { re: id }, vec![]),
            Msg::Subscribe { since, .. } => {
                for c in st.log.iter().filter(|c| c.seq > since) {
                    reply(Msg::Change(c.clone()), vec![]);
                }
                reply(Msg::CaughtUp { seq: st.seq }, vec![]);
                st.subscribers.push(tx.clone());
            }
            Msg::HasBlobs { id, hashes } => {
                let missing = hashes
                    .into_iter()
                    .filter(|h| !st.blobs.contains_key(h))
                    .collect();
                reply(
                    Msg::Missing {
                        re: id,
                        hashes: missing,
                    },
                    vec![],
                );
            }
            Msg::BlobPut {
                id,
                hash,
                offset,
                last,
            } => {
                let buf = st.partial.entry(hash.clone()).or_default();
                if buf.len() as u64 != offset {
                    reply(
                        Msg::error(Some(id), "bad_offset", "unexpected offset"),
                        vec![],
                    );
                    return;
                }
                buf.extend_from_slice(&bin);
                if last {
                    let data = st.partial.remove(&hash).unwrap_or_default();
                    if crate::hash::hash_bytes(&data) != hash {
                        reply(
                            Msg::error(Some(id), "hash_mismatch", "blob hash mismatch"),
                            vec![],
                        );
                        return;
                    }
                    st.blobs.insert(hash, data);
                }
                reply(Msg::Ok { re: id }, vec![]);
            }
            Msg::BlobGet {
                id,
                hash,
                offset,
                len,
            } => match st.blobs.get(&hash) {
                Some(data) => {
                    let start = (offset as usize).min(data.len());
                    let end = (start + len as usize).min(data.len());
                    let eof = end == data.len();
                    reply(
                        Msg::Blob {
                            re: id,
                            offset,
                            eof,
                        },
                        data[start..end].to_vec(),
                    );
                }
                None => reply(Msg::error(Some(id), "not_found", "no such blob"), vec![]),
            },
            Msg::Put {
                id,
                space,
                path,
                base,
                kind,
                hash,
                size,
                exec,
                mtime,
                meta,
            } => {
                if !st.blobs.contains_key(&hash) {
                    reply(
                        Msg::error(Some(id), "missing_blob", "upload the blob first"),
                        vec![],
                    );
                    return;
                }
                let key = (space.clone(), path.clone());
                let cur = st.entries.get(&key).cloned();
                let ok = match (&cur, base) {
                    (None, None) => true,
                    (Some(c), None) => c.deleted,
                    (Some(c), Some(b)) => c.version == b,
                    (None, Some(_)) => false,
                };
                if !ok {
                    reply(
                        Msg::Conflict {
                            re: id,
                            current: cur,
                            reason: "base mismatch".into(),
                        },
                        vec![],
                    );
                    return;
                }
                st.seq += 1;
                let e = Entry {
                    space,
                    path,
                    kind,
                    version: st.seq,
                    hash,
                    size,
                    exec,
                    mtime,
                    deleted: false,
                    origin: origin.to_string(),
                    meta,
                    owner: None,
                    owner_at: 0,
                };
                let c = Change {
                    seq: st.seq,
                    op: Op::Put,
                    at: 0,
                    entry: e.clone(),
                    offset: None,
                    len: None,
                    inline: false,
                };
                st.entries.insert(key, e.clone());
                reply(
                    Msg::Committed {
                        re: id,
                        seq: st.seq,
                        entry: e,
                    },
                    vec![],
                );
                broadcast(&mut st, c);
            }
            Msg::Delete {
                id,
                space,
                path,
                base,
            } => {
                let key = (space, path);
                let cur = st.entries.get(&key).cloned();
                match cur {
                    Some(c) if !c.deleted && c.version == base => {
                        st.seq += 1;
                        let e = Entry {
                            version: st.seq,
                            hash: String::new(),
                            size: 0,
                            deleted: true,
                            origin: origin.to_string(),
                            ..c
                        };
                        let ch = Change {
                            seq: st.seq,
                            op: Op::Delete,
                            at: 0,
                            entry: e.clone(),
                            offset: None,
                            len: None,
                            inline: false,
                        };
                        st.entries.insert(key, e.clone());
                        reply(
                            Msg::Committed {
                                re: id,
                                seq: st.seq,
                                entry: e,
                            },
                            vec![],
                        );
                        broadcast(&mut st, ch);
                    }
                    cur => reply(
                        Msg::Conflict {
                            re: id,
                            current: cur,
                            reason: "base mismatch".into(),
                        },
                        vec![],
                    ),
                }
            }
            Msg::SpaceCreate {
                id,
                name,
                default_path,
            } => {
                if !st.spaces.iter().any(|s| s.name == name) {
                    st.spaces.push(SpaceInfo {
                        name: name.clone(),
                        default_path,
                        created_at: 0,
                        files: 0,
                        bytes: 0,
                    });
                }
                let e = file_entry(&name, "", "", st.seq);
                reply(
                    Msg::Committed {
                        re: id,
                        seq: st.seq,
                        entry: e,
                    },
                    vec![],
                );
            }
            Msg::Query { id, query } => {
                if st.hang_queries {
                    return;
                }
                let data = match query {
                    Query::Spaces => serde_json::to_value(&st.spaces).ok(),
                    Query::Entries { space, prefix } => {
                        let mut v: Vec<&Entry> = st
                            .entries
                            .values()
                            .filter(|e| e.space == space && !e.deleted)
                            .filter(|e| prefix.as_deref().map_or(true, |p| e.path.starts_with(p)))
                            .collect();
                        v.sort_by(|a, b| a.path.cmp(&b.path));
                        serde_json::to_value(v).ok()
                    }
                    Query::Entry { space, path } => {
                        serde_json::to_value(st.entries.get(&(space, path))).ok()
                    }
                    Query::History { space, path, .. } => {
                        let v: Vec<LogRecord> = st
                            .log
                            .iter()
                            .rev()
                            .filter(|c| c.entry.space == space && c.entry.path == path)
                            .map(|c| LogRecord {
                                seq: c.seq,
                                op: c.op,
                                at: c.at,
                                space: c.entry.space.clone(),
                                path: c.entry.path.clone(),
                                kind: c.entry.kind,
                                hash: c.entry.hash.clone(),
                                size: c.entry.size,
                                origin: c.entry.origin.clone(),
                                origin_name: String::new(),
                            })
                            .collect();
                        serde_json::to_value(v).ok()
                    }
                    _ => None,
                };
                match data {
                    Some(data) => reply(Msg::Result { re: id, data }, vec![]),
                    None => reply(
                        Msg::error(Some(id), "unsupported", "query not supported"),
                        vec![],
                    ),
                }
            }
            other => {
                if let Some(id) = other.id() {
                    reply(
                        Msg::error(Some(id), "unsupported", "not implemented by the fake hub"),
                        vec![],
                    );
                }
            }
        }
    }
}

fn broadcast(st: &mut State, c: Change) {
    st.log.push(c.clone());
    st.subscribers
        .retain(|s| s.send((Msg::Change(c.clone()), vec![])).is_ok());
}
