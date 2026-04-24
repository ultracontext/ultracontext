use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BIN: &str = env!("CARGO_BIN_EXE_ultracontext");

#[test]
#[ignore = "requires UC_E2E_REMOTE=user@host plus ssh/mutagen access"]
fn syncs_sessions_to_remote_workspace() {
    let remote =
        env::var("UC_E2E_REMOTE").expect("set UC_E2E_REMOTE=user@host to run the e2e test");

    require("ssh");
    require("mutagen");

    let run_id = unique_run_id();
    let host_id = format!("uc-e2e-{run_id}");
    let remote_root = format!("~/.ultracontext-e2e/{run_id}");
    let home = env::temp_dir().join(format!("uc-e2e-home-{run_id}"));
    let _cleanup = E2eCleanup {
        home: home.clone(),
        remote: remote.clone(),
        remote_root: remote_root.clone(),
        host_id: host_id.clone(),
    };

    let claude_file = home
        .join(".claude")
        .join("projects")
        .join("-tmp-ultracontext-e2e")
        .join("session.jsonl");
    let codex_file = home
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("04")
        .join("24")
        .join(format!("rollout-2026-04-24T00-00-00-{run_id}.jsonl"));

    fs::create_dir_all(claude_file.parent().unwrap()).unwrap();
    fs::create_dir_all(codex_file.parent().unwrap()).unwrap();
    fs::write(
        &claude_file,
        format!(
            "{{\"type\":\"user\",\"sessionId\":\"claude-{run_id}\",\"cwd\":\"/tmp/ultracontext-e2e\",\"timestamp\":\"2026-04-24T00:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"hello from claude {run_id}\"}},\"uuid\":\"00000000-0000-4000-8000-000000000001\"}}\n"
        ),
    )
    .unwrap();
    fs::write(
        &codex_file,
        format!(
            "{{\"timestamp\":\"2026-04-24T00:00:01Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"codex-{run_id}\",\"cwd\":\"/tmp/ultracontext-e2e\"}}}}\n{{\"timestamp\":\"2026-04-24T00:00:02Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"hello from codex {run_id}\"}}}}\n"
        ),
    )
    .unwrap();

    let init = uc(&home)
        .args([
            "init",
            remote.as_str(),
            "--host-id",
            host_id.as_str(),
            "--remote-root",
            remote_root.as_str(),
        ])
        .output()
        .unwrap();
    assert_success("uc init", init);

    let start = uc(&home).args(["sync", "start"]).output().unwrap();
    assert_success("uc sync start", start);

    let claude_remote = format!(
        "{remote_root}/workspace/sessions/{host_id}/claude/projects/-tmp-ultracontext-e2e/session.jsonl"
    );
    let codex_remote = format!(
        "{remote_root}/workspace/sessions/{host_id}/codex/sessions/2026/04/24/{}",
        codex_file.file_name().unwrap().to_string_lossy()
    );

    wait_for_remote_file(&remote, &claude_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_remote, Duration::from_secs(45));

    let remote_cat = ssh(
        &remote,
        &format!(
            "cat {} && cat {}",
            remote_path_arg(&claude_remote),
            remote_path_arg(&codex_remote)
        ),
    )
    .output()
    .unwrap();
    let remote_text = String::from_utf8_lossy(&remote_cat.stdout).to_string();
    assert_success("remote cat", remote_cat);
    assert!(
        remote_text.contains(&format!("hello from claude {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("hello from codex {run_id}")),
        "{remote_text}"
    );

    if env::var("UC_E2E_QUERY").ok().as_deref() == Some("1") {
        let query = uc(&home)
            .args([
                "query",
                &format!("Find the e2e marker {run_id}. Which agents mention it?"),
            ])
            .output()
            .unwrap();
        assert_success("uc query", query);
    }

    drop(_cleanup);
}

struct E2eCleanup {
    home: PathBuf,
    remote: String,
    remote_root: String,
    host_id: String,
}

impl Drop for E2eCleanup {
    fn drop(&mut self) {
        let _ = uc(&self.home).args(["sync", "stop"]).output();
        let _ = mutagen_with_home(&self.home)
            .args(["sync", "terminate", &format!("uc-{}-claude", self.host_id)])
            .output();
        let _ = mutagen_with_home(&self.home)
            .args(["sync", "terminate", &format!("uc-{}-codex", self.host_id)])
            .output();
        let _ = ssh(
            &self.remote,
            &format!("rm -rf {}", remote_path_arg(&self.remote_root)),
        )
        .output();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn uc(home: &Path) -> Command {
    let mut command = Command::new(BIN);
    command.env("HOME", home);
    if let Ok(external_home) = env::var("HOME") {
        command.env("ULTRACONTEXT_EXTERNAL_HOME", external_home);
    }
    command
}

fn ssh(remote: &str, command: &str) -> Command {
    let mut child = Command::new("ssh");
    child.arg(remote).arg(command);
    child
}

fn mutagen_with_home(home: &Path) -> Command {
    let mut command = Command::new("mutagen");
    if let Ok(external_home) = env::var("HOME") {
        command.env("HOME", external_home);
    } else {
        command.env("HOME", home);
    }
    command
}

fn require(program: &str) {
    let status = Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {program} >/dev/null 2>&1"))
        .status()
        .unwrap();
    assert!(status.success(), "required command not found: {program}");
}

fn wait_for_remote_file(remote: &str, path: &str, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let status = ssh(remote, &format!("test -f {}", remote_path_arg(path)))
            .status()
            .unwrap();
        if status.success() {
            return;
        }
        std::thread::sleep(Duration::from_millis(750));
    }
    panic!("remote file did not appear within {:?}: {path}", timeout);
}

fn assert_success(label: &str, output: Output) {
    if output.status.success() {
        return;
    }
    panic!(
        "{label} failed\nstatus: {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn unique_run_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    format!("{}-{now}", std::process::id())
}

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_path_arg(value: &str) -> String {
    if value == "~" {
        return "~".to_string();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return format!("~/{}", sh_quote(rest));
    }
    sh_quote(value)
}
