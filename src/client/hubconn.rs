//! Persistent hub connection with request/response multiplexing and auto-reconnect.
//! Owner: client-core agent.
//!
//! One background task owns the stream. Requests are matched to responses by `re`; pushes
//! (`Change`, `CaughtUp`) become `HubEvent`s. Subscriptions do not survive a reconnect: the
//! consumer calls `subscribe(cursor)` on every `Connected` event (the cursor lives in ClientDb).

use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context as TaskCx, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::{mpsc, oneshot, watch, Notify};
use tracing::{debug, info, warn};

use crate::proto::{self, Change, Entry, MachineInfo, Msg, Query};
use crate::transport::{self, Conn, HubAddr};

/// Events from the connection task to the daemon loop.
#[derive(Debug)]
pub enum HubEvent {
    Connected {
        hub_id: String,
        head_seq: u64,
        version: String,
    },
    Disconnected {
        error: String,
    },
    /// a replicated change (+ inline append bytes)
    Change(Change, Vec<u8>),
    CaughtUp(u64),
}

#[derive(Debug, Clone)]
pub struct HubSettings {
    /// hub address string from config (parsed with transport::HubAddr::parse)
    pub addr: String,
    pub remote_uc: Option<String>,
    pub token: Option<String>,
    pub uc_home: PathBuf,
}

/// Outcome of a mutation request.
#[derive(Debug, Clone)]
pub enum Commit {
    Committed {
        seq: u64,
        entry: Entry,
    },
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

/// An `Error` response from the hub; recover it with `err.downcast_ref::<HubError>()`.
#[derive(Debug, Clone, PartialEq)]
pub struct HubError {
    pub code: String,
    pub msg: String,
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "hub: {} ({})", self.msg, self.code)
    }
}

impl std::error::Error for HubError {}

pub type ConnectFuture = Pin<Box<dyn Future<Output = Result<Conn>> + Send>>;
/// Opens a fresh, not-yet-handshaken stream to the hub (injectable for tests).
pub type Connector = Arc<dyn Fn() -> ConnectFuture + Send + Sync>;

const PING_EVERY: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(45);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// A connection that stayed up this long resets the reconnect backoff.
const HEALTHY_AFTER: Duration = Duration::from_secs(10);
/// Upper bound for one request; a hub that answers pings but not a request must not wedge us.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

type Reply = Result<(Msg, Vec<u8>)>;
type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

struct Link {
    tx: mpsc::UnboundedSender<(Msg, Vec<u8>)>,
    pending: PendingMap,
}

struct Inner {
    next_id: AtomicU64,
    head_seq: AtomicU64,
    link: Mutex<Option<Link>>,
    connected: watch::Sender<bool>,
    hub_version: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    stopped: AtomicBool,
    stop: Notify,
    epoch: Instant,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Cheap-to-clone handle. A background task owns the stream, reconnects with exponential
/// backoff (0.5s .. 30s), sends Ping every 15s, and emits HubEvents.
#[derive(Clone)]
pub struct HubClient {
    inner: Arc<Inner>,
}

impl HubClient {
    /// Spawn the connection task. Events arrive on the returned receiver.
    pub fn start(
        settings: HubSettings,
        machine: MachineInfo,
    ) -> (HubClient, mpsc::UnboundedReceiver<HubEvent>) {
        let token = settings
            .token
            .clone()
            .filter(|t| !t.is_empty())
            .or_else(|| std::env::var("UC_TOKEN").ok().filter(|t| !t.is_empty()));
        let addr = HubAddr::parse(&settings.addr).map_err(|e| format!("{e:#}"));
        let connector: Connector = Arc::new(move || {
            let addr = addr.clone();
            let remote_uc = settings.remote_uc.clone().filter(|s| !s.is_empty());
            let uc_home = settings.uc_home.clone();
            Box::pin(async move {
                let addr = addr.map_err(|e| anyhow!("bad hub address: {e}"))?;
                transport::connect(&addr, remote_uc.as_deref(), &uc_home).await
            })
        });
        Self::start_with(connector, machine, token)
    }

