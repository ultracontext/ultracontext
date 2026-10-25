//! Two (or more) machines sharing one in-memory hub: the session-sync scenarios that must
//! hold before the real hub is wired in.

use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use super::mock::{MemStore, MockClient, MockHub};
use super::{BusyError, Deps, LogSync, Tunables};
use crate::config::{Config, SpaceConfig};
use crate::drivers::claude::{slug, Claude};
use crate::drivers::codex::Codex;
use crate::drivers::AgentDriver;
use crate::paths::Paths;
use crate::proto::{Change, SessionMeta};

struct M {
    _dir: tempfile::TempDir,
    name: String,
    home: PathBuf,
    claude: PathBuf,
    codex: PathBuf,
    uc: PathBuf,
    ls: Arc<LogSync>,
    client: Arc<MockClient>,
    rx: mpsc::UnboundedReceiver<(Change, Vec<u8>)>,
}

impl M {
    fn new(hub: &Arc<MockHub>, name: &str, home_rel: &str) -> M {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        // physical path: Claude slugs physical cwds, and macOS /tmp is a symlink
        let home = dir.path().canonicalize().unwrap().join(home_rel);
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        let uc = home.join(".ultracontext");
        for d in [&claude, &codex, &uc, &home.join("Code/proj")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let mut cfg = Config::new_for_this_machine();
        cfg.machine_id = format!("m_{name}");
        cfg.machine_name = name.to_string();
        cfg.hub = "mock".into();
        cfg.spaces = vec![SpaceConfig {
            name: "code".into(),
            path: home.join("Code").to_string_lossy().to_string(),
        }];
        let machine = crate::proto::MachineInfo {
            id: cfg.machine_id.clone(),
            name: name.to_string(),
            os: "test".into(),
            home: home.to_string_lossy().to_string(),
        };
        let (client, rx) = hub.connect(&machine);
        let deps = Deps {
            hub: client.clone(),
            store: Arc::new(MemStore::default()),
            machine,
            paths: Paths::new(uc.clone()),
            home: home.clone(),
            cfg: Arc::new(move || cfg.clone()),
            on_error: None,
            tun: Tunables {
                debounce: Duration::ZERO,
                hot_ms: 0,
                cold_ms: 0,
                resume_timeout: Duration::from_secs(5),
            },
        };
        let drivers: Vec<Arc<dyn AgentDriver>> = vec![
            Arc::new(Claude::with_root(claude.clone())),
            Arc::new(Codex::with_root(codex.clone())),
        ];
        M {
            _dir: dir,
            name: name.into(),
            home,
            claude,
            codex,
            uc,
            ls: LogSync::with_deps(deps, drivers),
            client,
            rx,
        }
    }

    async fn pump(&mut self) {
        while let Ok((c, b)) = self.rx.try_recv() {
            self.ls.on_remote(c, b).await.unwrap();
        }
        self.ls.tick(true).await.unwrap();
    }

    async fn changed(&self, p: &Path) {
        self.ls.on_local(p.to_path_buf()).await;
    }

    fn proj(&self) -> PathBuf {
        self.home.join("Code/proj")
    }

    fn transcript(&self, sid: &str) -> PathBuf {
        self.claude
            .join("projects")
            .join(slug(&self.proj().to_string_lossy()))
            .join(format!("{sid}.jsonl"))
    }

    /// Every Claude transcript file on this machine.
    fn transcripts(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(self.claude.join("projects")) else {
            return out;
        };
        for d in rd.flatten() {
            for f in std::fs::read_dir(d.path()).unwrap().flatten() {
                if f.path().extension().is_some_and(|e| e == "jsonl") {
                    out.push(f.path());
                }
            }
        }
        out.sort();
        out
    }

    /// Pretend a Claude process (this test process) is running `sid` here.
    fn claude_live(&self, sid: &str, live: bool) {
        let dir = self.claude.join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let pid = std::process::id();
        let p = dir.join(format!("{pid}.json"));
        if live {
            std::fs::write(
                &p,
                format!(r#"{{"pid":{pid},"sessionId":"{sid}","cwd":"x"}}"#),
            )
            .unwrap();
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }

    fn trash_files(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(self.uc.join("trash")) else {
            return out;
        };
        for d in rd.flatten() {
            for f in std::fs::read_dir(d.path()).unwrap().flatten() {
                out.push(f.path());
            }
        }
        out
    }
}

async fn settle(ms: &mut [&mut M]) {
    for _ in 0..4 {
        for m in ms.iter_mut() {
            m.pump().await;
        }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn user_line(sid: &str, cwd: &Path, uuid: &str, text: &str) -> String {
    format!(
        r#"{{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"{}","sessionId":"{sid}","version":"2.1.310","gitBranch":"main","type":"user","message":{{"role":"user","content":"{text}"}},"uuid":"{uuid}","timestamp":"{}"}}"#,
        cwd.display(),
        now_iso()
    )
}

fn tool_line(sid: &str, cwd: &Path, uuid: &str, parent: &str, file: &Path) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"cwd":"{}","sessionId":"{sid}","type":"assistant","message":{{"role":"assistant","model":"claude-opus-5-5","content":[{{"type":"tool_use","id":"toolu_1","name":"Read","input":{{"file_path":"{}"}}}}]}},"uuid":"{uuid}","timestamp":"{}"}}"#,
        cwd.display(),
        file.display(),
        now_iso()
    )
}

fn append(p: &Path, s: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .unwrap();
    f.write_all(s.as_bytes()).unwrap();
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// mac starts a Claude session in ~/Code/proj and syncs it.
async fn mac_session(mac: &mut M) -> (String, PathBuf) {
    let sid = uuid::Uuid::new_v4().to_string();
    let p = mac.transcript(&sid);
    let cwd = mac.proj();
    append(
        &p,
        &(user_line(&sid, &cwd, "u1", "read the main file") + "\n"),
    );
    append(
        &p,
        &(tool_line(&sid, &cwd, "a1", "u1", &cwd.join("src/main.rs")) + "\n"),
    );
    mac.changed(&p).await;
    mac.pump().await;
    (sid, p)
}

fn translate(text: &str, from: &M, to: &M) -> String {
    text.replace(
        &from.home.to_string_lossy().to_string(),
        &to.home.to_string_lossy(),
    )
}

#[tokio::test]
async fn a_claude_session_appears_on_linux_with_linux_paths() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;

    let canon = String::from_utf8(
        hub.log("@claude", &format!("sessions/{sid}.jsonl"))
            .unwrap(),
    )
    .unwrap();
    assert!(
        canon.contains("@@UC_SPACE:code@@/proj/src/main.rs"),
        "{canon}"
    );
    assert!(
        !canon.contains(&*mac.home.to_string_lossy()),
        "no mac paths on the hub"
    );
    let meta = SessionMeta::from_meta(
        hub.entry("@claude", &format!("sessions/{sid}.jsonl"))
            .unwrap()
            .meta
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(meta.cwd.as_deref(), Some("@@UC_SPACE:code@@/proj"));
    assert_eq!(meta.first_prompt.as_deref(), Some("read the main file"));

    settle(&mut [&mut mac, &mut lin]).await;
    let lin_path = lin.transcript(&sid);
    assert_eq!(
        lin.transcripts(),
        vec![lin_path.clone()],
        "exactly one transcript, at the linux slug"
    );
    assert_eq!(read(&lin_path), translate(&read(&mac_path), &mac, &lin));
    assert!(read(&lin_path).contains(&format!("{}/Code/proj/src/main.rs", lin.home.display())));
    // the hub only ever got one session
    assert_eq!(hub.paths("@claude"), vec![format!("sessions/{sid}.jsonl")]);
}

#[tokio::test]
async fn b_linux_continues_after_takeover_and_mac_follows() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    settle(&mut [&mut mac, &mut lin]).await;

    let plan = lin.ls.resume(None, &sid[..8], true, false).await.unwrap();
    assert!(plan.took_over);
    assert_eq!(plan.id, sid);
    assert_eq!(plan.cwd, lin.proj().to_string_lossy());
    assert!(!plan.cwd_missing);
    assert_eq!(
        plan.argv,
        vec!["claude".to_string(), "--resume".into(), sid.clone()]
    );
    assert_eq!(PathBuf::from(&plan.native_path), lin.transcript(&sid));

    // `claude --resume` on linux appends to the same file
    let lin_path = lin.transcript(&sid);
    let lin_line = user_line(&sid, &lin.proj(), "u2", "now on linux");
    append(&lin_path, &format!("{lin_line}\n"));
    lin.changed(&lin_path).await;
    settle(&mut [&mut mac, &mut lin]).await;

    assert_eq!(
        hub.entry("@claude", &format!("sessions/{sid}.jsonl"))
            .unwrap()
            .owner
            .as_deref(),
        Some("m_linux")
    );
    let mac_text = read(&mac_path);
    assert!(
        mac_text.ends_with(&format!("{}\n", translate(&lin_line, &lin, &mac))),
        "{mac_text}"
    );
    assert_eq!(read(&mac_path), translate(&read(&lin_path), &lin, &mac));
    assert_eq!(mac.transcripts().len(), 1);
    assert_eq!(lin.transcripts().len(), 1);
}

#[tokio::test]
async fn c_live_owner_is_busy_unless_takeover() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, _) = mac_session(&mut mac).await;
    settle(&mut [&mut mac, &mut lin]).await;

    let err = lin
        .ls
        .resume(Some("claude"), &sid, false, false)
        .await
        .unwrap_err();
    let busy = err.downcast_ref::<BusyError>().expect("BusyError");
    assert_eq!(busy.owner_name, "mac");
    assert!(err.to_string().starts_with("busy: session is live on mac"));

    let plan = lin
        .ls
        .resume(Some("claude"), &sid, true, false)
        .await
        .unwrap();
    assert!(plan.took_over);
    // once the lease is idle no takeover is needed
    let mut lin2 = M::new(&hub, "box2", "home/other");
    hub.advance(200_000);
    let plan = lin2.ls.resume(None, &sid, false, false).await.unwrap();
    assert!(!plan.took_over);
    lin2.pump().await;
}

