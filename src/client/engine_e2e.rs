//! Two engines ("machines") syncing one space through the in-process fake hub.

use std::fs;
use std::sync::RwLock;

use super::*;
use crate::client::db::ClientDb;
use crate::client::hubconn::testhub::FakeHub;
use crate::client::hubconn::{HubClient, HubEvent};
use crate::config::{Config, SpaceConfig};
use crate::paths::Paths;

struct Machine {
    ctx: Arc<Ctx>,
    engine: Arc<Engine>,
    _home: tempfile::TempDir,
}

fn tmpdir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("uc").tempdir_in("/tmp").unwrap()
}

fn write(root: &Path, rel: &str, data: &str) -> PathBuf {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, data).unwrap();
    p
}

fn read(root: &Path, rel: &str) -> Option<String> {
    fs::read_to_string(root.join(rel)).ok()
}

fn conflict_copies(root: &Path, dir: &str) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(root.join(dir))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| apply::is_conflict_name(n))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

async fn eventually(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..300 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn machine(hub: &FakeHub, id: &str, root: &Path) -> Machine {
    let home = tmpdir();
    let mut cfg = Config::new_for_this_machine();
    cfg.machine_id = id.into();
    cfg.machine_name = id.into();
    cfg.hub = "fake".into();
    cfg.sync.debounce_ms = 50;
    cfg.spaces.push(SpaceConfig { name: "code".into(), path: root.to_string_lossy().to_string() });
    let info = cfg.machine_info();
    let (hubc, mut events) = HubClient::start_with(hub.connector(), info.clone(), None);
    let ctx = Arc::new(Ctx {
        paths: Paths::new(home.path().to_path_buf()),
        cfg: RwLock::new(cfg),
        db: ClientDb::open_in_memory().unwrap(),
        hub: hubc,
        machine: info,
        started: Instant::now(),
        last_error: Mutex::new(None),
    });
    let engine = Engine::new(ctx.clone());
    let (c2, e2) = (ctx.clone(), engine.clone());
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            match ev {
                HubEvent::Connected { .. } => {
                    c2.hub.subscribe(c2.db.cursor().unwrap()).await.unwrap();
                }
                HubEvent::Change(c, _) => e2.on_remote(c).await.unwrap(),
                _ => {}
            }
        }
    });
    tokio::spawn(engine.clone().run());
    assert!(ctx.hub.wait_connected(Duration::from_secs(5)).await);
    Machine { ctx, engine, _home: home }
}

