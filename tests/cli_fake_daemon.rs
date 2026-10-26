//! Drives the real `uc` binary against a fake daemon on `$UC_HOME/daemon.sock` (same framing
//! as DESIGN §4.1), so CLI output, JSON documents, path resolution and exit codes are checked
//! without a hub.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

const MAGIC: &[u8; 8] = b"UCPROTO1";

struct Fixture {
    _dir: tempfile::TempDir,
    home: PathBuf,
    code: PathBuf,
    seen: Arc<Mutex<Vec<Value>>>,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        // the CLI canonicalizes paths; keep everything in canonical form
        let home = dir.path().canonicalize().unwrap().join("home");
        let code = home.join("Code");
        std::fs::create_dir_all(code.join("src")).unwrap();
        std::fs::write(code.join("a.txt"), "hi").unwrap();
        let uc_home = home.join(".uc");
        std::fs::create_dir_all(&uc_home).unwrap();
        std::fs::write(
            uc_home.join("config.toml"),
            format!(
                "machine_id = \"m_test\"\nmachine_name = \"testbox\"\nhub = \"fakehub\"\n\n\
                 [[space]]\nname = \"code\"\npath = \"{}\"\n",
                code.display()
            ),
        )
        .unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        spawn_fake_daemon(uc_home.join("daemon.sock"), code.clone(), seen.clone());
        Fixture {
            _dir: dir,
            home,
            code,
            seen,
        }
    }

    fn uc_in(&self, cwd: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_uc"))
            .args(args)
            .env("HOME", &self.home)
            .env("UC_HOME", self.home.join(".uc"))
            .env("CLAUDE_CONFIG_DIR", self.home.join(".claude"))
            .env("CODEX_HOME", self.home.join(".codex"))
            .env("NO_COLOR", "1")
            .current_dir(cwd)
            .output()
            .expect("running uc")
    }

    fn uc(&self, args: &[&str]) -> Output {
        self.uc_in(&self.home, args)
    }

    /// Control commands the fake daemon received (probes excluded).
    fn cmds(&self) -> Vec<Value> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|m| m["cmd"].clone())
            .collect()
    }
}

fn spawn_fake_daemon(sock: PathBuf, code: PathBuf, seen: Arc<Mutex<Vec<Value>>>) {
    let listener = UnixListener::bind(&sock).unwrap();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut s) = conn else { continue };
            let (seen, code) = (seen.clone(), code.clone());
            std::thread::spawn(move || {
                let _ = serve(&mut s, &seen, &code);
            });
        }
    });
}

fn serve(s: &mut UnixStream, seen: &Mutex<Vec<Value>>, code: &Path) -> std::io::Result<()> {
    s.write_all(MAGIC)?;
    let mut magic = [0u8; 8];
    s.read_exact(&mut magic)?;
    loop {
        let mut len = [0u8; 4];
        if s.read_exact(&mut len).is_err() {
            return Ok(());
        }
        let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut body)?;
        let jlen = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
        let msg: Value = serde_json::from_slice(&body[4..4 + jlen]).unwrap();
        seen.lock().unwrap().push(msg.clone());
        let reply = match respond(&msg["cmd"], code) {
            Ok(data) => json!({"t": "result", "re": msg["id"], "data": data}),
            Err((c, m)) => json!({"t": "error", "re": msg["id"], "code": c, "msg": m}),
        };
        let j = serde_json::to_vec(&reply).unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(&((4 + j.len()) as u32).to_be_bytes());
        out.extend_from_slice(&(j.len() as u32).to_be_bytes());
        out.extend_from_slice(&j);
        s.write_all(&out)?;
    }
}

fn session(code: &Path) -> Value {
    json!({
        "space": "@claude", "path": "sessions/abc12345-0000.jsonl",
        "meta": {"agent": "claude", "id": "abc12345-0000", "title": "fix the login redirect",
                 "updated_at": 1_700_000_000_000i64},
        "owner": "m_linux", "owner_name": "linux-box", "live": true, "idle_ms": 3000,
        "size": 10, "version": 4, "local_cwd": code.to_string_lossy(), "local": true
    })
}