#[tokio::test]
async fn d_old_owner_writing_after_takeover_forks() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    mac.claude_live(&sid, true);
    settle(&mut [&mut mac, &mut lin]).await;
    lin.ls.resume(None, &sid, true, false).await.unwrap();
    let canon_path = format!("sessions/{sid}.jsonl");
    let canon_before = hub.log("@claude", &canon_path).unwrap();

    // the old mac process keeps writing
    let stray = user_line(&sid, &mac.proj(), "u9", "stray mac line");
    append(&mac_path, &format!("{stray}\n"));
    mac.changed(&mac_path).await;
    settle(&mut [&mut mac, &mut lin]).await;

    assert_eq!(
        hub.log("@claude", &canon_path).unwrap(),
        canon_before,
        "canonical untouched"
    );
    let forks: Vec<String> = hub
        .paths("@claude")
        .into_iter()
        .filter(|p| *p != canon_path)
        .collect();
    assert_eq!(forks.len(), 1, "{forks:?}");
    let fork = &forks[0];
    let fork_id = fork
        .trim_start_matches("sessions/")
        .trim_end_matches(".jsonl")
        .to_string();
    let fmeta =
        SessionMeta::from_meta(hub.entry("@claude", fork).unwrap().meta.as_ref().unwrap()).unwrap();
    assert_eq!(fmeta.forked_from.as_deref(), Some(sid.as_str()));
    assert_eq!(fmeta.id, fork_id);
    let ftext = String::from_utf8(hub.log("@claude", fork).unwrap()).unwrap();
    assert!(
        ftext.contains("stray mac line") && !ftext.contains(&sid),
        "{ftext}"
    );

    // more stray lines go to the same fork
    append(
        &mac_path,
        &format!("{}\n", user_line(&sid, &mac.proj(), "u10", "second stray")),
    );
    mac.changed(&mac_path).await;
    // linux keeps working on the canonical session
    let lin_path = lin.transcript(&sid);
    append(
        &lin_path,
        &format!("{}\n", user_line(&sid, &lin.proj(), "u3", "linux line")),
    );
    lin.changed(&lin_path).await;
    settle(&mut [&mut mac, &mut lin]).await;
    assert!(String::from_utf8(hub.log("@claude", fork).unwrap())
        .unwrap()
        .contains("second stray"));
    assert_eq!(hub.paths("@claude").len(), 2, "still one fork");
    assert!(
        !read(&mac_path).contains("linux line"),
        "live original is never touched"
    );

    // the mac process exits: original goes to trash, both sessions come back from the hub
    mac.claude_live(&sid, false);
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(mac.trash_files().len(), 1);
    let mac_canon = read(&mac_path);
    assert!(
        mac_canon.contains("linux line") && !mac_canon.contains("stray"),
        "{mac_canon}"
    );
    let mac_fork = read(&mac.transcript(&fork_id));
    assert!(mac_fork.contains("second stray") && mac_fork.contains(&fork_id));
    assert_eq!(mac.transcripts().len(), 2);
    // linux got the fork as a separate session; its canonical is untouched by it
    assert!(lin.transcript(&fork_id).exists());
    assert!(!read(&lin_path).contains("stray"));
}

