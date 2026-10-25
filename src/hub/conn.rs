//! One client connection: handshake, in-order request handling, subscription pump (DESIGN §4).
//!
//! A reader loop handles requests one at a time; a writer task owns the socket's write half,
//! so responses and pushed changes interleave without blocking each other.

use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use super::store::{coded, error_code, AppendReq, Outcome, PutReq, ResetReq, Upload};
use super::HubState;
use crate::paths::now_ms;
use crate::proto::{self, Frame, MachineInfo, Msg, MAX_FRAME, PROTO_VERSION, VERSION};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Clients ping every 15s; a connection that sends nothing for this long is dropped.
const IDLE_TIMEOUT_MS: i64 = 60_000;
const OUT_QUEUE: usize = 16;
const PUMP_BATCH: usize = 256;
const MAX_UPLOADS: usize = 64;

type Out = (Msg, Vec<u8>);

pub(crate) async fn serve_conn<S>(state: Arc<HubState>, stream: S, tcp: bool, peer: String)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    if let Err(e) = run(state, stream, tcp, &peer).await {
        debug!(peer, "connection ended: {e:#}");
    }
}

async fn run<S>(state: Arc<HubState>, stream: S, tcp: bool, peer: &str) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (rd, mut wr) = tokio::io::split(stream);
    let last_rx = Arc::new(AtomicI64::new(now_ms()));
    let mut rd = Activity {
        inner: rd,
        last: last_rx.clone(),
    };
    proto::write_magic(&mut wr).await?;
    let hello = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        proto::read_magic(&mut rd).await?;
        proto::read_frame(&mut rd).await
    })
    .await
    .context("handshake timed out")??
    .context("closed before hello")?;

    let (id, machine) = match hello.msg {
        Msg::Hello {
            id,
            proto: p,
            machine,
            version,
            token,
        } => {
            if p != PROTO_VERSION {
                let msg = format!(
                    "hub speaks protocol {PROTO_VERSION} (uc {VERSION}), client speaks {p} (uc {version}); upgrade uc"
                );
                return reject(&mut wr, Some(id), "proto", msg).await;
            }
            if tcp && !token_ok(state.token.as_deref(), token.as_deref()) {
                warn!(peer, machine = %machine.name, "rejected: bad token");
                return reject(&mut wr, Some(id), "auth", "bad or missing token".into()).await;
            }
            if machine.id.trim().is_empty() {
                return reject(&mut wr, Some(id), "bad_request", "empty machine id".into()).await;
            }
            info!(peer, machine = %machine.name, id = %machine.id, client = %version, "hello");
            let (m, v) = (machine.clone(), version.clone());
            if let Err(e) = state
                .with_store(move |s| s.touch_machine(&m, &v, now_ms()))
                .await
            {
                warn!("recording machine {}: {e:#}", machine.id);
                return reject(&mut wr, Some(id), "internal", format!("{e:#}")).await;
            }
            (id, machine)
        }
        other => return reject(&mut wr, other.id(), "proto", "expected hello".into()).await,
    };
    let welcome = Msg::Welcome {
        re: id,
        hub_id: state.hub_id.clone(),
        head_seq: state.head(),
        version: VERSION.to_string(),
    };
    proto::write_frame(&mut wr, &welcome, &[]).await?;

    state.set_connected(&machine.id, true);
    let result = session(state.clone(), rd, wr, machine.clone(), last_rx).await;
    state.set_connected(&machine.id, false);
    let mid = machine.id.clone();
    if let Err(e) = state
        .with_store(move |s| s.machine_seen(&mid, now_ms()))
        .await
    {
        warn!("recording last_seen: {e:#}");
    }
    info!(machine = %machine.name, "disconnected");
    result
}

async fn reject<W: AsyncWrite + Unpin>(
    wr: &mut W,
    re: Option<u64>,
    code: &str,
    msg: String,
) -> Result<()> {
    debug!(code, "rejecting connection: {msg}");
    proto::write_frame(wr, &Msg::error(re, code, msg), &[]).await?;
    let _ = wr.shutdown().await;
    Ok(())
}

