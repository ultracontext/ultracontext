use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BIN: &str = env!("CARGO_BIN_EXE_ultracontext");

#[test]
fn init_installs_skill_only_context_retrieval_protocol() {
    let run_id = unique_run_id();
    let host_id = format!("uc-local-{run_id}");
    let home = env::temp_dir().join(format!("uc-local-home-{run_id}"));
    let remote_root = home.join("ultracontext-root");

    fs::create_dir_all(home.join(".claude")).unwrap();

    let setup = uc(&home)
        .args([
            "init",
            "local",
            "--host-id",
            host_id.as_str(),
            "--remote-root",
            remote_root.to_str().unwrap(),
            "--no-sync",
            "--yes",
        ])
        .output()
        .unwrap();
    assert_success("uc init local", setup);

    let config_path = home.join(".ultracontext").join("config.toml");
    let config = fs::read_to_string(&config_path).unwrap();
    assert!(config.contains("remote = \"local\""), "{config}");
    assert!(
        !config.contains(&["[", "q", "uery", "]"].concat()),
        "{config}"
    );
    assert!(
        !home
            .join(".ultracontext")
            .join("prompts")
            .join(["q", "uery", ".md"].concat())
            .exists()
    );
    assert!(remote_root.join("workspace").join(&host_id).is_dir());
    assert!(
        remote_root
            .join("workspace")
            .join(&host_id)
            .join(".claude")
            .is_dir()
    );

    let status = uc(&home).args(["status"]).output().unwrap();
    let status_stdout = String::from_utf8_lossy(&status.stdout).to_string();
    assert_success("uc status", status);
    assert!(status_stdout.contains("workspace"), "{status_stdout}");
    assert!(status_stdout.contains("host"), "{status_stdout}");
    assert!(status_stdout.contains("sync"), "{status_stdout}");
    assert!(status_stdout.contains("claude"), "{status_stdout}");

    let help = uc(&home).args(["--help"]).output().unwrap();
    let help_stdout = String::from_utf8_lossy(&help.stdout).to_string();
    assert_success("uc --help", help);
    assert!(
        !help_stdout.contains(&["uc ", "q", "uery"].concat()),
        "{help_stdout}"
    );

    let removed_name = ["q", "uery"].concat();
    let removed = uc(&home)
        .args([removed_name.as_str(), "anything"])
        .output()
        .unwrap();
    assert!(
        !removed.status.success(),
        "removed command unexpectedly succeeded"
    );

    let skill = fs::read_to_string(
        home.join(".claude")
            .join("skills")
            .join("ultracontext")
            .join("SKILL.md"),
    )
    .unwrap();
    assert!(
        skill.contains("Never assume there is only one machine"),
        "{skill}"
    );
    assert!(skill.contains("Codex fast path"), "{skill}");
    assert!(!skill.contains(&["uc ", "q", "uery"].concat()), "{skill}");
    assert!(!skill.contains(&["q", "uery", ".md"].concat()), "{skill}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn init_configures_skills_sources_and_workspace() {
    let run_id = unique_run_id();
    let host_id = format!("uc-init-{run_id}");
    let home = env::temp_dir().join(format!("uc-init-home-{run_id}"));
    let remote_root = home.join("ultracontext-root");

    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::create_dir_all(home.join(".openclaw")).unwrap();
    fs::create_dir_all(home.join(".hermes")).unwrap();

    let setup = uc(&home)
        .args([
            "init",
            "local",
            "--host-id",
            host_id.as_str(),
            "--remote-root",
            remote_root.to_str().unwrap(),
            "--no-sync",
            "--yes",
        ])
        .output()
        .unwrap();
    assert_success("uc init local", setup);

    let config_path = home.join(".ultracontext").join("config.toml");
    let config = fs::read_to_string(&config_path).unwrap();
    assert!(config.contains("remote = \"local\""), "{config}");
    assert!(config.contains("[sources.claude]"), "{config}");
    assert!(config.contains("[sources.codex]"), "{config}");
    assert!(config.contains("[sources.openclaw]"), "{config}");
    assert!(config.contains("[sources.hermes]"), "{config}");
    let ignores_dir = home.join(".ultracontext").join("ignores");
    let global_ignore = fs::read_to_string(ignores_dir.join(".ultracontextignore")).unwrap();
    let openclaw_ignore =
        fs::read_to_string(ignores_dir.join("openclaw").join(".ultracontextignore")).unwrap();
    let claude_ignore =
        fs::read_to_string(ignores_dir.join("claude").join(".ultracontextignore")).unwrap();
    let codex_ignore =
        fs::read_to_string(ignores_dir.join("codex").join(".ultracontextignore")).unwrap();
    assert!(global_ignore.contains("node_modules/"), "{global_ignore}");
    assert!(
        parse_ignore_lines(&claude_ignore).is_empty(),
        "{claude_ignore}"
    );
    assert!(claude_ignore.contains("Claude has no source-specific default ignores"));
    assert!(
        parse_ignore_lines(&codex_ignore).is_empty(),
        "{codex_ignore}"
    );
    assert!(codex_ignore.contains("Codex has no source-specific default ignores"));
    assert!(openclaw_ignore.contains("!agents/*/sessions/**"));
    assert!(openclaw_ignore.contains("complete workspace directories"));
    assert!(openclaw_ignore.contains("!workspace/**"));
    assert!(openclaw_ignore.contains("!workspace-*/**"));
    assert!(openclaw_ignore.contains("node_modules/"));
    assert!(openclaw_ignore.contains("**/node_modules/"));
    assert!(
        openclaw_ignore.find("node_modules/") > openclaw_ignore.find("!workspace-*/**"),
        "{openclaw_ignore}"
    );
    assert!(!openclaw_ignore.contains("!workspace/AGENTS.md"));
    assert!(!openclaw_ignore.contains("!workspace-*/AGENTS.md"));
    assert!(!openclaw_ignore.contains("!workspace/memory/**"));
    assert!(!openclaw_ignore.contains("!workspace-*/memory/**"));
    assert!(
        home.join(".claude")
            .join("skills")
            .join("ultracontext")
            .join("SKILL.md")
            .is_file()
    );
    assert!(
        home.join(".agents")
            .join("skills")
            .join("ultracontext")
            .join("SKILL.md")
            .is_file()
    );
    assert!(remote_root.join("workspace").join(&host_id).is_dir());

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn manages_sources_from_cli() {
    let run_id = unique_run_id();
    let host_id = format!("uc-source-{run_id}");
    let home = env::temp_dir().join(format!("uc-source-home-{run_id}"));
    let remote_root = home.join("ultracontext-root");

    let setup = uc(&home)
        .args([
            "init",
            "local",
            "--host-id",
            host_id.as_str(),
            "--remote-root",
            remote_root.to_str().unwrap(),
            "--no-sync",
            "--yes",
        ])
        .output()
        .unwrap();
    assert_success("uc init local", setup);

    let add = uc(&home)
        .args(["source", "add", "openclaw", "~/.openclaw"])
        .output()
        .unwrap();
    assert_success("uc source add", add);
    let openclaw_ignore = fs::read_to_string(
        home.join(".ultracontext")
            .join("ignores")
            .join("openclaw")
            .join(".ultracontextignore"),
    )
    .unwrap();
    assert!(openclaw_ignore.contains("complete workspace directories"));
    assert!(openclaw_ignore.contains("!agents/*/sessions/**"));
    assert!(openclaw_ignore.contains("!workspace/**"));
    assert!(openclaw_ignore.contains("!workspace-*/**"));
    assert!(openclaw_ignore.contains("node_modules/"));
    assert!(openclaw_ignore.contains("**/node_modules/"));
    assert!(
        openclaw_ignore.find("node_modules/") > openclaw_ignore.find("!workspace-*/**"),
        "{openclaw_ignore}"
    );
    assert!(!openclaw_ignore.contains("!workspace/AGENTS.md"));
    assert!(!openclaw_ignore.contains("!workspace-*/AGENTS.md"));
    assert!(!openclaw_ignore.contains("!workspace/memory/**"));
    assert!(!openclaw_ignore.contains("!workspace-*/memory/**"));

    let list = uc(&home).args(["source", "list"]).output().unwrap();
    let list_stdout = String::from_utf8_lossy(&list.stdout).to_string();
    assert_success("uc source list", list);
    assert!(list_stdout.contains("openclaw"), "{list_stdout}");
    assert!(list_stdout.contains("~/.openclaw"), "{list_stdout}");

    let disable = uc(&home)
        .args(["source", "disable", "openclaw"])
        .output()
        .unwrap();
    assert_success("uc source disable", disable);

    let config_path = home.join(".ultracontext").join("config.toml");
    let config = fs::read_to_string(&config_path).unwrap();
    assert!(config.contains("[sources.openclaw]"), "{config}");
    assert!(config.contains("enabled = false"), "{config}");

    let remove = uc(&home)
        .args(["source", "remove", "openclaw", "--yes"])
        .output()
        .unwrap();
    assert_success("uc source remove", remove);

    let config = fs::read_to_string(&config_path).unwrap();
    assert!(!config.contains("[sources.openclaw]"), "{config}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_log_emits_and_tails_jsonl_events_only() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-home-{run_id}"));

    let emit = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "user_message",
            "--source",
            "hermes",
            "--subject",
            "telegram:fase1",
            "--priority",
            "80",
            "--run-id",
            run_id.as_str(),
            "--payload-ref",
            "uc://payload/test",
            "--count",
            "synced=0",
        ])
        .output()
        .unwrap();
    let emit_stdout = String::from_utf8_lossy(&emit.stdout).to_string();
    assert_success("uc event emit", emit);
    assert!(emit_stdout.contains("event:"), "{emit_stdout}");
    assert!(emit_stdout.contains("user_message"), "{emit_stdout}");

    let event_log = home
        .join(".ultracontext")
        .join("events")
        .join("events.jsonl");
    let raw = fs::read_to_string(&event_log).unwrap();
    let lines = raw.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1, "{raw}");
    assert!(raw.contains("\"event_id\":"), "{raw}");
    assert!(raw.contains("\"schema_version\":\"uc.event.v1\""), "{raw}");
    assert!(raw.contains("\"occurred_at\":"), "{raw}");
    assert!(raw.contains("\"kind\":\"user_message\""), "{raw}");
    assert!(raw.contains("\"source\":\"hermes\""), "{raw}");
    assert!(raw.contains("\"subject\":\"telegram:fase1\""), "{raw}");
    assert!(raw.contains("\"priority\":80"), "{raw}");
    assert!(
        raw.contains("\"payload_ref\":\"uc://payload/test\""),
        "{raw}"
    );
    assert!(raw.contains("\"run_id\":"), "{raw}");
    assert!(raw.contains("\"counts\":{\"synced\":0}"), "{raw}");
    assert!(raw.contains("\"ok\":true"), "{raw}");
    assert!(raw.contains("\"privacy\":\"metadata_only\""), "{raw}");
    assert!(raw.contains("\"error\":null"), "{raw}");

    let tail = uc(&home)
        .args(["event", "tail", "--limit", "1"])
        .output()
        .unwrap();
    let tail_stdout = String::from_utf8_lossy(&tail.stdout).to_string();
    assert_success("uc event tail", tail);
    assert!(tail_stdout.contains("user_message"), "{tail_stdout}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_emit_writes_schema_version_privacy_and_occurred_at() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-v1-home-{run_id}"));
    let occurred_at = "2026-05-08T12:00:00Z";

    let emit = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "session.closed",
            "--source",
            "chatgpt-ios-shortcut",
            "--subject",
            "chatgpt:session:abc123",
            "--occurred-at",
            occurred_at,
            "--actor",
            "user:fabio",
            "--privacy",
            "metadata_only",
        ])
        .output()
        .unwrap();
    assert_success("uc event emit v1 envelope", emit);

    let event_log = home
        .join(".ultracontext")
        .join("events")
        .join("events.jsonl");
    let raw = fs::read_to_string(&event_log).unwrap();
    assert!(raw.contains("\"schema_version\":\"uc.event.v1\""), "{raw}");
    assert!(raw.contains("\"kind\":\"session.closed\""), "{raw}");
    assert!(raw.contains("\"source\":\"chatgpt-ios-shortcut\""), "{raw}");
    assert!(
        raw.contains("\"subject\":\"chatgpt:session:abc123\""),
        "{raw}"
    );
    assert!(
        raw.contains(&format!("\"occurred_at\":\"{occurred_at}\"")),
        "{raw}"
    );
    assert!(raw.contains("\"received_at\":"), "{raw}");
    assert!(raw.contains("\"host\":"), "{raw}");
    assert!(raw.contains("\"actor\":\"user:fabio\""), "{raw}");
    assert!(raw.contains("\"privacy\":\"metadata_only\""), "{raw}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_emit_rejects_invalid_event_envelope() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-invalid-home-{run_id}"));

    let missing_subject = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "session.closed",
            "--source",
            "hermes",
        ])
        .output()
        .unwrap();
    assert!(
        !missing_subject.status.success(),
        "missing subject should fail"
    );
    let stderr = String::from_utf8_lossy(&missing_subject.stderr).to_string();
    assert!(stderr.contains("missing --subject"), "{stderr}");

    let invalid_priority = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "session.closed",
            "--source",
            "hermes",
            "--subject",
            "session:test",
            "--priority",
            "101",
        ])
        .output()
        .unwrap();
    assert!(
        !invalid_priority.status.success(),
        "priority > 100 should fail"
    );

    let invalid_privacy = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "session.closed",
            "--source",
            "hermes",
            "--subject",
            "session:test",
            "--privacy",
            "secret",
        ])
        .output()
        .unwrap();
    assert!(
        !invalid_privacy.status.success(),
        "invalid privacy should fail"
    );

    let invalid_hash = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "session.closed",
            "--source",
            "hermes",
            "--subject",
            "session:test",
            "--payload-hash",
            "md5:abc",
        ])
        .output()
        .unwrap();
    assert!(!invalid_hash.status.success(), "invalid hash should fail");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_emit_supports_labels_and_structured_error() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-labels-home-{run_id}"));

    let emit = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "sync.failed",
            "--source",
            "chatgpt-ios-shortcut",
            "--subject",
            "chatgpt:sync",
            "--label",
            "provider=chatgpt",
            "--label",
            "driver=ios-shortcut",
            "--error-class",
            "timeout",
            "--error-message",
            "remote append timed out",
            "--error-retryable",
            "true",
            "--ok",
            "false",
        ])
        .output()
        .unwrap();
    assert_success("uc event emit labels/error", emit);

    let event_log = home
        .join(".ultracontext")
        .join("events")
        .join("events.jsonl");
    let raw = fs::read_to_string(&event_log).unwrap();
    assert!(
        raw.contains("\"labels\":{\"provider\":\"chatgpt\",\"driver\":\"ios-shortcut\"}"),
        "{raw}"
    );
    assert!(raw.contains("\"error\":{\"class\":\"timeout\",\"message\":\"remote append timed out\",\"retryable\":true}"), "{raw}");
    assert!(raw.contains("\"ok\":false"), "{raw}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_commit_from_stdin_adds_and_overwrites_received_at() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-commit-home-{run_id}"));
    let remote_root = home.join("server-root");
    fs::create_dir_all(home.join(".ultracontext")).unwrap();
    fs::write(
        home.join(".ultracontext").join("config.toml"),
        format!(
            "remote = \"local\"\nremote_root = \"{}\"\nhost_id = \"server-{run_id}\"\n",
            remote_root.display()
        ),
    )
    .unwrap();

    let event_id = format!("evt_commit_overwrite_{run_id}");
    let pending_event = format!(
        "{{\"schema_version\":\"uc.event.v1\",\"event_id\":\"{event_id}\",\"kind\":\"commit.test\",\"source\":\"hermes\",\"subject\":\"event:commit\",\"occurred_at\":\"2026-05-08T12:00:00Z\",\"received_at\":\"client-lie\",\"host\":\"client-host\",\"privacy\":\"metadata_only\"}}\n"
    );
    let commit = uc(&home)
        .args(["event", "commit", "--from-stdin"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(pending_event.as_bytes())?;
            child.wait_with_output()
        })
        .unwrap();
    assert_success("uc event commit --from-stdin", commit);

    let raw = fs::read_to_string(remote_root.join("events").join("events.jsonl")).unwrap();
    assert!(
        raw.contains(&format!("\"event_id\":\"{event_id}\"")),
        "{raw}"
    );
    assert!(!raw.contains("client-lie"), "{raw}");
    assert!(raw.contains("\"received_at\":\"20"), "{raw}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_commit_from_stdin_dedupes_by_event_id() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-commit-dedupe-home-{run_id}"));
    let remote_root = home.join("server-root");
    fs::create_dir_all(home.join(".ultracontext")).unwrap();
    fs::write(
        home.join(".ultracontext").join("config.toml"),
        format!(
            "remote = \"local\"\nremote_root = \"{}\"\nhost_id = \"server-{run_id}\"\n",
            remote_root.display()
        ),
    )
    .unwrap();

    let event_id = format!("evt_commit_dedupe_{run_id}");
    let pending_event = format!(
        "{{\"schema_version\":\"uc.event.v1\",\"event_id\":\"{event_id}\",\"kind\":\"commit.test\",\"source\":\"hermes\",\"subject\":\"event:dedupe\",\"occurred_at\":\"2026-05-08T12:00:00Z\",\"host\":\"client-host\",\"privacy\":\"metadata_only\"}}\n"
    );

    for _ in 0..2 {
        let commit = uc(&home)
            .args(["event", "commit", "--from-stdin"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child
                    .stdin
                    .as_mut()
                    .unwrap()
                    .write_all(pending_event.as_bytes())?;
                child.wait_with_output()
            })
            .unwrap();
        assert_success("uc event commit duplicate", commit);
    }

    let raw = fs::read_to_string(remote_root.join("events").join("events.jsonl")).unwrap();
    assert_eq!(
        raw.matches(&format!("\"event_id\":\"{event_id}\"")).count(),
        1,
        "{raw}"
    );
    assert!(
        remote_root
            .join("events")
            .join("seen")
            .join(&event_id)
            .exists()
    );

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_emit_is_idempotent_by_event_id() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-dedupe-home-{run_id}"));
    let event_id = format!("evt_test_duplicate_{run_id}");

    for _ in 0..2 {
        let emit = uc(&home)
            .args([
                "event",
                "emit",
                "--event-id",
                event_id.as_str(),
                "--kind",
                "agent.run.completed",
                "--source",
                "hermes",
                "--subject",
                "agent-run:hermes:duplicate",
            ])
            .output()
            .unwrap();
        assert_success("uc event emit duplicate event_id", emit);
    }

    let event_log = home
        .join(".ultracontext")
        .join("events")
        .join("events.jsonl");
    let raw = fs::read_to_string(&event_log).unwrap();
    let count = raw.matches(&format!("\"event_id\":\"{event_id}\"")).count();
    assert_eq!(count, 1, "{raw}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_log_uses_configured_local_remote_root_and_outbox() {
    let run_id = unique_run_id();
    let host_id = format!("uc-events-{run_id}");
    let home = env::temp_dir().join(format!("uc-events-root-home-{run_id}"));
    let remote_root = home.join("ultracontext-root");

    let setup = uc(&home)
        .args([
            "init",
            "local",
            "--host-id",
            host_id.as_str(),
            "--remote-root",
            remote_root.to_str().unwrap(),
            "--no-sync",
            "--yes",
        ])
        .output()
        .unwrap();
    assert_success("uc init local for events", setup);

    let emit = uc(&home)
        .args([
            "event",
            "emit",
            "--kind",
            "agent_done",
            "--source",
            "hermes",
            "--subject",
            "ultracontext:phase1.5",
            "--run-id",
            run_id.as_str(),
        ])
        .output()
        .unwrap();
    assert_success("uc event emit local remote_root", emit);

    let server_log = remote_root.join("events").join("events.jsonl");
    let raw = fs::read_to_string(&server_log).unwrap();
    assert!(raw.contains("\"kind\":\"agent_done\""), "{raw}");
    assert!(raw.contains(&format!("\"host\":\"{host_id}\"")), "{raw}");
    assert!(raw.contains("\"received_at\":"), "{raw}");
    assert!(
        raw.contains("\"subject\":\"ultracontext:phase1.5\""),
        "{raw}"
    );
    assert!(
        !home
            .join(".ultracontext")
            .join("events")
            .join("events.jsonl")
            .exists(),
        "configured local remotes should use remote_root as the server log"
    );

    let sent_dir = home.join(".ultracontext").join("events").join("sent");
    assert!(sent_dir.is_dir());
    assert!(fs::read_dir(&sent_dir).unwrap().next().is_some());

    let status = uc(&home).args(["event", "status"]).output().unwrap();
    let status_stdout = String::from_utf8_lossy(&status.stdout).to_string();
    assert_success("uc event status", status);
    assert!(status_stdout.contains("server: local"), "{status_stdout}");
    assert!(status_stdout.contains("pending: 0"), "{status_stdout}");
    assert!(status_stdout.contains("sent: 1"), "{status_stdout}");

    let tail = uc(&home)
        .args(["event", "tail", "--limit", "1"])
        .output()
        .unwrap();
    let tail_stdout = String::from_utf8_lossy(&tail.stdout).to_string();
    assert_success("uc event tail local remote_root", tail);
    assert!(tail_stdout.contains("agent_done"), "{tail_stdout}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_emit_remote_ssh_uses_event_commit_command() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-remote-commit-home-{run_id}"));
    let remote_root = home.join("remote-root");
    let fake_bin = home.join("bin");
    let captured_stdin = home.join("captured-stdin.json");
    fs::create_dir_all(remote_root.join("events")).unwrap();
    fs::create_dir_all(home.join(".ultracontext")).unwrap();
    fs::create_dir_all(&fake_bin).unwrap();

    fs::write(
        fake_bin.join("ssh"),
        "#!/bin/sh\nshift\n/bin/sh -c \"$1\"\n",
    )
    .unwrap();
    make_executable(&fake_bin.join("ssh"));
    fs::write(
        fake_bin.join("uc"),
        format!(
            "#!/bin/sh\nif [ \"$1 $2 $3\" != \"event commit --from-stdin\" ]; then exit 42; fi\ninput=$(cat)\nprintf '%s\\n' \"$input\" > {}\nprintf '%s' \"$input\" | sed 's/,\"host\"/,\"received_at\":\"remote-server-time\",\"host\"/' >> {}/events/events.jsonl\nprintf '\\n' >> {}/events/events.jsonl\n",
            captured_stdin.display(),
            remote_root.display(),
            remote_root.display()
        ),
    )
    .unwrap();
    make_executable(&fake_bin.join("uc"));

    fs::write(
        home.join(".ultracontext").join("config.toml"),
        format!(
            "remote = \"fake-remote\"\nremote_root = \"{}\"\nhost_id = \"client-{run_id}\"\n",
            remote_root.display()
        ),
    )
    .unwrap();

    let event_id = format!("evt_remote_commit_{run_id}");
    let test_path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", fake_bin.display());
    let emit = uc(&home)
        .env("PATH", &test_path)
        .args([
            "event",
            "emit",
            "--event-id",
            event_id.as_str(),
            "--kind",
            "remote.commit",
            "--source",
            "hermes",
            "--subject",
            "remote:commit",
        ])
        .output()
        .unwrap();
    assert_success("uc event emit remote commit", emit);

    let sent_to_server = fs::read_to_string(&captured_stdin).unwrap();
    assert!(
        sent_to_server.contains(&format!("\"event_id\":\"{event_id}\"")),
        "{sent_to_server}"
    );
    assert!(
        !sent_to_server.contains("\"received_at\""),
        "client should send pending envelope without received_at: {sent_to_server}"
    );
    let remote_log = fs::read_to_string(remote_root.join("events").join("events.jsonl")).unwrap();
    assert!(remote_log.contains("remote-server-time"), "{remote_log}");
    assert!(
        remote_log.contains(&format!("\"event_id\":\"{event_id}\"")),
        "{remote_log}"
    );

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_tail_reads_remote_ssh_server_log() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-remote-read-home-{run_id}"));
    let remote_root = home.join("remote-root");
    let fake_bin = home.join("bin");
    fs::create_dir_all(remote_root.join("events")).unwrap();
    fs::create_dir_all(home.join(".ultracontext").join("events")).unwrap();
    fs::create_dir_all(&fake_bin).unwrap();

    fs::write(
        fake_bin.join("ssh"),
        "#!/bin/sh\nshift\n/bin/sh -c \"$1\"\n",
    )
    .unwrap();
    make_executable(&fake_bin.join("ssh"));

    fs::write(
        home.join(".ultracontext").join("config.toml"),
        format!(
            "remote = \"fake-remote\"\nremote_root = \"{}\"\nhost_id = \"host-{run_id}\"\n",
            remote_root.display()
        ),
    )
    .unwrap();
    fs::write(
        remote_root.join("events").join("events.jsonl"),
        "{\"schema_version\":\"uc.event.v1\",\"event_id\":\"evt_remote_tail_only\",\"kind\":\"remote.only\",\"source\":\"test\",\"subject\":\"remote:server\",\"occurred_at\":\"2026-05-08T12:00:00Z\",\"received_at\":\"2026-05-08T12:00:01Z\",\"host\":\"remote-host\",\"privacy\":\"metadata_only\"}\n",
    )
    .unwrap();
    fs::write(
        home.join(".ultracontext")
            .join("events")
            .join("events.jsonl"),
        "{\"schema_version\":\"uc.event.v1\",\"event_id\":\"evt_local_stale\",\"kind\":\"local.stale\",\"source\":\"test\",\"subject\":\"local:stale\",\"occurred_at\":\"2026-05-08T12:00:00Z\",\"received_at\":\"2026-05-08T12:00:01Z\",\"host\":\"local-host\",\"privacy\":\"metadata_only\"}\n",
    )
    .unwrap();

    let test_path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", fake_bin.display());
    let tail = uc(&home)
        .env("PATH", &test_path)
        .args(["event", "tail", "--limit", "1"])
        .output()
        .unwrap();
    let tail_stdout = String::from_utf8_lossy(&tail.stdout).to_string();
    assert_success("uc event tail remote ssh", tail);
    assert!(
        tail_stdout.contains("evt_remote_tail_only"),
        "{tail_stdout}"
    );
    assert!(!tail_stdout.contains("evt_local_stale"), "{tail_stdout}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn event_flush_keeps_pending_events_when_remote_append_fails() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-events-remote-fail-home-{run_id}"));
    let remote_root = format!("~/.ultracontext-test/{run_id}");
    fs::create_dir_all(home.join(".ultracontext")).unwrap();
    fs::write(
        home.join(".ultracontext").join("config.toml"),
        format!(
            "remote = \"no-such-remote-host\"\nremote_root = \"{remote_root}\"\nhost_id = \"host-{run_id}\"\n"
        ),
    )
    .unwrap();

    let emit = uc(&home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .args([
            "event",
            "emit",
            "--kind",
            "remote_failed",
            "--source",
            "hermes",
            "--subject",
            "remote:failed",
        ])
        .output()
        .unwrap();
    assert!(
        !emit.status.success(),
        "remote emit should fail so the outbox path is tested"
    );

    let outbox_dir = home.join(".ultracontext").join("events").join("outbox");
    assert!(outbox_dir.is_dir());
    assert!(fs::read_dir(&outbox_dir).unwrap().next().is_some());

    let flush = uc(&home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .args(["event", "flush"])
        .output()
        .unwrap();
    assert!(
        !flush.status.success(),
        "flush should report failure while keeping pending events"
    );
    assert!(fs::read_dir(&outbox_dir).unwrap().next().is_some());

    let status = uc(&home).args(["event", "status"]).output().unwrap();
    let status_stdout = String::from_utf8_lossy(&status.stdout).to_string();
    assert_success("uc event status after failed remote", status);
    assert!(status_stdout.contains("pending: 1"), "{status_stdout}");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn update_respects_npm_installer_env_and_refreshes_runtime_assets() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-update-home-{run_id}"));
    let stale_skill = home
        .join(".claude")
        .join("skills")
        .join("ultracontext")
        .join("SKILL.md");
    fs::create_dir_all(stale_skill.parent().unwrap()).unwrap();
    fs::write(&stale_skill, "stale skill\n").unwrap();

    let fake_bin = home.join("fake-bin");
    fs::create_dir_all(&fake_bin).unwrap();
    let npm_log = home.join("npm.log");
    let fake_npm = fake_bin.join("npm");
    fs::write(
        &fake_npm,
        format!("#!/bin/sh\nprintf '%s\\n' \"$*\" > {}\n", npm_log.display()),
    )
    .unwrap();
    make_executable(&fake_npm);

    let path = format!(
        "{}:{}",
        fake_bin.display(),
        env::var("PATH").unwrap_or_default()
    );
    let update = uc(&home)
        .env("ULTRACONTEXT_INSTALLER", "npm")
        .env("PATH", path)
        .args(["update"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&update.stdout).to_string();
    assert_success("uc update", update);
    assert!(stdout.contains("managed by npm"), "{stdout}");
    assert!(stdout.contains("npm update -g ultracontext"), "{stdout}");
    assert_eq!(
        fs::read_to_string(&npm_log).unwrap(),
        "update -g ultracontext\n"
    );

    let refreshed_skill = fs::read_to_string(&stale_skill).unwrap();
    assert!(
        refreshed_skill.contains("name: ultracontext"),
        "{refreshed_skill}"
    );
    assert!(
        refreshed_skill.contains("uc event tail"),
        "{refreshed_skill}"
    );

    let codex_skill = home
        .join(".agents")
        .join("skills")
        .join("ultracontext")
        .join("SKILL.md");
    assert!(codex_skill.is_file());

    let _ = fs::remove_dir_all(&home);
}

#[test]
#[ignore = "requires local mutagen access"]
fn syncs_custom_source_lifecycle_over_local_mutagen() {
    require("mutagen");

    let run_id = unique_run_id();
    let host_id = format!("uc-source-real-{run_id}");
    let home = env::temp_dir().join(format!("uc-source-real-home-{run_id}"));
    let remote_root = home.join("ultracontext-root");
    let source_root = home.join("OpenClaw");
    let source_file = source_root.join("notes").join("context.txt");
    let moved_source_root = home.join("OpenClawMoved");
    let moved_source_file = moved_source_root.join("notes").join("moved.txt");
    let source_session = format!("uc-{host_id}-openclaw");
    let _cleanup = LocalSourceCleanup {
        home: home.clone(),
        host_id: host_id.clone(),
    };

    fs::create_dir_all(source_file.parent().unwrap()).unwrap();
    fs::create_dir_all(moved_source_file.parent().unwrap()).unwrap();
    fs::write(&source_file, format!("custom source marker {run_id}\n")).unwrap();
    fs::write(
        &moved_source_file,
        format!("custom source moved {run_id}\n"),
    )
    .unwrap();

    let setup = uc(&home)
        .args([
            "init",
            "local",
            "--host-id",
            host_id.as_str(),
            "--remote-root",
            remote_root.to_str().unwrap(),
            "--no-sync",
            "--yes",
        ])
        .output()
        .unwrap();
    assert_success("uc init local", setup);

    let add = uc(&home)
        .args(["source", "add", "openclaw", "~/OpenClaw"])
        .output()
        .unwrap();
    assert_success("uc source add", add);

    let synced_file = remote_root
        .join("workspace")
        .join("sessions")
        .join(&host_id)
        .join(".openclaw")
        .join("notes")
        .join("context.txt");
    wait_for_local_file(&synced_file, Duration::from_secs(30));
    let synced_text = fs::read_to_string(&synced_file).unwrap();
    assert!(synced_text.contains(&run_id), "{synced_text}");

    let update = uc(&home)
        .args(["source", "add", "openclaw", "~/OpenClawMoved"])
        .output()
        .unwrap();
    assert_success("uc source add existing source", update);

    let moved_synced_file = remote_root
        .join("workspace")
        .join("sessions")
        .join(&host_id)
        .join(".openclaw")
        .join("notes")
        .join("moved.txt");
    wait_for_local_file_text(
        &moved_synced_file,
        &format!("moved {run_id}"),
        Duration::from_secs(30),
    );

    let disable = uc(&home)
        .args(["source", "disable", "openclaw"])
        .output()
        .unwrap();
    assert_success("uc source disable", disable);

    let status = uc(&home).args(["sync", "status"]).output().unwrap();
    let status_text = String::from_utf8_lossy(&status.stdout).to_string();
    assert_success("uc sync status after disable", status);
    assert!(status_text.contains(&source_session), "{status_text}");
    assert!(status_text.contains("Paused"), "{status_text}");

    let enable = uc(&home)
        .args(["source", "enable", "openclaw"])
        .output()
        .unwrap();
    assert_success("uc source enable", enable);
    fs::write(
        &moved_source_file,
        format!("custom source re-enabled {run_id}\n"),
    )
    .unwrap();

    wait_for_local_file_text(
        &moved_synced_file,
        &format!("re-enabled {run_id}"),
        Duration::from_secs(30),
    );

    let remove = uc(&home)
        .args(["source", "remove", "openclaw", "--yes"])
        .output()
        .unwrap();
    assert_success("uc source remove", remove);

    let status = uc(&home).args(["sync", "status"]).output().unwrap();
    let status_text = String::from_utf8_lossy(&status.stdout).to_string();
    assert_success("uc sync status after remove", status);
    assert!(!status_text.contains(&source_session), "{status_text}");
    assert!(
        !remote_root
            .join("workspace")
            .join("sessions")
            .join(&host_id)
            .join(".openclaw")
            .exists()
    );

    drop(_cleanup);
}

#[test]
#[ignore = "requires UC_E2E_REMOTE=user@host plus ssh/mutagen access"]
fn syncs_agent_directories_to_remote_workspace() {
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
    let claude_root_file = home.join(".claude").join("CLAUDE.md");
    let claude_history_file = home.join(".claude").join("history.jsonl");
    let claude_file_history_file = home
        .join(".claude")
        .join("file-history")
        .join(format!("claude-{run_id}"))
        .join("source@v1");
    let claude_env_file = home.join(".claude").join("session-env");
    let claude_plan_file = home.join(".claude").join("plans").join("launch.md");
    let claude_todo_file = home
        .join(".claude")
        .join("todos")
        .join(format!("{run_id}.json"));
    let codex_memory_file = home.join(".codex").join("memories").join("ultracontext.md");
    let codex_config_file = home.join(".codex").join("config.toml");
    let codex_version_file = home.join(".codex").join("version.json");
    let codex_history_file = home.join(".codex").join("history.jsonl");
    let codex_rule_file = home.join(".codex").join("rules").join("ultracontext.md");
    let codex_auth_file = home.join(".codex").join("auth.json");
    let codex_env_file = home.join(".codex").join(".env");
    let codex_node_module_file = home
        .join(".codex")
        .join("node_modules")
        .join("ignored-package")
        .join("index.js");
    let codex_extra_cache_file = home.join(".codex").join("scratch-cache").join("output.txt");

    fs::create_dir_all(claude_file.parent().unwrap()).unwrap();
    fs::create_dir_all(codex_file.parent().unwrap()).unwrap();
    fs::create_dir_all(claude_file_history_file.parent().unwrap()).unwrap();
    fs::create_dir_all(claude_plan_file.parent().unwrap()).unwrap();
    fs::create_dir_all(claude_todo_file.parent().unwrap()).unwrap();
    fs::create_dir_all(codex_memory_file.parent().unwrap()).unwrap();
    fs::create_dir_all(codex_rule_file.parent().unwrap()).unwrap();
    fs::create_dir_all(codex_node_module_file.parent().unwrap()).unwrap();
    fs::create_dir_all(codex_extra_cache_file.parent().unwrap()).unwrap();
    fs::create_dir_all(home.join(".ultracontext").join("ignores")).unwrap();
    fs::write(
        home.join(".ultracontext")
            .join("ignores")
            .join(".ultracontextignore"),
        "scratch-cache/\n",
    )
    .unwrap();
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
    fs::write(
        &claude_root_file,
        format!("project context marker from claude root {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &claude_history_file,
        format!(
            "{{\"sessionId\":\"claude-{run_id}\",\"timestamp\":1777075200000,\"display\":\"claude history marker should sync {run_id}\"}}\n"
        ),
    )
    .unwrap();
    fs::write(
        &claude_file_history_file,
        format!("claude file history marker should sync {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &claude_env_file,
        format!("claude env marker should sync {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &claude_plan_file,
        format!("claude plan marker should sync {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &claude_todo_file,
        format!("claude todo marker should sync {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &codex_memory_file,
        format!("memory marker from codex root {run_id}\n"),
    )
    .unwrap();
    fs::write(&codex_config_file, format!("model = \"test-{run_id}\"\n")).unwrap();
    fs::write(
        &codex_version_file,
        format!("{{\"latest_version\":\"test-{run_id}\"}}\n"),
    )
    .unwrap();
    fs::write(
        &codex_history_file,
        format!(
            "{{\"session_id\":\"codex-{run_id}\",\"ts\":1777075200,\"text\":\"codex history marker should sync {run_id}\"}}\n"
        ),
    )
    .unwrap();
    fs::write(
        &codex_rule_file,
        format!("rule marker from codex root {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &codex_auth_file,
        format!("fake auth file should sync {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &codex_env_file,
        format!("codex env marker should sync {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &codex_node_module_file,
        format!("node_modules marker should not sync {run_id}\n"),
    )
    .unwrap();
    fs::write(
        &codex_extra_cache_file,
        format!("custom ignore marker should not sync {run_id}\n"),
    )
    .unwrap();

    let setup = uc(&home)
        .args([
            "init",
            remote.as_str(),
            "--host-id",
            host_id.as_str(),
            "--remote-root",
            remote_root.as_str(),
            "--sync",
            "--yes",
        ])
        .output()
        .unwrap();
    assert_success("uc init", setup);

    let claude_remote = format!(
        "{remote_root}/workspace/{host_id}/.claude/projects/-tmp-ultracontext-e2e/session.jsonl"
    );
    let codex_remote = format!(
        "{remote_root}/workspace/{host_id}/.codex/sessions/2026/04/24/{}",
        codex_file.file_name().unwrap().to_string_lossy()
    );
    let claude_root_remote = format!("{remote_root}/workspace/{host_id}/.claude/CLAUDE.md");
    let claude_history_remote = format!("{remote_root}/workspace/{host_id}/.claude/history.jsonl");
    let claude_file_history_remote =
        format!("{remote_root}/workspace/{host_id}/.claude/file-history/claude-{run_id}/source@v1");
    let claude_env_remote = format!("{remote_root}/workspace/{host_id}/.claude/session-env");
    let claude_plan_remote = format!("{remote_root}/workspace/{host_id}/.claude/plans/launch.md");
    let claude_todo_remote = format!(
        "{remote_root}/workspace/{host_id}/.claude/todos/{}.json",
        run_id
    );
    let codex_memory_remote =
        format!("{remote_root}/workspace/{host_id}/.codex/memories/ultracontext.md");
    let codex_config_remote = format!("{remote_root}/workspace/{host_id}/.codex/config.toml");
    let codex_version_remote = format!("{remote_root}/workspace/{host_id}/.codex/version.json");
    let codex_history_remote = format!("{remote_root}/workspace/{host_id}/.codex/history.jsonl");
    let codex_rule_remote =
        format!("{remote_root}/workspace/{host_id}/.codex/rules/ultracontext.md");
    let codex_auth_remote = format!("{remote_root}/workspace/{host_id}/.codex/auth.json");
    let codex_env_remote = format!("{remote_root}/workspace/{host_id}/.codex/.env");
    let codex_node_module_remote =
        format!("{remote_root}/workspace/{host_id}/.codex/node_modules/ignored-package/index.js");
    let codex_extra_cache_remote =
        format!("{remote_root}/workspace/{host_id}/.codex/scratch-cache/output.txt");

    wait_for_remote_file(&remote, &claude_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &claude_root_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &claude_history_remote, Duration::from_secs(45));
    wait_for_remote_file(
        &remote,
        &claude_file_history_remote,
        Duration::from_secs(45),
    );
    wait_for_remote_file(&remote, &claude_env_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &claude_plan_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &claude_todo_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_memory_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_config_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_version_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_history_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_rule_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_auth_remote, Duration::from_secs(45));
    wait_for_remote_file(&remote, &codex_env_remote, Duration::from_secs(45));

    let remote_cat = ssh(
        &remote,
        &format!(
            "cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {} && cat {}",
            remote_path_arg(&claude_remote),
            remote_path_arg(&codex_remote),
            remote_path_arg(&claude_root_remote),
            remote_path_arg(&claude_history_remote),
            remote_path_arg(&claude_file_history_remote),
            remote_path_arg(&claude_env_remote),
            remote_path_arg(&claude_plan_remote),
            remote_path_arg(&claude_todo_remote),
            remote_path_arg(&codex_memory_remote),
            remote_path_arg(&codex_config_remote),
            remote_path_arg(&codex_version_remote),
            remote_path_arg(&codex_history_remote),
            remote_path_arg(&codex_rule_remote),
            remote_path_arg(&codex_auth_remote),
            remote_path_arg(&codex_env_remote)
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
    assert!(
        remote_text.contains(&format!("project context marker from claude root {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("claude history marker should sync {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("claude file history marker should sync {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("claude env marker should sync {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("claude plan marker should sync {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("claude todo marker should sync {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("memory marker from codex root {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("model = \"test-{run_id}\"")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("\"latest_version\":\"test-{run_id}\"")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("codex history marker should sync {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("rule marker from codex root {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("fake auth file should sync {run_id}")),
        "{remote_text}"
    );
    assert!(
        remote_text.contains(&format!("codex env marker should sync {run_id}")),
        "{remote_text}"
    );

    let ignored_files = ssh(
        &remote,
        &format!(
            "test ! -e {} && test ! -e {}",
            remote_path_arg(&codex_node_module_remote),
            remote_path_arg(&codex_extra_cache_remote),
        ),
    )
    .output()
    .unwrap();
    assert_success("global ignored files", ignored_files);

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

struct LocalSourceCleanup {
    home: PathBuf,
    host_id: String,
}

impl Drop for LocalSourceCleanup {
    fn drop(&mut self) {
        let _ = mutagen_with_home(&self.home)
            .args([
                "sync",
                "terminate",
                &format!("uc-{}-openclaw", self.host_id),
            ])
            .output();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn driver_list_and_run_use_local_manifest_commands() {
    let run_id = unique_run_id();
    let home = env::temp_dir().join(format!("uc-driver-home-{run_id}"));
    let driver_dir = home
        .join(".ultracontext")
        .join("drivers")
        .join("demo-driver");
    fs::create_dir_all(&driver_dir).unwrap();

    let script = home.join("driver-capture.sh");
    let marker = home.join("driver-marker.txt");
    fs::write(
        &script,
        "#!/bin/sh\nprintf 'driver-ran:%s\\n' \"$1\"\nprintf '%s' \"$1\" > \"$2\"\n",
    )
    .unwrap();
    make_executable(&script);

    fs::write(
        driver_dir.join("driver.toml"),
        format!(
            "name = \"demo-driver\"\nversion = \"0.1.0\"\ntype = \"external-app-sync\"\nruntime = \"shell\"\n\n[commands]\nopened = \"{} opened {}\"\n",
            script.display(),
            marker.display()
        ),
    )
    .unwrap();

    let list = uc(&home).args(["driver", "list"]).output().unwrap();
    let list_stdout = String::from_utf8_lossy(&list.stdout).to_string();
    assert_success("uc driver list", list);
    assert!(list_stdout.contains("demo-driver"), "{list_stdout}");
    assert!(list_stdout.contains("0.1.0"), "{list_stdout}");

    let run = uc(&home)
        .args(["driver", "run", "demo-driver", "opened"])
        .output()
        .unwrap();
    let run_stdout = String::from_utf8_lossy(&run.stdout).to_string();
    assert_success("uc driver run demo-driver opened", run);
    assert!(run_stdout.contains("driver-ran:opened"), "{run_stdout}");
    assert_eq!(fs::read_to_string(marker).unwrap(), "opened");

    let _ = fs::remove_dir_all(&home);
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

fn parse_ignore_lines(raw: &str) -> Vec<&str> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

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

fn wait_for_local_file(path: &Path, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if path.is_file() {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    panic!(
        "local file did not appear within {:?}: {}",
        timeout,
        path.display()
    );
}

fn wait_for_local_file_text(path: &Path, expected: &str, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if fs::read_to_string(path)
            .map(|text| text.contains(expected))
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    panic!(
        "local file did not contain expected text within {:?}: {}",
        timeout,
        path.display()
    );
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