fn hub_has(hub: &FakeHub, path: &str, data: &str) -> bool {
    hub.entry("code", path)
        .filter(|e| !e.deleted)
        .and_then(|e| hub.blob(&e.hash))
        .is_some_and(|b| b == data.as_bytes())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_machines_converge_without_losing_data() {
    let hub = FakeHub::new();
    let (da, db) = (tmpdir(), tmpdir());
    let (ra, rb) = (da.path().to_path_buf(), db.path().to_path_buf());

    write(&ra, "same.txt", "same");
    write(&ra, "diff.txt", "from A");
    write(&ra, "sub/deep.txt", "deep");
    write(&ra, "proj/.git/objects/ab/cdef", "object");
    write(&ra, "proj/.git/refs/heads/main", "abcdef");
    write(&ra, "proj/.git/index.lock", "volatile");
    write(&ra, "proj/node_modules/x/index.js", "dep");
    std::os::unix::fs::symlink("sub/deep.txt", ra.join("link")).unwrap();
    // B already has a non-empty folder: one identical file, one different
    write(&rb, "same.txt", "same");
    write(&rb, "diff.txt", "from B");

    let a = machine(&hub, "m_a", &ra).await;
    a.engine.add_space("code", &ra).await.unwrap();
    eventually("A's files on the hub", || {
        hub_has(&hub, "same.txt", "same")
            && hub_has(&hub, "diff.txt", "from A")
            && hub_has(&hub, "sub/deep.txt", "deep")
            && hub_has(&hub, "proj/.git/objects/ab/cdef", "object")
            && hub_has(&hub, "proj/.git/refs/heads/main", "abcdef")
            && hub.entry("code", "link").is_some_and(|e| e.kind == Kind::Symlink)
    })
    .await;
    assert!(hub.entry("code", "proj/.git/index.lock").is_none());
    assert!(hub.entry("code", "proj/node_modules/x/index.js").is_none());
    // git objects were committed before the ref pointing at them (§5.5)
    let obj = hub.entry("code", "proj/.git/objects/ab/cdef").unwrap().version;
    let rf = hub.entry("code", "proj/.git/refs/heads/main").unwrap().version;
    assert!(obj < rf);

    // B joins: identical file adopted (no duplicate), different file -> hub wins + conflict copy
    let b = machine(&hub, "m_b", &rb).await;
    b.engine.add_space("code", &rb).await.unwrap();
    eventually("B converged", || {
        read(&rb, "diff.txt").as_deref() == Some("from A")
            && read(&rb, "sub/deep.txt").as_deref() == Some("deep")
            && read(&rb, "proj/.git/refs/heads/main").as_deref() == Some("abcdef")
            && conflict_copies(&rb, "").len() == 1
    })
    .await;
    assert_eq!(fs::read_link(rb.join("link")).unwrap(), PathBuf::from("sub/deep.txt"));
    let copy = conflict_copies(&rb, "").pop().unwrap();
    assert!(copy.starts_with("diff (conflict m_b "), "{copy}");
    assert_eq!(read(&rb, &copy).as_deref(), Some("from B"));
    assert_eq!(read(&rb, "same.txt").as_deref(), Some("same"));
    eventually("conflict copy reaches A", || read(&ra, &copy).as_deref() == Some("from B")).await;
    assert_eq!(b.engine.pending().conflicts.len(), 1);

    // edit on A -> B
    let p = write(&ra, "sub/deep.txt", "v2");
    a.engine.on_local(p).await;
    eventually("edit reaches B", || read(&rb, "sub/deep.txt").as_deref() == Some("v2")).await;

    // delete on B -> A (moved to A's trash, not destroyed)
    fs::remove_file(rb.join("same.txt")).unwrap();
    b.engine.on_local(rb.join("same.txt")).await;
    eventually("delete reaches A", || !ra.join("same.txt").exists()).await;
    assert!(hub.entry("code", "same.txt").unwrap().deleted);
    let trash = a.ctx.paths.trash();
    eventually("trash holds the deleted file", || {
        fn find(d: &Path) -> bool {
            fs::read_dir(d).into_iter().flatten().flatten().any(|e| {
                let p = e.path();
                if p.is_dir() {
                    find(&p)
                } else {
                    p.file_name().is_some_and(|n| n == "same.txt")
                }
            })
        }
        find(&trash)
    })
    .await;

    // concurrent edits: A edits locally while another machine commits first -> conflict copy on A
    let before = a.engine.pending().conflicts.len();
    write(&ra, "diff.txt", "A edit");
    hub.inject_file("code", "diff.txt", b"X edit", "m_x");
    eventually("A resolves the conflict", || {
        read(&ra, "diff.txt").as_deref() == Some("X edit")
            && conflict_copies(&ra, "").iter().any(|n| n.contains("conflict m_a"))
    })
    .await;
    let mine = conflict_copies(&ra, "").into_iter().find(|n| n.contains("conflict m_a")).unwrap();
    assert_eq!(read(&ra, &mine).as_deref(), Some("A edit"));
    eventually("B sees both versions", || {
        read(&rb, "diff.txt").as_deref() == Some("X edit") && read(&rb, &mine).as_deref() == Some("A edit")
    })
    .await;
    assert_eq!(a.engine.pending().conflicts.len(), before + 1);

    // restore an old version as a new change; it replicates everywhere
    let hist: Vec<LogRecord> = serde_json::from_value(
        a.ctx
            .hub
            .query(Query::History { space: "code".into(), path: "sub/deep.txt".into(), limit: None })
            .await
            .unwrap(),
    )
    .unwrap();
    let first = hist.iter().map(|r| r.seq).min().unwrap();
    a.engine.restore("code", "sub/deep.txt", first).await.unwrap();
    eventually("restore reaches both", || {
        read(&ra, "sub/deep.txt").as_deref() == Some("deep") && read(&rb, "sub/deep.txt").as_deref() == Some("deep")
    })
    .await;

    // nothing left to do on either side, and rescans find nothing new
    a.engine.rescan().await.unwrap();
    b.engine.rescan().await.unwrap();
    eventually("both idle", || a.engine.pending().idle() && b.engine.pending().idle()).await;
    let st = b.engine.space_status();
    assert_eq!(st.len(), 1);
    assert!(st[0].files >= 6, "{st:?}");
    assert_eq!(a.engine.locate(&ra.join("x/y.txt")), Some(("code".into(), "x/y.txt".into())));
    assert_eq!(a.engine.locate(&ra), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn case_collisions_are_reported_not_applied() {
    let d = tmpdir();
    let root = d.path().to_path_buf();
    if !scan::probe_case_insensitive(&root).unwrap() {
        return; // only meaningful on case-insensitive filesystems (macOS default)
    }
    let hub = FakeHub::new();
    hub.inject_file("code", "README.md", b"mine", "m_x");
    hub.inject_file("code", "readme.md", b"other", "m_x");
    write(&root, "README.md", "mine");
    let m = machine(&hub, "m_b", &root).await;
    m.engine.add_space("code", &root).await.unwrap();
    eventually("collision reported", || {
        m.engine.space_status()[0].case_collisions == vec!["readme.md".to_string()] && m.engine.pending().idle()
    })
    .await;
    assert_eq!(read(&root, "README.md").as_deref(), Some("mine"));
    assert!(conflict_copies(&root, "").is_empty());
    assert!(!hub.entry("code", "readme.md").unwrap().deleted);

    // the name is freed remotely: the colliding path applies now
    hub.inject_delete("code", "README.md", "m_x");
    eventually("other path applied", || {
        let names: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names == vec!["readme.md".to_string()] && read(&root, "readme.md").as_deref() == Some("other")
    })
    .await;
    assert!(m.engine.space_status()[0].case_collisions.is_empty());

    // a local case-only rename deletes the old name and creates the new one
    fs::rename(root.join("readme.md"), root.join("Readme.md")).unwrap();
    m.engine.on_local(root.join("readme.md")).await;
    m.engine.on_local(root.join("Readme.md")).await;
    eventually("hub has only the new name", || {
        hub.entry("code", "readme.md").is_some_and(|e| e.deleted) && hub_has(&hub, "Readme.md", "other")
    })
    .await;
    assert_eq!(read(&root, "Readme.md").as_deref(), Some("other"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn modifications_win_over_deletes() {
    let hub = FakeHub::new();
    let d = tmpdir();
    let root = d.path().join("space");
    write(&root, "x.txt", "x0");
    write(&root, "y.txt", "y0");
    let m = machine(&hub, "m_a", &root).await;
    m.engine.add_space("code", &root).await.unwrap();
    eventually("pushed", || hub_has(&hub, "x.txt", "x0") && hub_has(&hub, "y.txt", "y0")).await;

    // remote delete vs local edit: the edit is pushed again as a create
    write(&root, "x.txt", "local edit");
    hub.inject_delete("code", "x.txt", "m_x");
    eventually("edit survives the delete", || hub_has(&hub, "x.txt", "local edit")).await;
    assert_eq!(read(&root, "x.txt").as_deref(), Some("local edit"));

    // local delete vs remote edit: the edit comes back
    fs::remove_file(root.join("y.txt")).unwrap();
    hub.inject_file("code", "y.txt", b"remote edit", "m_x");
    eventually("remote edit restored locally", || read(&root, "y.txt").as_deref() == Some("remote edit")).await;
    assert!(hub_has(&hub, "y.txt", "remote edit"));
    eventually("idle", || m.engine.pending().idle()).await;
    assert!(conflict_copies(&root, "").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn newly_ignored_files_are_not_deleted() {
    let hub = FakeHub::new();
    let d = tmpdir();
    let root = d.path().join("space");
    write(&root, "logs/a.log", "line");
    write(&root, ".env", "SECRET=1");
    let m = machine(&hub, "m_a", &root).await;
    m.engine.add_space("code", &root).await.unwrap();
    eventually("pushed", || hub_has(&hub, "logs/a.log", "line") && hub_has(&hub, ".env", "SECRET=1")).await;
    let p = write(&root, ".gitignore", "*.log\n.env\n");
    m.engine.on_local(p).await;
    eventually("rules pushed", || hub_has(&hub, ".gitignore", "*.log\n.env\n")).await;
    // a now-ignored file is left alone (never deleted on the hub); always_include still syncs .env
    write(&root, "logs/a.log", "line\nmore");
    m.engine.on_local(root.join("logs/a.log")).await;
    let p = write(&root, ".env", "SECRET=2");
    m.engine.on_local(p).await;
    eventually(".env edit pushed", || hub_has(&hub, ".env", "SECRET=2")).await;
    m.engine.rescan().await.unwrap();
    eventually("idle", || m.engine.pending().idle()).await;
    assert!(hub_has(&hub, "logs/a.log", "line"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repointed_space_rejoins_instead_of_deleting() {
    let hub = FakeHub::new();
    let d = tmpdir();
    let old = d.path().join("old");
    write(&old, "a.txt", "keep me");
    let m = machine(&hub, "m_a", &old).await;
    m.engine.add_space("code", &old).await.unwrap();
    eventually("pushed", || hub_has(&hub, "a.txt", "keep me")).await;
    // the space now points at a new, empty folder (config edit + reload)
    let new = d.path().join("new");
    fs::create_dir_all(&new).unwrap();
    m.ctx.cfg.write().unwrap().spaces[0].path = new.to_string_lossy().to_string();
    m.engine.rescan().await.unwrap();
    eventually("files arrive in the new folder", || read(&new, "a.txt").as_deref() == Some("keep me")).await;
    assert!(!hub.entry("code", "a.txt").unwrap().deleted);
    assert_eq!(read(&old, "a.txt").as_deref(), Some("keep me"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_root_never_pushes_deletes() {
    let hub = FakeHub::new();
    let d = tmpdir();
    let root = d.path().join("space");
    write(&root, "a.txt", "keep me");
    let m = machine(&hub, "m_a", &root).await;
    m.engine.add_space("code", &root).await.unwrap();
    eventually("pushed", || hub_has(&hub, "a.txt", "keep me")).await;
    // the folder disappears (unmounted volume, moved away): nothing is deleted on the hub
    fs::rename(&root, d.path().join("moved")).unwrap();
    assert!(m.engine.rescan().await.is_err());
    m.engine.on_local(root.join("a.txt")).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!hub.entry("code", "a.txt").unwrap().deleted);
}