fn token_ok(expected: Option<&str>, got: Option<&str>) -> bool {
    let (Some(a), Some(b)) = (expected, got) else {
        return false;
    };
    // constant time in the token length
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Records when bytes last arrived, so a long upload on a slow link does not count as idle.
struct Activity<R> {
    inner: R,
    last: Arc<AtomicI64>,
}

impl<R: AsyncRead + Unpin> AsyncRead for Activity<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.last.store(now_ms(), Ordering::Relaxed);
        }
        r
    }
}

async fn idle(last: &AtomicI64, timeout_ms: i64) {
    loop {
        let quiet = now_ms() - last.load(Ordering::Relaxed);
        if quiet >= timeout_ms {
            return;
        }
        tokio::time::sleep(Duration::from_millis((timeout_ms - quiet) as u64 + 10)).await;
    }
}

async fn session<R, W>(
    state: Arc<HubState>,
    mut rd: R,
    wr: W,
    machine: MachineInfo,
    last_rx: Arc<AtomicI64>,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Out>(OUT_QUEUE);
    let writer = tokio::spawn(write_loop(wr, rx));
    let mut shutdown = state.shutdown.subscribe();
    let mut conn = Conn {
        state,
        machine,
        tx,
        pump: None,
        uploads: HashMap::new(),
    };
    let result = loop {
        if *shutdown.borrow_and_update() {
            break Ok(());
        }
        let frame = tokio::select! {
            r = proto::read_frame(&mut rd) => r,
            _ = idle(&last_rx, IDLE_TIMEOUT_MS) => {
                info!(machine = %conn.machine.name, "dropping idle connection");
                break Ok(());
            }
            _ = shutdown.changed() => break Ok(()),
        };
        match frame {
            Ok(Some(f)) => {
                if !conn.dispatch(f).await {
                    break Ok(());
                }
            }
            Ok(None) => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    if let Some(p) = conn.pump.take() {
        p.abort();
    }
    drop(conn);
    let mut writer = writer;
    match tokio::time::timeout(Duration::from_secs(5), &mut writer).await {
        Ok(Ok(Err(e))) => debug!("writer: {e:#}"),
        Err(_) => {
            // a peer that stopped reading must not pin the socket forever
            debug!("writer did not drain in time");
            writer.abort();
        }
        _ => {}
    }
    result
}

async fn write_loop<W: AsyncWrite + Unpin>(mut wr: W, mut rx: mpsc::Receiver<Out>) -> Result<()> {
    while let Some((msg, bin)) = rx.recv().await {
        proto::write_frame(&mut wr, &msg, &bin).await?;
    }
    let _ = wr.shutdown().await;
    Ok(())
}

struct Conn {
    state: Arc<HubState>,
    machine: MachineInfo,
    tx: mpsc::Sender<Out>,
    pump: Option<JoinHandle<()>>,
    uploads: HashMap<String, Upload>,
}

impl Conn {
    /// Handle one frame. False when the connection should close.
    async fn dispatch(&mut self, f: Frame) -> bool {
        let Some(id) = f.msg.id() else {
            debug!(machine = %self.machine.name, "ignoring non-request message {:?}", tag(&f.msg));
            return true;
        };
        let out = match self.handle(f).await {
            Ok(Some(out)) => out,
            Ok(None) => return true,
            Err(e) => {
                let code = error_code(&e);
                if code == "internal" {
                    warn!(machine = %self.machine.name, "request {id} failed: {e:#}");
                } else {
                    debug!(machine = %self.machine.name, code, "request {id}: {e:#}");
                }
                (Msg::error(Some(id), code, format!("{e:#}")), Vec::new())
            }
        };
        self.tx.send(out).await.is_ok()
    }

    async fn handle(&mut self, f: Frame) -> Result<Option<Out>> {
        let origin = self.machine.id.clone();
        let state = self.state.clone();
        let msg = match f.msg {
            Msg::Ping { id } => Msg::Pong { re: id },
            Msg::Subscribe { since, .. } => {
                self.subscribe(since);
                return Ok(None);
            }
            Msg::HasBlobs { id, hashes } => {
                let blobs = state.blobs.clone();
                let missing = blocking(move || {
                    let mut missing = Vec::new();
                    for h in hashes {
                        if blobs.size(&h)?.is_none() {
                            missing.push(h);
                        }
                    }
                    Ok(missing)
                })
                .await?;
                Msg::Missing {
                    re: id,
                    hashes: missing,
                }
            }
            Msg::BlobPut {
                id,
                hash,
                offset,
                last,
            } => {
                self.blob_put(hash, offset, last, f.bin).await?;
                Msg::Ok { re: id }
            }
            Msg::BlobGet {
                id,
                hash,
                offset,
                len,
            } => {
                let blobs = state.blobs.clone();
                let (bin, eof) = blocking(move || blobs.read(&hash, offset, len)).await?;
                return Ok(Some((
                    Msg::Blob {
                        re: id,
                        offset,
                        eof,
                    },
                    bin,
                )));
            }
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
                let req = PutReq {
                    space,
                    path,
                    base,
                    kind,
                    hash,
                    size,
                    exec,
                    mtime,
                    meta,
                };
                let o = state
                    .with_store(move |s| s.put(&req, &origin, now_ms()))
                    .await?;
                outcome_msg(id, o)
            }
            Msg::Delete {
                id,
                space,
                path,
                base,
            } => {
                let o = state
                    .with_store(move |s| s.delete(&space, &path, base, &origin, now_ms()))
                    .await?;
                outcome_msg(id, o)
            }
            Msg::Append {
                id,
                space,
                path,
                offset,
                tail,
                meta,
                claim,
            } => {
                let req = AppendReq {
                    space,
                    path,
                    offset,
                    tail,
                    meta,
                    claim,
                };
                let data = f.bin;
                let o = state
                    .with_store(move |s| s.append(&req, &data, &origin, now_ms()))
                    .await?;
                outcome_msg(id, o)
            }
            Msg::LogReset {
                id,
                space,
                path,
                base,
                hash,
                size,
                meta,
            } => {
                let req = ResetReq {
                    space,
                    path,
                    base,
                    hash,
                    size,
                    meta,
                };
                let o = state
                    .with_store(move |s| s.log_reset(&req, &origin, now_ms()))
                    .await?;
                outcome_msg(id, o)
            }
            Msg::LogRead {
                id,
                space,
                path,
                offset,
                len,
            } => {
                let (bin, eof) = state
                    .with_store(move |s| s.log_read(&space, &path, offset, len))
                    .await?;
                return Ok(Some((
                    Msg::Blob {
                        re: id,
                        offset,
                        eof,
                    },
                    bin,
                )));
            }
            Msg::Claim {
                id,
                space,
                path,
                force,
            } => {
                let o = state
                    .with_store(move |s| s.claim(&space, &path, force, &origin, now_ms()))
                    .await?;
                outcome_msg(id, o)
            }
            Msg::Heartbeat { id, space, path } => {
                state
                    .with_store(move |s| s.heartbeat(&space, &path, &origin, now_ms()))
                    .await?;
                Msg::Ok { re: id }
            }
            Msg::Release { id, space, path } => {
                state
                    .with_store(move |s| s.release(&space, &path, &origin))
                    .await?;
                Msg::Ok { re: id }
            }
            Msg::SpaceCreate {
                id,
                name,
                default_path,
            } => {
                let o = state
                    .with_store(move |s| s.space_create(&name, &default_path, &origin, now_ms()))
                    .await?;
                outcome_msg(id, o)
            }
            Msg::Query { id, query } => {
                let connected = state.connected_ids();
                let data = state
                    .with_store(move |s| s.query(&query, &connected, now_ms()))
                    .await?;
                let size = serde_json::to_vec(&data).map_or(0, |v| v.len());
                if size + 1024 > MAX_FRAME {
                    return Err(coded(
                        "too_large",
                        format!("result is {size} bytes; narrow the query or set a limit"),
                    ));
                }
                Msg::Result { re: id, data }
            }
            Msg::Hello { .. } => return Err(coded("proto", "already said hello")),
            Msg::Ctl { .. } => {
                return Err(coded(
                    "bad_request",
                    "control commands go to the daemon, not the hub",
                ))
            }
            other => {
                return Err(coded(
                    "bad_request",
                    format!("unexpected message {:?}", tag(&other)),
                ))
            }
        };
        Ok(Some((msg, Vec::new())))
    }

    async fn blob_put(
        &mut self,
        hash: String,
        offset: u64,
        last: bool,
        bin: Vec<u8>,
    ) -> Result<()> {
        let existing = self.uploads.remove(&hash);
        if offset == 0 && self.uploads.len() >= MAX_UPLOADS {
            return Err(coded(
                "bad_request",
                "too many concurrent uploads on this connection",
            ));
        }
        let blobs = self.state.blobs.clone();
        let h = hash.clone();
        let (up, size) = blocking(move || {
            let mut up = match (offset, existing) {
                // offset 0 (re)starts the upload; a previous partial upload is discarded
                (0, _) => blobs.begin(&h)?,
                (_, Some(up)) => up,
                (_, None) => {
                    return Err(coded(
                        "bad_offset",
                        format!("no upload of {h} in progress; restart at offset 0"),
                    ))
                }
            };
            up.write(offset, &bin)?;
            if last {
                Ok((None, Some(up.finish()?)))
            } else {
                Ok((Some(up), None))
            }
        })
        .await?;
        if let Some(up) = up {
            self.uploads.insert(hash.clone(), up);
        }
        if let Some(size) = size {
            self.state
                .with_store(move |s| s.record_blob(&hash, size, now_ms()))
                .await?;
        }
        Ok(())
    }

    fn subscribe(&mut self, since: u64) {
        if let Some(p) = self.pump.take() {
            p.abort();
        }
        let (state, tx, name) = (
            self.state.clone(),
            self.tx.clone(),
            self.machine.name.clone(),
        );
        self.pump = Some(tokio::spawn(async move {
            if let Err(e) = pump(state, since, tx).await {
                debug!(machine = %name, "subscription ended: {e:#}");
            }
        }));
    }
}

/// Stream every change with seq > `since` in seq order, then `CaughtUp`, then live changes.
/// Reading by seq from the store (rather than queueing pushed copies) makes gaps and duplicates
/// impossible between catch-up and live delivery, and the bounded writer queue throttles us to
/// the client's speed instead of buffering without limit.
async fn pump(state: Arc<HubState>, since: u64, tx: mpsc::Sender<Out>) -> Result<()> {
    let mut head_rx = state.head_tx.subscribe();
    let mut last = since;
    let mut caught_up = false;
    loop {
        let after = last;
        let (batch, head) = state
            .with_store(move |s| s.changes_after(after, PUMP_BATCH))
            .await?;
        let exhausted = batch.last().map_or(true, |(c, _)| c.seq >= head);
        for (change, bin) in batch {
            last = change.seq;
            tx.send((Msg::Change(change), bin))
                .await
                .map_err(|_| anyhow!("connection closed"))?;
        }
        if !exhausted {
            continue;
        }
        if !caught_up {
            if last > head {
                warn!(
                    since,
                    head, "client cursor is ahead of the hub; restarting it at the hub head"
                );
                last = head;
            }
            tx.send((Msg::CaughtUp { seq: head }, Vec::new()))
                .await
                .map_err(|_| anyhow!("connection closed"))?;
            caught_up = true;
        }
        loop {
            if *head_rx.borrow_and_update() > last {
                break;
            }
            head_rx
                .changed()
                .await
                .map_err(|_| anyhow!("hub shutting down"))?;
        }
    }
}

fn outcome_msg(re: u64, o: Outcome) -> Msg {
    match o {
        Outcome::Committed { seq, entry, .. } => Msg::Committed { re, seq, entry },
        Outcome::Conflict { current, reason } => Msg::Conflict {
            re,
            current,
            reason,
        },
        Outcome::Busy {
            owner,
            owner_name,
            idle_ms,
        } => Msg::Busy {
            re,
            owner,
            owner_name,
            idle_ms,
        },
    }
}

/// The JSON tag of a message, for logs.
fn tag(m: &Msg) -> String {
    serde_json::to_value(m)
        .ok()
        .and_then(|v| v.get("t").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default()
}

async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .context("blocking task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare() {
        assert!(token_ok(Some("s3cret"), Some("s3cret")));
        assert!(!token_ok(Some("s3cret"), Some("s3cres")));
        assert!(!token_ok(Some("s3cret"), Some("s3cret!")));
        assert!(!token_ok(Some("s3cret"), None));
        assert!(!token_ok(None, Some("x")));
    }

    #[tokio::test]
    async fn idle_fires_after_silence() {
        let last = AtomicI64::new(now_ms());
        let t = std::time::Instant::now();
        idle(&last, 50).await;
        assert!(t.elapsed() >= Duration::from_millis(45));
    }
}