    /// Like `start`, with an explicit way to open streams (tests use in-process fakes).
    pub fn start_with(
        connector: Connector,
        machine: MachineInfo,
        token: Option<String>,
    ) -> (HubClient, mpsc::UnboundedReceiver<HubEvent>) {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            next_id: AtomicU64::new(0),
            head_seq: AtomicU64::new(0),
            link: Mutex::new(None),
            connected: watch::channel(false).0,
            hub_version: Mutex::new(None),
            last_error: Mutex::new(None),
            stopped: AtomicBool::new(false),
            stop: Notify::new(),
            epoch: Instant::now(),
        });
        tokio::spawn(run(inner.clone(), connector, machine, token, events_tx));
        (HubClient { inner }, events_rx)
    }

    /// Stop the connection task (pending requests fail).
    pub fn shutdown(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        self.inner.stop.notify_waiters();
    }

    pub fn is_connected(&self) -> bool {
        *self.inner.connected.borrow()
    }

    pub fn head_seq(&self) -> u64 {
        self.inner.head_seq.load(Ordering::SeqCst)
    }

    /// Version string the hub reported in its last Welcome.
    pub fn hub_version(&self) -> Option<String> {
        lock(&self.inner.hub_version).clone()
    }

    /// Why the last connection attempt failed or the link dropped.
    pub fn last_error(&self) -> Option<String> {
        lock(&self.inner.last_error).clone()
    }

    /// Wait until connected (or timeout).
    pub async fn wait_connected(&self, timeout: std::time::Duration) -> bool {
        let mut rx = self.inner.connected.subscribe();
        let ok = matches!(
            tokio::time::timeout(timeout, rx.wait_for(|c| *c)).await,
            Ok(Ok(_))
        );
        ok
    }

    pub fn next_id(&self) -> u64 {
        self.inner.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Send a request (its `id` must come from `next_id`) and await the matching response.
    /// Errors immediately when disconnected; `Msg::Error` responses become `Err` (a `HubError`).
    pub async fn request(&self, msg: Msg, bin: Vec<u8>) -> Result<(Msg, Vec<u8>)> {
        let id = msg.id().context("request message has no id")?;
        let (tx, rx) = oneshot::channel();
        let pending = {
            let link = lock(&self.inner.link);
            let link = link.as_ref().context("not connected to the hub")?;
            lock(&link.pending).insert(id, tx);
            if link.tx.send((msg, bin)).is_err() {
                lock(&link.pending).remove(&id);
                bail!("connection to the hub was lost");
            }
            link.pending.clone()
        };
        let reply = match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(r)) => r?,
            Ok(Err(_)) => bail!("connection to the hub was lost"),
            Err(_) => {
                lock(&pending).remove(&id);
                bail!("hub did not answer within {}s", REQUEST_TIMEOUT.as_secs());
            }
        };
        if let Msg::Error { code, msg, .. } = reply.0 {
            return Err(HubError { code, msg }.into());
        }
        Ok(reply)
    }

    /// Queue a message without waiting for any response.
    fn send(&self, msg: Msg, bin: Vec<u8>) -> Result<()> {
        let link = lock(&self.inner.link);
        let link = link.as_ref().context("not connected to the hub")?;
        link.tx
            .send((msg, bin))
            .map_err(|_| anyhow!("connection to the hub was lost"))
    }

    /// Start replication from `since` (catch-up `Change`s, `CaughtUp`, then live changes).
    pub async fn subscribe(&self, since: u64) -> Result<()> {
        let id = self.next_id();
        self.send(Msg::Subscribe { id, since }, Vec::new())
    }

    async fn has_blob(&self, hash: &str) -> Result<bool> {
        let id = self.next_id();
        let (msg, _) = self
            .request(
                Msg::HasBlobs {
                    id,
                    hashes: vec![hash.to_string()],
                },
                Vec::new(),
            )
            .await?;
        match msg {
            Msg::Missing { hashes, .. } => Ok(!hashes.iter().any(|h| h == hash)),
            other => bail!("unexpected reply to HasBlobs: {}", tag(&other)),
        }
    }

    async fn put_chunk(&self, hash: &str, offset: u64, last: bool, chunk: Vec<u8>) -> Result<()> {
        let id = self.next_id();
        let msg = Msg::BlobPut {
            id,
            hash: hash.to_string(),
            offset,
            last,
        };
        match self.request(msg, chunk).await?.0 {
            Msg::Ok { .. } => Ok(()),
            other => bail!("unexpected reply to BlobPut: {}", tag(&other)),
        }
    }

    /// Upload a file's bytes as blob `hash` unless the hub already has it.
    pub async fn upload_file(&self, path: &Path, hash: &str) -> Result<()> {
        if self.has_blob(hash).await? {
            return Ok(());
        }
        let mut f = tokio::fs::File::open(path)
            .await
            .with_context(|| format!("opening {}", path.display()))?;
        let size = f.metadata().await?.len();
        let mut offset = 0u64;
        loop {
            let mut buf = vec![0u8; proto::CHUNK];
            let mut n = 0;
            while n < buf.len() {
                let k = f.read(&mut buf[n..]).await?;
                if k == 0 {
                    break;
                }
                n += k;
            }
            buf.truncate(n);
            let last = n < proto::CHUNK || offset + n as u64 >= size;
            self.put_chunk(hash, offset, last, buf).await?;
            offset += n as u64;
            if last {
                return Ok(());
            }
        }
    }

    /// Upload in-memory bytes as blob `hash` unless the hub already has it.
    pub async fn upload_bytes(&self, data: &[u8], hash: &str) -> Result<()> {
        if self.has_blob(hash).await? {
            return Ok(());
        }
        let mut offset = 0usize;
        loop {
            let end = (offset + proto::CHUNK).min(data.len());
            let last = end == data.len();
            self.put_chunk(hash, offset as u64, last, data[offset..end].to_vec())
                .await?;
            offset = end;
            if last {
                return Ok(());
            }
        }
    }

    /// Download blob `hash` into `dest` (created/truncated), verifying the hash.
    pub async fn download_blob(&self, hash: &str, dest: &Path) -> Result<()> {
        let res = self.download_inner(hash, dest).await;
        if res.is_err() {
            let _ = tokio::fs::remove_file(dest).await;
        }
        res
    }

    async fn download_inner(&self, hash: &str, dest: &Path) -> Result<()> {
        let mut f = tokio::fs::File::create(dest)
            .await
            .with_context(|| format!("creating {}", dest.display()))?;
        let mut hasher = blake3::Hasher::new();
        let mut offset = 0u64;
        loop {
            let id = self.next_id();
            let req = Msg::BlobGet {
                id,
                hash: hash.to_string(),
                offset,
                len: proto::CHUNK as u64,
            };
            let (msg, bin) = self.request(req, Vec::new()).await?;
            let Msg::Blob {
                offset: got, eof, ..
            } = msg
            else {
                bail!("unexpected reply to BlobGet: {}", tag(&msg));
            };
            if got != offset {
                bail!("blob {hash}: hub sent offset {got}, expected {offset}");
            }
            hasher.update(&bin);
            f.write_all(&bin).await?;
            offset += bin.len() as u64;
            if eof {
                break;
            }
            if bin.is_empty() {
                bail!("blob {hash}: hub sent an empty chunk before eof");
            }
        }
        f.flush().await?;
        let got = hasher.finalize().to_hex().to_string();
        if got != hash {
            bail!("blob {hash}: content hash mismatch (got {got})");
        }
        Ok(())
    }

    /// Read `[offset, offset+len)` of a log.
    pub async fn read_log(
        &self,
        space: &str,
        path: &str,
        offset: u64,
        len: u64,
    ) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(len.min(proto::CHUNK as u64) as usize);
        while (out.len() as u64) < len {
            let id = self.next_id();
            let at = offset + out.len() as u64;
            let want = (len - out.len() as u64).min(proto::CHUNK as u64);
            let req = Msg::LogRead {
                id,
                space: space.into(),
                path: path.into(),
                offset: at,
                len: want,
            };
            let (msg, bin) = self.request(req, Vec::new()).await?;
            let Msg::Blob { eof, .. } = msg else {
                bail!("unexpected reply to LogRead: {}", tag(&msg));
            };
            out.extend_from_slice(&bin);
            if eof || bin.is_empty() {
                break;
            }
        }
        Ok(out)
    }

    pub async fn query(&self, q: Query) -> Result<serde_json::Value> {
        let id = self.next_id();
        match self
            .request(Msg::Query { id, query: q }, Vec::new())
            .await?
            .0
        {
            Msg::Result { data, .. } => Ok(data),
            other => bail!("unexpected reply to Query: {}", tag(&other)),
        }
    }

    /// Send a mutation (Put/Delete/Append/LogReset/Claim/SpaceCreate) and map the response.
    pub async fn commit(&self, msg: Msg, bin: Vec<u8>) -> Result<Commit> {
        match self.request(msg, bin).await?.0 {
            Msg::Committed { seq, entry, .. } => {
                self.inner.head_seq.fetch_max(seq, Ordering::SeqCst);
                Ok(Commit::Committed { seq, entry })
            }
            Msg::Conflict {
                current, reason, ..
            } => Ok(Commit::Conflict { current, reason }),
            Msg::Busy {
                owner,
                owner_name,
                idle_ms,
                ..
            } => Ok(Commit::Busy {
                owner,
                owner_name,
                idle_ms,
            }),
            other => bail!("unexpected reply to a mutation: {}", tag(&other)),
        }
    }
}

