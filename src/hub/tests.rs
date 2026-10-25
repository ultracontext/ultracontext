//! End to end: a real hub on a temp UC_HOME, spoken to with raw protocol frames over
//! `transport::connect`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::oneshot;

use super::*;
use crate::hash;
use crate::proto::{self, Frame, HubStatus, Kind, MachineInfo, Msg, Op, Query, PROTO_VERSION};
use crate::transport::{self, HubAddr};

struct TestHub {
    _dir: tempfile::TempDir,
    home: PathBuf,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<Result<()>>,
}

impl TestHub {
    async fn start(tcp: Option<String>, token: Option<&str>) -> TestHub {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        TestHub::start_in(dir, tcp, token).await
    }

    /// Stop, then serve the same UC_HOME again.
    async fn restart(mut self) -> TestHub {
        let _ = self.stop.take().unwrap().send(());
        self.task.await.unwrap().unwrap();
        TestHub::start_in(self._dir, None, None).await
    }

    async fn start_in(dir: tempfile::TempDir, tcp: Option<String>, token: Option<&str>) -> TestHub {
        let home = dir.path().to_path_buf();
        let (stop, stopped) = oneshot::channel::<()>();
        let opts = HubOpts {
            uc_home: home.clone(),
            tcp,
            token: token.map(String::from),
            lease_idle_ms: DEFAULT_LEASE_IDLE_MS,
        };
        let task = tokio::spawn(serve_with_shutdown(opts, async {
            let _ = stopped.await;
        }));
        let sock = home.join("hub.sock");
        for _ in 0..500 {
            if tokio::net::UnixStream::connect(&sock).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        TestHub {
            _dir: dir,
            home,
            stop: Some(stop),
            task,
        }
    }

    fn sock(&self) -> PathBuf {
        self.home.join("hub.sock")
    }

    async fn client(&self, machine: &str, name: &str) -> Client {
        let conn = transport::connect(&HubAddr::Unix(self.sock()), None, &self.home)
            .await
            .unwrap();
        let mut c = Client::open(conn).await;
        let f = c.hello(machine, name, None, PROTO_VERSION).await;
        assert!(matches!(f.msg, Msg::Welcome { .. }), "{:?}", f.msg);
        c
    }

    async fn stop(mut self) {
        let _ = self.stop.take().unwrap().send(());
        let sock = self.sock();
        self.task.await.unwrap().unwrap();
        assert!(!sock.exists(), "socket removed on shutdown");
    }
}

struct Client {
    rd: Box<dyn AsyncRead + Send + Unpin>,
    wr: Box<dyn AsyncWrite + Send + Unpin>,
    _conn_child: Option<tokio::process::Child>,
    next: u64,
    pushed: VecDeque<Frame>,
}

impl Client {
    async fn open(conn: transport::Conn) -> Client {
        let mut c = Client {
            rd: conn.reader,
            wr: conn.writer,
            _conn_child: conn.child,
            next: 0,
            pushed: VecDeque::new(),
        };
        proto::write_magic(&mut c.wr).await.unwrap();
        proto::read_magic(&mut c.rd).await.unwrap();
        c
    }

    fn id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    async fn hello(
        &mut self,
        machine: &str,
        name: &str,
        token: Option<&str>,
        proto_v: u32,
    ) -> Frame {
        let msg = Msg::Hello {
            id: self.id(),
            proto: proto_v,
            machine: MachineInfo {
                id: machine.into(),
                name: name.into(),
                os: "linux".into(),
                home: "/home/t".into(),
            },
            version: "test".into(),
            token: token.map(String::from),
        };
        self.send(&msg, b"").await;
        self.recv().await
    }

    async fn send(&mut self, msg: &Msg, bin: &[u8]) {
        proto::write_frame(&mut self.wr, msg, bin).await.unwrap();
    }

    async fn recv(&mut self) -> Frame {
        tokio::time::timeout(Duration::from_secs(10), proto::read_frame(&mut self.rd))
            .await
            .expect("timed out waiting for a frame")
            .unwrap()
            .expect("connection closed")
    }

    /// Send a request and wait for its response; pushes received meanwhile are kept.
    async fn call(&mut self, msg: Msg, bin: &[u8]) -> Frame {
        let id = msg.id();
        self.send(&msg, bin).await;
        loop {
            let f = self.recv().await;
            if f.msg.re().is_some() && f.msg.re() == id {
                return f;
            }
            self.pushed.push_back(f);
        }
    }

