//! End-to-end checks of the `uc` binary that need no hub or daemon: parsing, exit codes,
//! JSON error documents, and the not-initialized paths. Every run gets its own HOME/UC_HOME.

use std::process::{Command, Output};

struct Env {
    dir: tempfile::TempDir,
}

impl Env {
    fn new() -> Env {
        Env {
            dir: tempfile::Builder::new()
                .prefix("uc")
                .tempdir_in("/tmp")
                .unwrap(),
        }
    }

    fn uc(&self, args: &[&str]) -> Output {
        let home = self.dir.path();
        Command::new(env!("CARGO_BIN_EXE_uc"))
            .args(args)
            .env("HOME", home)
            .env("UC_HOME", home.join(".ultracontext"))
            .env("CLAUDE_CONFIG_DIR", home.join(".claude"))
            .env("CODEX_HOME", home.join(".codex"))
            .env("NO_COLOR", "1")
            .env_remove("UC_TOKEN")
            .env_remove("XDG_CONFIG_HOME")
            .current_dir(home)
            .output()
            .expect("running uc")
    }
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).to_string()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).to_string()
}

fn json(o: &Output) -> serde_json::Value {
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|e| panic!("stdout is not one JSON document ({e}): {}", stdout(o)))
}

#[test]
fn help_and_version() {
    let env = Env::new();
    let o = env.uc(&["--help"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(stdout(&o).contains("Usage: uc"));
    assert!(stdout(&o).contains("resume"));
    let o = env.uc(&["--version"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(stdout(&o).starts_with("uc "));
}

#[test]
fn usage_errors_exit_2() {
    let env = Env::new();
    let o = env.uc(&["frobnicate"]);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("frobnicate"));

    let o = env.uc(&["--json", "log", "--since", "5x"]);
    assert_eq!(o.status.code(), Some(2));
    let v = json(&o);
    assert_eq!(v["error"]["code"], "usage");
    assert_eq!(v["error"]["exit_code"], 2);
    assert!(
        stderr(&o).is_empty(),
        "json mode keeps stderr clean: {}",
        stderr(&o)
    );

    let o = env.uc(&["resume", "x", "--takeover", "--fork"]);
    assert_eq!(o.status.code(), Some(2));
}

#[test]
fn not_initialized_is_a_clear_error() {
    let env = Env::new();
    for cmd in [
        &["status"][..],
        &["sessions"],
        &["sync"],
        &["add", "proj"],
        &["log"],
    ] {
        let mut args = vec!["--json"];
        args.extend_from_slice(cmd);
        let o = env.uc(&args);
        assert_eq!(o.status.code(), Some(1), "{cmd:?}");
        let v = json(&o);
        assert_eq!(v["error"]["code"], "not_initialized", "{cmd:?}");
        assert!(v["error"]["hint"].as_str().unwrap().contains("uc init"));
    }
    let o = env.uc(&["status"]);
    assert_eq!(o.status.code(), Some(1));
    let err = stderr(&o);
    assert!(
        err.starts_with("uc: uc is not set up on this machine\nhint: run 'uc init"),
        "{err}"
    );
    assert!(stdout(&o).is_empty());
    // nothing was created for a read-only command, and no daemon was started
    assert!(!env.dir.path().join(".ultracontext/daemon.sock").exists());
}

#[test]
fn init_without_hub_in_a_script_is_a_usage_error() {
    let env = Env::new();
    let o = env.uc(&["--json", "init"]);
    assert_eq!(o.status.code(), Some(2));
    let v = json(&o);
    assert_eq!(v["error"]["code"], "usage");
    assert!(v["error"]["hint"].as_str().unwrap().contains("uc init"));
}

#[test]
fn daemon_status_and_stop_when_not_running() {
    let env = Env::new();
    let o = env.uc(&["--json", "daemon", "status"]);
    assert_eq!(o.status.code(), Some(1));
    assert_eq!(json(&o)["running"], false);
    let o = env.uc(&["--json", "daemon", "stop"]);
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(json(&o)["stopped"], false);
    let o = env.uc(&["daemon", "status"]);
    assert!(stdout(&o).contains("daemon not running"));
}

#[test]
fn doctor_reports_checks_with_fixes() {
    let env = Env::new();
    let o = env.uc(&["--json", "doctor"]);
    assert_eq!(o.status.code(), Some(1));
    let v = json(&o);
    assert_eq!(v["ok"], false);
    let checks = v["checks"].as_array().unwrap();
    let config = checks.iter().find(|c| c["name"] == "config").unwrap();
    assert_eq!(config["status"], "fail");
    assert_eq!(config["fix"], "uc init <hub>");
    let daemon = checks.iter().find(|c| c["name"] == "daemon").unwrap();
    assert_eq!(daemon["status"], "fail");
    assert!(checks.iter().any(|c| c["name"] == "disk"));

    let o = env.uc(&["doctor"]);
    let out = stdout(&o);
    assert!(out.contains("✗ config"), "{out}");
    assert!(out.contains("fix: uc init <hub>"), "{out}");
}

#[test]
fn hub_serve_tcp_requires_a_token() {
    let env = Env::new();
    let o = env.uc(&["--json", "hub", "serve", "--tcp", "127.0.0.1:0"]);
    assert_eq!(o.status.code(), Some(2));
    assert!(json(&o)["error"]["message"]
        .as_str()
        .unwrap()
        .contains("UC_TOKEN"));
}