#[tokio::test]
async fn e_codex_rollout_is_byte_exact_and_resumes_with_local_cwd() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let tid = uuid::Uuid::new_v4().to_string();
    let rel = format!("sessions/2026/10/25/rollout-2026-10-25T06-57-52-{tid}.jsonl");
    let mac_file = mac.codex.join(&rel);
    let cwd = mac.proj();
    let ts = now_iso();
    append(
        &mac_file,
        &format!(
            "{}\n{}\n",
            format!(
                r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{tid}","timestamp":"{ts}","cwd":"{}","originator":"codex_cli_rs","cli_version":"0.162.1","source":"cli","model_provider":"openai"}}}}"#,
                cwd.display()
            ),
            format!(
                r#"{{"timestamp":"{ts}","ordinal":1,"type":"event_msg","payload":{{"type":"user_message","message":"edit {}/lib.rs"}}}}"#,
                cwd.display()
            ),
        ),
    );
    mac.changed(&mac_file).await;
    settle(&mut [&mut mac, &mut lin]).await;

    let lin_file = lin.codex.join(&rel);
    assert_eq!(
        std::fs::read(&lin_file).unwrap(),
        std::fs::read(&mac_file).unwrap(),
        "byte-exact, same relative path"
    );
    let e = hub
        .entry("@codex", &format!("sessions/{tid}.jsonl"))
        .unwrap();
    let meta = SessionMeta::from_meta(e.meta.as_ref().unwrap()).unwrap();
    assert_eq!(meta.cwd.as_deref(), Some("@@UC_SPACE:code@@/proj"));
    assert_eq!(meta.native_rel.as_deref(), Some(rel.as_str()));

    hub.advance(200_000);
    let plan = lin
        .ls
        .resume(Some("codex"), &tid, false, false)
        .await
        .unwrap();
    assert_eq!(
        plan.argv,
        vec![
            "codex".to_string(),
            "resume".into(),
            "-C".into(),
            lin.proj().to_string_lossy().to_string(),
            tid.clone()
        ]
    );
    assert_eq!(PathBuf::from(plan.native_path), lin_file);
}