    async fn push(&mut self) -> Frame {
        match self.pushed.pop_front() {
            Some(f) => f,
            None => self.recv().await,
        }
    }

    async fn upload(&mut self, data: &[u8], chunk: usize) -> String {
        let hash = hash::hash_bytes(data);
        let mut off = 0;
        loop {
            let end = (off + chunk).min(data.len());
            let last = end == data.len();
            let id = self.id();
            let f = self
                .call(
                    Msg::BlobPut {
                        id,
                        hash: hash.clone(),
                        offset: off as u64,
                        last,
                    },
                    &data[off..end],
                )
                .await;
            assert!(matches!(f.msg, Msg::Ok { .. }), "{:?}", f.msg);
            if last {
                return hash;
            }
            off = end;
        }
    }

    async fn put(
        &mut self,
        space: &str,
        path: &str,
        base: Option<u64>,
        hash: &str,
        size: u64,
    ) -> Msg {
        let id = self.id();
        self.call(
            Msg::Put {
                id,
                space: space.into(),
                path: path.into(),
                base,
                kind: Kind::File,
                hash: hash.into(),
                size,
                exec: false,
                mtime: 1,
                meta: None,
            },
            b"",
        )
        .await
        .msg
    }

    async fn append(&mut self, path: &str, offset: u64, tail: Option<String>, data: &[u8]) -> Msg {
        let id = self.id();
        self.call(
            Msg::Append {
                id,
                space: "@claude".into(),
                path: path.into(),
                offset,
                tail,
                meta: None,
                claim: false,
            },
            data,
        )
        .await
        .msg
    }
}

#[tokio::test]
async fn protocol_end_to_end() {
    let hub = TestHub::start(None, None).await;
    let mut a = hub.client("m_a", "mac").await;

    let id = a.id();
    let f = a
        .call(
            Msg::SpaceCreate {
                id,
                name: "code".into(),
                default_path: "~/Code".into(),
            },
            b"",
        )
        .await;
    assert!(matches!(f.msg, Msg::Committed { .. }), "{:?}", f.msg);

    // blob upload in two chunks; incomplete uploads are still missing
    let data: Vec<u8> = b"hello, world\n".repeat(1000);
    let hash = hash::hash_bytes(&data);
    let half = data.len() / 2;
    let id = a.id();
    let f = a
        .call(
            Msg::BlobPut {
                id,
                hash: hash.clone(),
                offset: 0,
                last: false,
            },
            &data[..half],
        )
        .await;
    assert!(matches!(f.msg, Msg::Ok { .. }), "{:?}", f.msg);
    let id = a.id();
    match a
        .call(
            Msg::HasBlobs {
                id,
                hashes: vec![hash.clone()],
            },
            b"",
        )
        .await
        .msg
    {
        Msg::Missing { hashes, .. } => assert_eq!(hashes, [hash.clone()]),
        m => panic!("{m:?}"),
    }
    let id = a.id();
    let f = a
        .call(
            Msg::BlobPut {
                id,
                hash: hash.clone(),
                offset: half as u64,
                last: true,
            },
            &data[half..],
        )
        .await;
    assert!(matches!(f.msg, Msg::Ok { .. }), "{:?}", f.msg);
    let other = hash::hash_bytes(b"other");
    let id = a.id();
    match a
        .call(
            Msg::HasBlobs {
                id,
                hashes: vec![hash.clone(), other.clone()],
            },
            b"",
        )
        .await
        .msg
    {
        Msg::Missing { hashes, .. } => assert_eq!(hashes, [other.clone()]),
        m => panic!("{m:?}"),
    }
    let id = a.id();
    let f = a
        .call(
            Msg::BlobGet {
                id,
                hash: hash.clone(),
                offset: 0,
                len: 1 << 30,
            },
            b"",
        )
        .await;
    assert!(
        matches!(
            f.msg,
            Msg::Blob {
                eof: true,
                offset: 0,
                ..
            }
        ),
        "{:?}",
        f.msg
    );
    assert_eq!(f.bin, data);

    match a.put("code", "a.txt", None, &hash, data.len() as u64).await {
        Msg::Committed { seq, entry, .. } => {
            assert_eq!((seq, entry.version, entry.origin.as_str()), (1, 1, "m_a"))
        }
        m => panic!("{m:?}"),
    }
    let v2 = a.upload(b"v2", 1).await;
    match a.put("code", "a.txt", None, &v2, 2).await {
        Msg::Conflict {
            current, reason, ..
        } => {
            assert_eq!(reason, "base");
            assert_eq!(current.unwrap().version, 1);
        }
        m => panic!("{m:?}"),
    }
    match a.put("code", "b.txt", None, &other, 5).await {
        Msg::Error { code, .. } => assert_eq!(code, "missing_blob"),
        m => panic!("{m:?}"),
    }
    match a.put("nope", "b.txt", None, &v2, 2).await {
        Msg::Error { code, .. } => assert_eq!(code, "no_space"),
        m => panic!("{m:?}"),
    }

    // a second machine catches up from 0, then sees live changes
    let mut b = hub.client("m_b", "linux").await;
    let id = b.id();
    b.send(&Msg::Subscribe { id, since: 0 }, b"").await;
    match b.push().await.msg {
        Msg::Change(c) => {
            assert_eq!((c.seq, c.op, c.entry.path.as_str()), (1, Op::Put, "a.txt"))
        }
        m => panic!("{m:?}"),
    }
    assert!(matches!(b.push().await.msg, Msg::CaughtUp { seq: 1 }));

    let line = b"{\"type\":\"user\"}\n";
    let tail = match a.append("sessions/s1.jsonl", 0, None, line).await {
        Msg::Committed { seq, entry, .. } => {
            assert_eq!(
                (seq, entry.size, entry.kind),
                (2, line.len() as u64, Kind::Log)
            );
            entry.hash
        }
        m => panic!("{m:?}"),
    };
    let f = b.push().await;
    match &f.msg {
        Msg::Change(c) => {
            assert_eq!(
                (c.seq, c.op, c.offset, c.len, c.inline),
                (2, Op::Append, Some(0), Some(line.len() as u64), true)
            );
            assert_eq!(c.entry.owner.as_deref(), Some("m_a"));
        }
        m => panic!("{m:?}"),
    }
    assert_eq!(f.bin, line);
    match a.append("sessions/s1.jsonl", 0, None, line).await {
        Msg::Conflict { reason, .. } => assert_eq!(reason, "offset"),
        m => panic!("{m:?}"),
    }

    // single writer: the other machine is told who is live
    let id = b.id();
    match b
        .call(
            Msg::Claim {
                id,
                space: "@claude".into(),
                path: "sessions/s1.jsonl".into(),
                force: false,
            },
            b"",
        )
        .await
        .msg
    {
        Msg::Busy {
            owner, owner_name, ..
        } => assert_eq!((owner.as_str(), owner_name.as_str()), ("m_a", "mac")),
        m => panic!("{m:?}"),
    }
    match b
        .append(
            "sessions/s1.jsonl",
            line.len() as u64,
            Some(tail.clone()),
            line,
        )
        .await
    {
        Msg::Conflict { reason, .. } => assert_eq!(reason, "owner"),
        m => panic!("{m:?}"),
    }
    let id = b.id();
    let f = b
        .call(
            Msg::LogRead {
                id,
                space: "@claude".into(),
                path: "sessions/s1.jsonl".into(),
                offset: 0,
                len: 100,
            },
            b"",
        )
        .await;
    assert!(matches!(f.msg, Msg::Blob { eof: true, .. }), "{:?}", f.msg);
    assert_eq!(f.bin, line);

    let id = a.id();
    assert!(matches!(a.call(Msg::Ping { id }, b"").await.msg, Msg::Pong { re } if re == id));

    let id = b.id();
    match b
        .call(
            Msg::Query {
                id,
                query: Query::Status,
            },
            b"",
        )
        .await
        .msg
    {
        Msg::Result { data, .. } => {
            let st: HubStatus = serde_json::from_value(data).unwrap();
            assert_eq!(st.head_seq, 2);
            assert_eq!(st.blobs, 2);
            assert_eq!(st.machines.iter().filter(|m| m.connected).count(), 2);
        }
        m => panic!("{m:?}"),
    }
    // a bad request gets an error and the connection stays usable
    let id = a.id();
    match a
        .call(
            Msg::Ctl {
                id,
                cmd: proto::Ctl::Reload,
            },
            b"",
        )
        .await
        .msg
    {
        Msg::Error { code, re, .. } => assert_eq!((code.as_str(), re), ("bad_request", Some(id))),
        m => panic!("{m:?}"),
    }
    // non-requests are ignored
    a.send(&Msg::Pong { re: 77 }, b"").await;
    let id = a.id();
    assert!(matches!(a.call(Msg::Ping { id }, b"").await.msg, Msg::Pong { re } if re == id));
    drop((a, b));
    hub.stop().await;
}

#[tokio::test]
async fn catch_up_and_live_have_no_gaps_or_duplicates() {
    let hub = TestHub::start(None, None).await;
    let mut writer = hub.client("m_w", "writer").await;
    let mut reader = hub.client("m_r", "reader").await;
    const N: u64 = 150;
    let w = tokio::spawn(async move {
        let mut tail = None;
        let mut size = 0u64;
        for i in 0..N {
            let line = format!("{{\"n\":{i}}}\n");
            match writer
                .append("sessions/busy.jsonl", size, tail.clone(), line.as_bytes())
                .await
            {
                Msg::Committed { entry, .. } => {
                    size = entry.size;
                    tail = Some(entry.hash);
                }
                m => panic!("{m:?}"),
            }
        }
        size
    });
    // subscribe while the writer is busy
    tokio::time::sleep(Duration::from_millis(20)).await;
    let id = reader.id();
    reader.send(&Msg::Subscribe { id, since: 0 }, b"").await;
    let mut seqs = Vec::new();
    let mut caught = None;
    let mut content = Vec::new();
    while seqs.last() != Some(&N) {
        let f = reader.push().await;
        match f.msg {
            Msg::Change(c) => {
                assert!(c.inline);
                assert_eq!(c.offset, Some(content.len() as u64));
                content.extend_from_slice(&f.bin);
                if let Some(cs) = caught {
                    assert!(c.seq > cs, "live change {} not after CaughtUp {cs}", c.seq);
                }
                seqs.push(c.seq);
            }
            Msg::CaughtUp { seq } => {
                assert!(caught.is_none(), "CaughtUp sent twice");
                assert_eq!(Some(&seq), seqs.last());
                caught = Some(seq);
            }
            m => panic!("{m:?}"),
        }
    }
    assert_eq!(seqs, (1..=N).collect::<Vec<_>>());
    assert!(caught.is_some());
    let size = w.await.unwrap();
    assert_eq!(content.len() as u64, size);
    hub.stop().await;
}

#[tokio::test]
async fn handshake_rejections() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let addr = format!("127.0.0.1:{port}");
    let hub = TestHub::start(Some(addr.clone()), Some("s3cret")).await;
    let tcp = HubAddr::parse(&format!("tcp://{addr}")).unwrap();