fn respond(cmd: &Value, code: &Path) -> Result<Value, (&'static str, String)> {
    let record = |seq: u64, op: &str| {
        json!({"seq": seq, "op": op, "at": 1_700_000_000_000i64, "space": "code", "path": "a.txt",
               "kind": "file", "hash": "0123456789abcdef", "size": 2, "origin": "m_linux",
               "origin_name": "linux-box"})
    };
    match cmd["cmd"].as_str().unwrap_or("") {
        "status" => Ok(json!({
            "machine": {"id": "m_test", "name": "testbox", "os": "macos", "home": "/h"},
            "hub": "fakehub", "connected": true, "hub_version": "0.1.0", "cursor": 41,
            "head_seq": 42, "spaces": [{"name": "code", "path": code.to_string_lossy(),
            "files": 1234, "pending_up": 1, "pending_down": 0, "case_collisions": []}],
            "pending_up": 1, "pending_down": 0, "conflicts": [],
            "sessions_live": [session(code)], "last_error": null, "daemon_pid": 4242,
            "daemon_version": "0.1.0", "uptime_s": 7200
        })),
        "sync" => Ok(
            json!({"ok": true, "timed_out": false, "pending_up": 0, "pending_down": 0,
                            "conflicts": [], "head_seq": 42, "cursor": 42}),
        ),
        "query" => match cmd["query"]["q"].as_str().unwrap_or("") {
            "sessions" => Ok(json!([session(code)])),
            "history" if cmd["query"]["space"] == "code" && cmd["query"]["path"] == "a.txt" => {
                Ok(json!([record(42, "put"), record(17, "put")]))
            }
            "log" => Ok(json!([record(42, "put")])),
            "spaces" => Ok(json!([])),
            q => Err(("invalid", format!("unexpected query {q}"))),
        },
        other => Err(("invalid", format!("unexpected command {other}"))),
    }
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

fn json_out(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|e| panic!("not JSON ({e}): {}", text(&o.stdout)))
}

#[test]
fn status_human_and_json() {
    let f = Fixture::new();
    let o = f.uc(&["--json", "status"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
    let v = json_out(&o);
    assert_eq!(v["connected"], true);
    assert_eq!(v["sessions_live"][0]["meta"]["id"], "abc12345-0000");

    let o = f.uc(&["status"]);
    assert_eq!(o.status.code(), Some(0));
    let out = text(&o.stdout);
    assert!(
        out.starts_with("● connected to fakehub  hub 0.1.0 · seq 42\n"),
        "{out}"
    );
    assert!(out.contains("testbox (m_test)"), "{out}");
    assert!(out.contains("1,234 files  ↑1 ↓0"), "{out}");
    assert!(out.contains("● claude abc12345  linux-box"), "{out}");
    assert!(!out.contains('\x1b'), "NO_COLOR must disable colors");
}

#[test]
fn sessions_table_and_here_filter() {
    let f = Fixture::new();
    let o = f.uc(&["sessions"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
    let out = text(&o.stdout);
    let header = out.lines().next().unwrap();
    for col in ["AGENT", "ID", "MACHINE", "UPDATED", "DIR", "TITLE"] {
        assert!(header.contains(col), "{header}");
    }
    assert!(out.contains("●  claude  abc12345  linux-box"), "{out}");
    assert!(out.contains("~/Code"), "{out}");
    assert!(out.contains("fix the login redirect"), "{out}");

    // inside the session's folder: kept; elsewhere: filtered out
    let o = f.uc_in(&f.code.join("src"), &["--json", "sessions", "--here"]);
    assert_eq!(json_out(&o).as_array().unwrap().len(), 1);
    let o = f.uc_in(&f.home, &["--json", "sessions", "--here"]);
    assert_eq!(json_out(&o).as_array().unwrap().len(), 0);
}

#[test]
fn history_resolves_local_paths() {
    let f = Fixture::new();
    let o = f.uc_in(&f.code, &["--json", "history", "a.txt"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
    assert_eq!(json_out(&o).as_array().unwrap().len(), 2);

    let o = f.uc(&["history", "Code/a.txt"]);
    let out = text(&o.stdout);
    assert!(out.contains("42 (current)"), "{out}");
    assert!(
        out.contains("restore one: uc restore Code/a.txt --seq <SEQ>"),
        "{out}"
    );

    let o = f.uc(&["history", "/etc/hosts"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(text(&o.stderr).contains("not inside a synced folder"));
}

#[test]
fn log_since_and_sync() {
    let f = Fixture::new();
    let o = f.uc_in(&f.code, &["--json", "log", ".", "--since", "1h"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
    let q = f
        .cmds()
        .into_iter()
        .find(|c| c["cmd"] == "query" && c["query"]["q"] == "log")
        .unwrap();
    assert_eq!(q["query"]["space"], "code");
    assert!(
        q["query"]["path"].is_null(),
        "space root = whole space: {q}"
    );
    let since = q["query"]["since_ms"].as_i64().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert!(
        (now - since - 3_600_000).abs() < 60_000,
        "since_ms ~ now-1h"
    );

    let o = f.uc(&["log"]);
    assert!(
        text(&o.stdout).contains("put  2 B   ~/Code/a.txt"),
        "{}",
        text(&o.stdout)
    );

    let o = f.uc(&["sync"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(text(&o.stdout).contains("in sync (seq 42)"));
}