#[tokio::test]
async fn f_codex_live_writer_lock_blocks_remote_appends() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let tid = uuid::Uuid::new_v4().to_string();
    let rel = format!("sessions/2026/10/25/rollout-2026-10-25T07-00-00-{tid}.jsonl");
    let mac_file = mac.codex.join(&rel);
    let ts = now_iso();
    append(
        &mac_file,
        &format!(
            r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{tid}","timestamp":"{ts}","cwd":"{}"}}}}"#,
            mac.proj().display()
        ),
    );
    append(&mac_file, "\n");
    mac.changed(&mac_file).await;
    settle(&mut [&mut mac, &mut lin]).await;
    let lin_file = lin.codex.join(&rel);
    assert!(lin_file.exists());

    // a Codex on linux holds the thread's writer lock
    let locks = lin.codex.join("thread-writer-locks");
    std::fs::create_dir_all(&locks).unwrap();
    let lock = std::fs::File::create(locks.join(format!("{tid}.lock"))).unwrap();
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );

    append(
        &mac_file,
        &format!(
            r#"{{"timestamp":"{ts}","ordinal":2,"type":"event_msg","payload":{{"type":"agent_message","message":"done"}}}}"#
        ),
    );
    append(&mac_file, "\n");
    mac.changed(&mac_file).await;
    settle(&mut [&mut mac, &mut lin]).await;
    assert_ne!(
        std::fs::read(&lin_file).unwrap(),
        std::fs::read(&mac_file).unwrap(),
        "not applied under a live writer"
    );
    assert!(lin.ls.pending().down >= 1);

    unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) };
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(
        std::fs::read(&lin_file).unwrap(),
        std::fs::read(&mac_file).unwrap()
    );
    assert_eq!(lin.ls.pending().down, 0);
}