    let mut c = Client::open(transport::connect(&tcp, None, &hub.home).await.unwrap()).await;
    match c.hello("m_t", "t", Some("wrong"), PROTO_VERSION).await.msg {
        Msg::Error { code, re, .. } => assert_eq!((code.as_str(), re), ("auth", Some(1))),
        m => panic!("{m:?}"),
    }
    let mut c = Client::open(transport::connect(&tcp, None, &hub.home).await.unwrap()).await;
    match c.hello("m_t", "t", None, PROTO_VERSION).await.msg {
        Msg::Error { code, .. } => assert_eq!(code, "auth"),
        m => panic!("{m:?}"),
    }
    let mut c = Client::open(transport::connect(&tcp, None, &hub.home).await.unwrap()).await;
    assert!(matches!(
        c.hello("m_t", "t", Some("s3cret"), PROTO_VERSION).await.msg,
        Msg::Welcome { .. }
    ));

    let unix = HubAddr::Unix(hub.sock());
    let mut c = Client::open(transport::connect(&unix, None, &hub.home).await.unwrap()).await;
    match c.hello("m_u", "u", None, PROTO_VERSION + 1).await.msg {
        Msg::Error { code, .. } => assert_eq!(code, "proto"),
        m => panic!("{m:?}"),
    }
    let mut c = Client::open(transport::connect(&unix, None, &hub.home).await.unwrap()).await;
    c.send(&Msg::Ping { id: 1 }, b"").await;
    match c.recv().await.msg {
        Msg::Error { code, .. } => assert_eq!(code, "proto"),
        m => panic!("{m:?}"),
    }