/// Short message tag for errors (never dumps payloads).
fn tag(m: &Msg) -> String {
    serde_json::to_value(m)
        .ok()
        .and_then(|v| v.get("t").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_else(|| "?".into())
}

fn jitter(d: Duration) -> Duration {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.subsec_nanos())
        .unwrap_or(0);
    d.mul_f64(f64::from(n % 1000) / 4000.0)
}

async fn run(
    inner: Arc<Inner>,
    connector: Connector,
    machine: MachineInfo,
    token: Option<String>,
    events: mpsc::UnboundedSender<HubEvent>,
) {
    let mut backoff = BACKOFF_MIN;
    while !inner.stopped.load(Ordering::SeqCst) && !events.is_closed() {
        let mut up_since = None;
        let res = session(&inner, &connector, &machine, &token, &events, &mut up_since).await;
        if inner.stopped.load(Ordering::SeqCst) {
            break;
        }
        let error = match res {
            Ok(()) => "hub closed the connection".to_string(),
            Err(e) => format!("{e:#}"),
        };
        if up_since.is_some() {
            warn!("hub connection lost: {error}");
        } else {
            debug!("hub connect failed: {error}");
        }
        *lock(&inner.last_error) = Some(error.clone());
        if events.send(HubEvent::Disconnected { error }).is_err() {
            break;
        }
        if up_since.is_some_and(|t: Instant| t.elapsed() >= HEALTHY_AFTER) {
            backoff = BACKOFF_MIN;
        }
        let delay = backoff + jitter(backoff);
        backoff = (backoff * 2).min(BACKOFF_MAX);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = inner.stop.notified() => {}
        }
    }
    debug!("hub connection task stopped");
}