#[tokio::test]
async fn g_partial_last_line_waits_until_complete() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let sid = uuid::Uuid::new_v4().to_string();
    let p = mac.transcript(&sid);
    let l1 = user_line(&sid, &mac.proj(), "u1", "first");
    let l2 = user_line(&sid, &mac.proj(), "u2", "second");
    let (half_a, half_b) = l2.split_at(40);
    append(&p, &format!("{l1}\n{half_a}"));
    mac.changed(&p).await;
    mac.pump().await;
    let canon = format!("sessions/{sid}.jsonl");
    let got = String::from_utf8(hub.log("@claude", &canon).unwrap()).unwrap();
    assert_eq!(got.lines().count(), 1);
    assert!(got.ends_with('\n') && got.contains("first") && !got.contains("u2"));

    append(&p, &format!("{half_b}\n"));
    mac.changed(&p).await;
    mac.pump().await;
    let got = String::from_utf8(hub.log("@claude", &canon).unwrap()).unwrap();
    assert_eq!(got.lines().count(), 2);
    assert!(got.contains("second"));
    assert_eq!(mac.ls.pending().up, 0);
}

#[tokio::test]
async fn h_offline_divergence_on_both_sides_makes_one_fork_and_loses_nothing() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    settle(&mut [&mut mac, &mut lin]).await;
    let lin_path = lin.transcript(&sid);
    assert!(lin_path.exists());

    mac.client.online.store(false, Ordering::SeqCst);
    lin.client.online.store(false, Ordering::SeqCst);
    append(
        &mac_path,
        &format!("{}\n", user_line(&sid, &mac.proj(), "m1", "offline on mac")),
    );
    append(
        &lin_path,
        &format!(
            "{}\n",
            user_line(&sid, &lin.proj(), "l1", "offline on linux")
        ),
    );
    mac.changed(&mac_path).await;
    lin.changed(&lin_path).await;
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(mac.ls.pending().up, 1);

    hub.advance(200_000);
    mac.client.online.store(true, Ordering::SeqCst);
    settle(&mut [&mut mac]).await;
    lin.client.online.store(true, Ordering::SeqCst);
    settle(&mut [&mut mac, &mut lin]).await;

    let canon = format!("sessions/{sid}.jsonl");
    let paths = hub.paths("@claude");
    assert_eq!(paths.len(), 2, "one canonical + one fork: {paths:?}");
    let ctext = String::from_utf8(hub.log("@claude", &canon).unwrap()).unwrap();
    assert!(ctext.contains("offline on mac") && !ctext.contains("offline on linux"));
    let fork = paths.iter().find(|p| **p != canon).unwrap();
    let fork_id = fork
        .trim_start_matches("sessions/")
        .trim_end_matches(".jsonl")
        .to_string();
    let ftext = String::from_utf8(hub.log("@claude", fork).unwrap()).unwrap();
    assert!(ftext.contains("offline on linux") && ftext.contains("read the main file"));
    assert_eq!(
        SessionMeta::from_meta(hub.entry("@claude", fork).unwrap().meta.as_ref().unwrap())
            .unwrap()
            .forked_from
            .as_deref(),
        Some(sid.as_str())
    );

    // both machines converge: canonical everywhere, the fork everywhere, linux's original in trash
    assert_eq!(read(&lin_path), translate(&read(&mac_path), &mac, &lin));
    assert!(read(&lin_path).contains("offline on mac"));
    assert_eq!(
        read(&lin.transcript(&fork_id)),
        translate(&read(&mac.transcript(&fork_id)), &mac, &lin)
    );
    assert_eq!(lin.trash_files().len(), 1);
    assert!(read(&lin.trash_files()[0]).contains("offline on linux"));
    assert_eq!(mac.transcripts().len(), 2);
    assert_eq!(lin.transcripts().len(), 2);
    assert_eq!(mac.ls.pending(), crate::client::Pending::default());
    assert_eq!(lin.ls.pending(), crate::client::Pending::default());
    let _ = (&mac.name, &lin.name);
}

#[tokio::test]
async fn owner_rewrite_resets_hub_log() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    append(
        &mac_path,
        &format!("{}\n", user_line(&sid, &mac.proj(), "t1", "tombstoned")),
    );
    mac.changed(&mac_path).await;
    settle(&mut [&mut mac, &mut lin]).await;
    // Claude removes a tombstoned tail line in place: the file shrinks
    let text = read(&mac_path);
    let keep: String = text.lines().take(2).map(|l| format!("{l}\n")).collect();
    std::fs::write(&mac_path, &keep).unwrap();
    mac.changed(&mac_path).await;
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(
        hub.paths("@claude").len(),
        1,
        "owner rewrite is a reset, not a fork"
    );
    assert!(!String::from_utf8(
        hub.log("@claude", &format!("sessions/{sid}.jsonl"))
            .unwrap()
    )
    .unwrap()
    .contains("tombstoned"));
    assert_eq!(read(&lin.transcript(&sid)), translate(&keep, &mac, &lin));
}