    // a second hub on the same UC_HOME refuses to start
    let opts = HubOpts {
        uc_home: hub.home.clone(),
        tcp: None,
        token: None,
        lease_idle_ms: DEFAULT_LEASE_IDLE_MS,
    };
    let err = serve_with_shutdown(opts, async {}).await.unwrap_err();
    assert!(format!("{err:#}").contains("already running"), "{err:#}");
    hub.stop().await;
}

#[tokio::test]
async fn tcp_requires_token() {
    let dir = tempfile::Builder::new()
        .prefix("uc")
        .tempdir_in("/tmp")
        .unwrap();
    let opts = HubOpts {
        uc_home: dir.path().to_path_buf(),
        tcp: Some("127.0.0.1:0".into()),
        token: None,
        lease_idle_ms: DEFAULT_LEASE_IDLE_MS,
    };
    let err = serve_with_shutdown(opts, async {}).await.unwrap_err();
    assert!(format!("{err:#}").contains("UC_TOKEN"), "{err:#}");
}

#[tokio::test]
async fn state_survives_restart_and_resubscribe_resumes_at_cursor() {
    let hub = TestHub::start(None, None).await;
    let mut a = hub.client("m_a", "mac").await;
    let mut tail = None;
    let mut size = 0;
    for line in [&b"1\n"[..], b"22\n", b"333\n"] {
        match a.append("sessions/r.jsonl", size, tail.clone(), line).await {
            Msg::Committed { entry, .. } => {
                size = entry.size;
                tail = Some(entry.hash);
            }
            m => panic!("{m:?}"),
        }
    }
    drop(a);
    let hub_id = |f: Frame| match f.msg {
        Msg::Welcome {
            hub_id, head_seq, ..
        } => (hub_id, head_seq),
        m => panic!("{m:?}"),
    };
    let mut probe = Client::open(
        transport::connect(&HubAddr::Unix(hub.sock()), None, &hub.home)
            .await
            .unwrap(),
    )
    .await;
    let before = hub_id(probe.hello("m_p", "p", None, PROTO_VERSION).await);
    drop(probe);

    let hub = hub.restart().await;
    let mut b = Client::open(
        transport::connect(&HubAddr::Unix(hub.sock()), None, &hub.home)
            .await
            .unwrap(),
    )
    .await;
    // the same machine reconnecting after the restart
    assert_eq!(
        hub_id(b.hello("m_a", "mac", None, PROTO_VERSION).await),
        before
    );
    assert_eq!(before.1, 3);
    let id = b.id();
    b.send(&Msg::Subscribe { id, since: 2 }, b"").await;
    let f = b.push().await;
    match &f.msg {
        Msg::Change(c) => assert_eq!((c.seq, c.offset, c.inline), (3, Some(5), true)),
        m => panic!("{m:?}"),
    }
    assert_eq!(f.bin, b"333\n");
    assert!(matches!(b.push().await.msg, Msg::CaughtUp { seq: 3 }));
    // appends continue on the persisted log
    match b.append("sessions/r.jsonl", size, tail, b"4444\n").await {
        Msg::Committed { seq, entry, .. } => assert_eq!((seq, entry.size), (4, 14)),
        m => panic!("{m:?}"),
    }
    drop(b);
    hub.stop().await;
}