/// One connection: handshake, then pump frames until it dies. `up_since` is set once the
/// handshake succeeded.
async fn session(
    inner: &Arc<Inner>,
    connector: &Connector,
    machine: &MachineInfo,
    token: &Option<String>,
    events: &mpsc::UnboundedSender<HubEvent>,
    up_since: &mut Option<Instant>,
) -> Result<()> {
    let conn = tokio::time::timeout(HANDSHAKE_TIMEOUT, connector())
        .await
        .map_err(|_| anyhow!("timed out connecting to the hub"))??;
    let Conn {
        reader,
        mut writer,
        child,
    } = conn;
    let last_rx = Arc::new(AtomicU64::new(0));
    let mut reader = Tracked {
        inner: reader,
        last_rx: last_rx.clone(),
        epoch: inner.epoch,
    };
    last_rx.store(inner.epoch.elapsed().as_millis() as u64, Ordering::SeqCst);

    let hello = Msg::Hello {
        id: inner.next_id.fetch_add(1, Ordering::SeqCst) + 1,
        proto: proto::PROTO_VERSION,
        machine: machine.clone(),
        version: proto::VERSION.to_string(),
        token: token.clone(),
    };
    let handshake = async {
        proto::write_magic(&mut writer).await?;
        proto::write_frame(&mut writer, &hello, &[]).await?;
        proto::read_magic(&mut reader).await?;
        loop {
            let Some(f) = proto::read_frame(&mut reader).await? else {
                bail!("hub closed the connection during the handshake");
            };
            match f.msg {
                Msg::Welcome {
                    hub_id,
                    head_seq,
                    version,
                    ..
                } => return Ok((hub_id, head_seq, version)),
                Msg::Error { code, msg, .. } => return Err(HubError { code, msg }.into()),
                other => debug!("ignoring {} before welcome", tag(&other)),
            }
        }
    };
    let (hub_id, head_seq, version) = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
        .await
        .map_err(|_| anyhow!("hub handshake timed out"))??;

    inner.head_seq.fetch_max(head_seq, Ordering::SeqCst);
    *lock(&inner.hub_version) = Some(version.clone());
    let (tx, rx) = mpsc::unbounded_channel();
    let pending: PendingMap = Arc::default();
    *lock(&inner.link) = Some(Link {
        tx: tx.clone(),
        pending: pending.clone(),
    });
    inner.connected.send_replace(true);
    *up_since = Some(Instant::now());
    info!("connected to hub {hub_id} (v{version}, head {head_seq})");
    let _ = events.send(HubEvent::Connected {
        hub_id,
        head_seq,
        version,
    });

    let mut writer_task = tokio::spawn(write_loop(writer, rx, inner.clone()));
    let mut reader_task = tokio::spawn(read_loop(
        reader,
        tx,
        pending.clone(),
        inner.clone(),
        events.clone(),
    ));
    let res = tokio::select! {
        r = &mut reader_task => r.unwrap_or_else(|e| Err(anyhow!("reader task failed: {e}"))),
        r = &mut writer_task => r.unwrap_or_else(|e| Err(anyhow!("writer task failed: {e}"))),
        r = watchdog(last_rx, inner.clone()) => r,
        _ = inner.stop.notified() => Ok(()),
    };
    reader_task.abort();
    writer_task.abort();
    *lock(&inner.link) = None;
    inner.connected.send_replace(false);
    for (_, waiter) in lock(&pending).drain() {
        let _ = waiter.send(Err(anyhow!("connection to the hub was lost")));
    }
    if let Some(mut c) = child {
        let _ = c.start_kill();
        tokio::spawn(async move {
            let _ = c.wait().await;
        });
    }
    res
}