#[tokio::test]
async fn resume_fork_and_ambiguous_ids() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, _) = mac_session(&mut mac).await;
    settle(&mut [&mut mac, &mut lin]).await;

    let plan = lin.ls.resume(None, &sid, false, true).await.unwrap();
    let new = plan.forked_to.clone().unwrap();
    assert_eq!(plan.id, new);
    assert!(PathBuf::from(&plan.native_path).ends_with(format!("{new}.jsonl")));
    assert!(read(Path::new(&plan.native_path)).contains(&new));
    assert_eq!(
        hub.entry("@claude", &format!("sessions/{sid}.jsonl"))
            .unwrap()
            .owner
            .as_deref(),
        Some("m_mac")
    );

    let err = lin
        .ls
        .resume(None, "nope-nope", false, false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no session matches"));
    // "read the main" matches both the original and the fork
    let err = lin
        .ls
        .resume(None, "read the main", false, false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("matches 2 sessions"), "{err}");
}

#[tokio::test]
async fn rescan_pushes_existing_sessions_and_localize_fills_cwd() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let sid = uuid::Uuid::new_v4().to_string();
    let p = mac.transcript(&sid);
    append(
        &p,
        &format!(
            "{}\n",
            user_line(&sid, &mac.proj(), "u1", "made before uc ran")
        ),
    );
    // not classified: never synced
    append(&mac.claude.join("history.jsonl"), "{}\n");
    append(&mac.claude.join(".credentials.json"), "{}\n");
    mac.ls.rescan().await.unwrap();
    mac.pump().await;
    assert_eq!(hub.paths("@claude"), vec![format!("sessions/{sid}.jsonl")]);

    let mut lin = M::new(&hub, "linux", "home/fabio");
    // linux was offline when it happened: it learns the session from the startup listing
    while lin.rx.try_recv().is_ok() {}
    lin.ls.rescan().await.unwrap();
    lin.pump().await;
    assert!(lin.transcript(&sid).exists());
    let v = lin.client.as_ref();
    let list = super::LogHub::query(
        v,
        crate::proto::Query::Sessions {
            agent: None,
            machine: None,
            text: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    let mut sessions: Vec<crate::proto::SessionInfo> = serde_json::from_value(list).unwrap();
    lin.ls.localize(&mut sessions);
    assert_eq!(
        sessions[0].local_cwd.as_deref(),
        Some(&*lin.proj().to_string_lossy())
    );
    assert!(sessions[0].local);
}

#[tokio::test]
async fn sidecars_follow_their_transcript() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    let side = mac_path.parent().unwrap().join(&sid);
    let agent_log = side.join("subagents/agent-a1.jsonl");
    let tool_txt = side.join("tool-results/toolu_1.txt");
    let fh = mac.claude.join(format!("file-history/{sid}/abc@v1"));
    append(
        &agent_log,
        &format!("{}\n", user_line(&sid, &mac.proj(), "s1", "subagent task")),
    );
    append(&tool_txt, "big tool output\n");
    append(&fh, "old file body\n");
    for p in [&agent_log, &tool_txt, &fh] {
        mac.changed(p).await;
    }
    settle(&mut [&mut mac, &mut lin]).await;

    let lside = lin.transcript(&sid).parent().unwrap().join(&sid);
    assert_eq!(
        read(&lside.join("subagents/agent-a1.jsonl")),
        translate(&read(&agent_log), &mac, &lin)
    );
    assert_eq!(
        read(&lside.join("tool-results/toolu_1.txt")),
        "big tool output\n"
    );
    assert_eq!(
        read(&lin.claude.join(format!("file-history/{sid}/abc@v1"))),
        "old file body\n"
    );
    assert_eq!(lin.ls.pending(), crate::client::Pending::default());
    // unchanged files are not pushed again
    let tool_canon = format!("sessions/{sid}/tool-results/toolu_1.txt");
    let before = hub.entry("@claude", &tool_canon).unwrap().version;
    mac.changed(&tool_txt).await;
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(hub.entry("@claude", &tool_canon).unwrap().version, before);
    // a takeover moves the subagent logs along with the transcript
    lin.ls.resume(None, &sid, true, false).await.unwrap();
    let sub = format!("sessions/{sid}/subagents/agent-a1.jsonl");
    assert_eq!(
        hub.entry("@claude", &sub).unwrap().owner.as_deref(),
        Some("m_linux")
    );
}