#[tokio::test]
async fn stdio_bridge_to_a_real_hub() {
    // What `uc hub connect` does over ssh: the client's bytes arrive on stdin, the hub's leave on
    // stdout. Input ends after a ping; the bridge still delivers the hub's answers, then returns.
    let hub = TestHub::start(None, None).await;
    let mut input = b"Last login: yesterday\n".to_vec();
    proto::write_magic(&mut input).await.unwrap();
    let hello = Msg::Hello {
        id: 1,
        proto: PROTO_VERSION,
        machine: MachineInfo {
            id: "m_s".into(),
            name: "ssh".into(),
            os: "linux".into(),
            home: "/home/s".into(),
        },
        version: "test".into(),
        token: None,
    };
    proto::write_frame(&mut input, &hello, b"").await.unwrap();
    proto::write_frame(&mut input, &Msg::Ping { id: 2 }, b"")
        .await
        .unwrap();
    let sock = std::os::unix::net::UnixStream::connect(hub.sock()).unwrap();
    let output = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        transport::bridge(std::io::Cursor::new(input), &mut out, sock).map(|_| out)
    })
    .await
    .unwrap()
    .unwrap();
    let mut r = &output[..];
    proto::read_magic(&mut r).await.unwrap();
    let welcome = proto::read_frame(&mut r).await.unwrap().unwrap();
    assert!(
        matches!(welcome.msg, Msg::Welcome { re: 1, .. }),
        "{:?}",
        welcome.msg
    );
    let pong = proto::read_frame(&mut r).await.unwrap().unwrap();
    assert!(matches!(pong.msg, Msg::Pong { re: 2 }), "{:?}", pong.msg);
    assert!(proto::read_frame(&mut r).await.unwrap().is_none());
    hub.stop().await;
}