/// Ends the session on 45s of silence, or on shutdown (a stop request can race with connect).
async fn watchdog(last_rx: Arc<AtomicU64>, inner: Arc<Inner>) -> Result<()> {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if inner.stopped.load(Ordering::SeqCst) {
            return Ok(());
        }
        let now = inner.epoch.elapsed().as_millis() as u64;
        if now.saturating_sub(last_rx.load(Ordering::SeqCst)) > SILENCE_LIMIT.as_millis() as u64 {
            bail!("hub silent for {}s", SILENCE_LIMIT.as_secs());
        }
    }
}

async fn write_loop(
    mut w: Box<dyn AsyncWrite + Send + Unpin>,
    mut rx: mpsc::UnboundedReceiver<(Msg, Vec<u8>)>,
    inner: Arc<Inner>,
) -> Result<()> {
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Some((msg, bin)) => proto::write_frame(&mut w, &msg, &bin).await.context("writing to the hub")?,
                None => return Ok(()),
            },
            _ = ping.tick() => {
                let id = inner.next_id.fetch_add(1, Ordering::SeqCst) + 1;
                proto::write_frame(&mut w, &Msg::Ping { id }, &[]).await.context("writing to the hub")?;
            }
        }
    }
}

async fn read_loop(
    mut r: Tracked,
    tx: mpsc::UnboundedSender<(Msg, Vec<u8>)>,
    pending: PendingMap,
    inner: Arc<Inner>,
    events: mpsc::UnboundedSender<HubEvent>,
) -> Result<()> {
    loop {
        let Some(frame) = proto::read_frame(&mut r)
            .await
            .context("reading from the hub")?
        else {
            return Ok(());
        };
        let (msg, bin) = (frame.msg, frame.bin);
        match msg {
            Msg::Change(c) => {
                inner.head_seq.fetch_max(c.seq, Ordering::SeqCst);
                if events.send(HubEvent::Change(c, bin)).is_err() {
                    return Ok(());
                }
            }
            Msg::CaughtUp { seq } => {
                inner.head_seq.fetch_max(seq, Ordering::SeqCst);
                if events.send(HubEvent::CaughtUp(seq)).is_err() {
                    return Ok(());
                }
            }
            Msg::Ping { id } => {
                let _ = tx.send((Msg::Pong { re: id }, Vec::new()));
            }
            Msg::Pong { .. } => {}
            msg => {
                if let Msg::Committed { seq, .. } = &msg {
                    inner.head_seq.fetch_max(*seq, Ordering::SeqCst);
                }
                let waiter = msg.re().and_then(|re| lock(&pending).remove(&re));
                match (waiter, msg) {
                    (Some(w), msg) => {
                        let _ = w.send(Ok((msg, bin)));
                    }
                    (None, Msg::Error { code, msg, .. }) => {
                        warn!("hub error: {msg} ({code})");
                        *lock(&inner.last_error) = Some(format!("hub: {msg} ({code})"));
                    }
                    (None, other) => debug!("unmatched {} from hub", tag(&other)),
                }
            }
        }
    }
}