#[tokio::test]
async fn torn_tail_from_dead_writer_is_cut_before_remote_lines() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    settle(&mut [&mut mac, &mut lin]).await;
    let lin_path = lin.transcript(&sid);
    append(&lin_path, "{\"type\":\"user\",\"mess");
    append(
        &mac_path,
        &format!("{}\n", user_line(&sid, &mac.proj(), "u5", "after crash")),
    );
    mac.changed(&mac_path).await;
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(read(&lin_path), translate(&read(&mac_path), &mac, &lin));
    assert_eq!(lin.trash_files().len(), 1);
}

#[tokio::test]
async fn follower_pruned_copy_is_restored_not_forked() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    settle(&mut [&mut mac, &mut lin]).await;
    let lin_path = lin.transcript(&sid);
    let first: String = read(&lin_path)
        .lines()
        .take(1)
        .map(|l| format!("{l}\n"))
        .collect();
    std::fs::write(&lin_path, first).unwrap();
    lin.changed(&lin_path).await;
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(
        hub.paths("@claude").len(),
        1,
        "no fork for a pruned follower copy"
    );
    assert_eq!(read(&lin_path), translate(&read(&mac_path), &mac, &lin));
    assert_eq!(lin.trash_files().len(), 1);
}

#[tokio::test]
async fn relocation_on_owner_moves_follower_copy() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let (sid, mac_path) = mac_session(&mut mac).await;
    settle(&mut [&mut mac, &mut lin]).await;
    // Claude on mac enters a worktree: the transcript moves to the new project dir
    let wt = mac.proj().join(".wt");
    let moved = mac
        .claude
        .join("projects")
        .join(slug(&wt.to_string_lossy()))
        .join(format!("{sid}.jsonl"));
    std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
    std::fs::rename(&mac_path, &moved).unwrap();
    append(
        &moved,
        &format!(
            "{{\"type\":\"relocated\",\"relocatedCwd\":\"{}\",\"sessionId\":\"{sid}\"}}\n",
            wt.display()
        ),
    );
    mac.changed(&mac_path).await;
    mac.changed(&moved).await;
    settle(&mut [&mut mac, &mut lin]).await;

    assert_eq!(hub.paths("@claude").len(), 1, "a move is not a new session");
    let lin_wt = lin.proj().join(".wt");
    let lin_moved = lin
        .claude
        .join("projects")
        .join(slug(&lin_wt.to_string_lossy()))
        .join(format!("{sid}.jsonl"));
    assert_eq!(lin.transcripts(), vec![lin_moved.clone()]);
    assert_eq!(read(&lin_moved), translate(&read(&moved), &mac, &lin));
}

#[tokio::test]
async fn resume_where_it_is_already_running() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let (sid, mac_path) = mac_session(&mut mac).await;
    mac.claude_live(&sid, true);
    let plan = mac.ls.resume(None, &sid, false, false).await.unwrap();
    assert!(!plan.took_over);
    assert_eq!(PathBuf::from(plan.native_path), mac_path);
    mac.claude_live(&sid, false);
}

#[tokio::test]
async fn existing_copy_in_another_project_dir_is_reused_not_duplicated() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let (sid, mac_path) = mac_session(&mut mac).await;
    let mut lin = M::new(&hub, "linux", "home/fabio");
    // linux already has this session (copied by hand) under some other project dir
    let stray = lin
        .claude
        .join(format!("projects/-somewhere-else/{sid}.jsonl"));
    append(&stray, &translate(&read(&mac_path), &mac, &lin));
    lin.ls.rescan().await.unwrap();
    settle(&mut [&mut mac, &mut lin]).await;
    assert_eq!(
        lin.transcripts(),
        vec![stray.clone()],
        "the existing copy is adopted, not duplicated"
    );
    assert_eq!(hub.paths("@claude").len(), 1);
    // and it keeps following the hub where it is
    let line = user_line(&sid, &mac.proj(), "u7", "more from mac");
    append(&mac_path, &format!("{line}\n"));
    mac.changed(&mac_path).await;
    hub.advance(1);
    settle(&mut [&mut mac, &mut lin]).await;
    // once in sync it moves to the project dir of its cwd, still as a single copy
    assert_eq!(lin.transcripts(), vec![lin.transcript(&sid)]);
    assert!(read(&lin.transcript(&sid)).contains("more from mac"));
}

#[tokio::test]
async fn codex_divergence_forks_with_same_timestamp_name() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let tid = uuid::Uuid::new_v4().to_string();
    let rel = format!("sessions/2026/10/25/rollout-2026-10-25T08-00-00-{tid}.jsonl");
    let mac_file = mac.codex.join(&rel);
    let ts = now_iso();
    append(
        &mac_file,
        &format!(
            "{}\n",
            format!(
                r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{tid}","timestamp":"{ts}","cwd":"{}"}}}}"#,
                mac.proj().display()
            )
        ),
    );
    mac.changed(&mac_file).await;
    settle(&mut [&mut mac, &mut lin]).await;
    lin.ls
        .resume(Some("codex"), &tid, true, false)
        .await
        .unwrap();
    // the old Codex on mac writes one more line
    append(
        &mac_file,
        &format!(
            r#"{{"timestamp":"{ts}","ordinal":2,"type":"event_msg","payload":{{"type":"agent_message","message":"thread {tid}"}}}}"#
        ),
    );
    append(&mac_file, "\n");
    let original = std::fs::read(&mac_file).unwrap();
    mac.changed(&mac_file).await;
    settle(&mut [&mut mac, &mut lin]).await;

    let fork = hub
        .paths("@codex")
        .into_iter()
        .find(|p| !p.contains(&tid))
        .unwrap();
    let new = fork
        .trim_start_matches("sessions/")
        .trim_end_matches(".jsonl")
        .to_string();
    let meta =
        SessionMeta::from_meta(hub.entry("@codex", &fork).unwrap().meta.as_ref().unwrap()).unwrap();
    assert_eq!(meta.forked_from.as_deref(), Some(tid.as_str()));
    let fork_rel = rel.replace(&tid, &new);
    assert_eq!(meta.native_rel.as_deref(), Some(fork_rel.as_str()));
    let expected = String::from_utf8(original).unwrap().replace(&tid, &new);
    assert_eq!(
        String::from_utf8(hub.log("@codex", &fork).unwrap()).unwrap(),
        expected
    );
    // cold: both come back from the hub at their native names, byte-exact
    assert_eq!(read(&mac.codex.join(&fork_rel)), expected);
    assert_eq!(
        std::fs::read(&mac_file).unwrap(),
        hub.log("@codex", &format!("sessions/{tid}.jsonl")).unwrap()
    );
    assert_eq!(read(&lin.codex.join(&fork_rel)), expected);
}

#[tokio::test]
async fn large_transcript_goes_in_frame_sized_chunks() {
    let hub = MockHub::new();
    let mut mac = M::new(&hub, "mac", "Users/fab");
    let mut lin = M::new(&hub, "linux", "home/fabio");
    let sid = uuid::Uuid::new_v4().to_string();
    let p = mac.transcript(&sid);
    let pad = "x".repeat(20_000);
    let mut body = String::new();
    for i in 0..1000 {
        body.push_str(&user_line(&sid, &mac.proj(), &format!("u{i}"), &pad));
        body.push('\n');
    }
    append(&p, &body); // ~20 MB, more than one frame
    mac.changed(&p).await;
    settle(&mut [&mut mac, &mut lin]).await;
    let e = hub
        .entry("@claude", &format!("sessions/{sid}.jsonl"))
        .unwrap();
    assert!(
        e.version >= 5,
        "pushed in several appends (version {})",
        e.version
    );
    assert_eq!(read(&lin.transcript(&sid)), translate(&body, &mac, &lin));
    assert_eq!(mac.ls.pending().up, 0);
}

/// The daemon spawns these futures on the multi-threaded runtime.
#[allow(dead_code)]
fn futures_are_send(ls: Arc<LogSync>, c: Change) {
    fn send<T: Send>(_: T) {}
    send(ls.clone().run());
    send(ls.on_remote(c, Vec::new()));
    send(ls.on_local(PathBuf::new()));
    send(ls.rescan());
    send(ls.tick(true));
    send(ls.resume(None, "x", false, false));
}