/// Reader that records when bytes last arrived, so silence (not slow frames) kills a link.
struct Tracked {
    inner: Box<dyn AsyncRead + Send + Unpin>,
    last_rx: Arc<AtomicU64>,
    epoch: Instant,
}

impl AsyncRead for Tracked {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskCx<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let res = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(res, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.last_rx
                .store(self.epoch.elapsed().as_millis() as u64, Ordering::SeqCst);
        }
        res
    }
}

#[cfg(test)]
#[path = "engine_testhub.rs"]
pub(crate) mod testhub;

#[cfg(test)]
mod tests {
    use super::testhub::FakeHub;
    use super::*;

    fn machine(id: &str) -> MachineInfo {
        MachineInfo {
            id: id.into(),
            name: id.into(),
            os: "macos".into(),
            home: "/h".into(),
        }
    }

    #[tokio::test]
    async fn handshake_request_events_and_reconnect() {
        let hub = FakeHub::new();
        let (client, mut ev) =
            HubClient::start_with(hub.connector(), machine("m1"), Some("tok".into()));
        assert!(client.wait_connected(Duration::from_secs(5)).await);
        match ev.recv().await.unwrap() {
            HubEvent::Connected { head_seq, .. } => assert_eq!(head_seq, 0),
            e => panic!("unexpected {e:?}"),
        }
        assert_eq!(hub.last_hello_token().as_deref(), Some("tok"));

        // request/response + error mapping
        let v = client.query(Query::Spaces).await.unwrap();
        assert!(v.is_array());
        let err = client.query(Query::Machines).await.unwrap_err();
        assert_eq!(err.downcast_ref::<HubError>().unwrap().code, "unsupported");

        // blobs roundtrip, chunk boundaries included
        let data: Vec<u8> = (0..(proto::CHUNK + 10)).map(|i| (i % 251) as u8).collect();
        let h = crate::hash::hash_bytes(&data);
        client.upload_bytes(&data, &h).await.unwrap();
        client.upload_bytes(&data, &h).await.unwrap();
        let d = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let dest = d.path().join("blob");
        client.download_blob(&h, &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert!(client.download_blob(&"0".repeat(64), &dest).await.is_err());
        assert!(!dest.exists());

        // subscription pushes
        let entry = testhub::file_entry("code", "a.txt", "h", 0);
        hub.inject_put(entry);
        client.subscribe(0).await.unwrap();
        let mut saw_change = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ev.recv())
                .await
                .unwrap()
                .unwrap()
            {
                HubEvent::Change(c, _) => {
                    assert_eq!(c.entry.path, "a.txt");
                    saw_change = true;
                }
                HubEvent::CaughtUp(seq) => {
                    assert!(saw_change);
                    assert_eq!(seq, 1);
                    break;
                }
                e => panic!("unexpected {e:?}"),
            }
        }
        assert_eq!(client.head_seq(), 1);

        // the hub drops us: pending requests fail, Disconnected, then automatic reconnect
        hub.hang_queries(true);
        let c2 = client.clone();
        let q = tokio::spawn(async move { c2.query(Query::Spaces).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        hub.drop_connections();
        assert!(q.await.unwrap().is_err());
        hub.hang_queries(false);
        let mut reconnected = false;
        while let Ok(Some(e)) = tokio::time::timeout(Duration::from_secs(5), ev.recv()).await {
            match e {
                HubEvent::Disconnected { .. } => {}
                HubEvent::Connected { head_seq, .. } => {
                    assert_eq!(head_seq, 1);
                    reconnected = true;
                    break;
                }
                e => panic!("unexpected {e:?}"),
            }
        }
        assert!(reconnected);
        assert!(client.query(Query::Spaces).await.is_ok());
        assert_eq!(hub.connections(), 2);
        client.shutdown();
    }

    #[tokio::test]
    async fn requests_fail_fast_when_disconnected() {
        let connector: Connector = Arc::new(|| Box::pin(async { Err(anyhow!("no route to hub")) }));
        let (client, mut ev) = HubClient::start_with(connector, machine("m1"), None);
        match ev.recv().await.unwrap() {
            HubEvent::Disconnected { error } => assert!(error.contains("no route")),
            e => panic!("unexpected {e:?}"),
        }
        assert!(!client.is_connected());
        assert!(client.query(Query::Spaces).await.is_err());
        assert!(!client.wait_connected(Duration::from_millis(50)).await);
        assert!(client.last_error().unwrap().contains("no route"));
        client.shutdown();
    }
}
