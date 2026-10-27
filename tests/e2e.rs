//! End-to-end: one hub and two "machines" (mac, linux) on this box, driven only through the real
//! `uc` binary and the filesystem (DESIGN §5, §6, §7). Each test gets its own hub and temp dirs.
//!
//!   cargo test --test e2e                  # skips while the binary is the todo!() skeleton
//!   UC_E2E_REQUIRE=1 cargo test --test e2e # never skip
//!   UC_E2E_KEEP=1 ...                      # keep /tmp/ucE2E-* state (always kept on failure)

mod common;

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use common::*;
use serde_json::Value;

// ---------------------------------------------------------------- shared setup + assertions

/// mac and linux joined to one hub, both with the project at ~/Code/proj (as if cloned with
/// git: uc never syncs code). Both daemons are connected and in sync when this returns.
fn pair(test: &str, seed: impl Fn(&Path)) -> Option<(World, Machine, Machine)> {
    let w = World::start(test)?;
    let mac = w.machine("mac");
    let linux = w.machine("linux");
    for m in [&mac, &linux] {
        seed(&m.code());
        m.init();
    }
    mac.sync();
    linux.sync();
    Some((w, mac, linux))
}

fn lossy(b: &[u8]) -> String {
    clip(&String::from_utf8_lossy(b), 600)
}

fn contains(hay: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(hay).contains(needle)
}

/// Stops a background writer thread even when the test panics.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- a) code stays put

/// uc moves sessions, never code: two agents on two machines can work in the same repo
/// without uc touching each other's files.
#[test]
fn code_folders_are_not_synced() {
    let Some((w, mac, linux)) = pair("code_not_synced", |c| {
        put(c, "proj/README.md", b"proj\n");
    }) else {
        return;
    };
    put(&mac.code(), "proj/mac-only.txt", b"mac\n");
    put(&mac.code(), "proj/.env", b"SECRET=1\n");
    put(&linux.code(), "proj/README.md", b"linux edit\n");
    mac.sync();
    linux.sync();
    w.check(
        read(&linux.code().join("proj/mac-only.txt")).is_none(),
        || "linux: a file from the mac's ~/Code showed up".into(),
    );
    w.check(read(&linux.code().join("proj/.env")).is_none(), || {
        "linux: the mac's .env showed up".into()
    });
    w.check(
        read(&mac.code().join("proj/README.md")).as_deref() == Some(b"proj\n".as_slice()),
        || "mac: linux's edit reached the mac's ~/Code".into(),
    );
}

// ---------------------------------------------------------------- b) Claude Code session

#[test]
fn claude_session_follows_you() {
    let Some((w, mac, linux)) = pair("claude_session", |c| {
        put(c, "proj/src/main.rs", b"fn main() {}\n");
    }) else {
        return;
    };
    let (mac_cwd, linux_cwd) = (mac.code().join("proj"), linux.code().join("proj"));
    let mac_home = mac.home.to_string_lossy().into_owned();
    let linux_home = linux.home.to_string_lossy().into_owned();

    let id = new_uuid();
    let (u1, u2) = (new_uuid(), new_uuid());
    let mac_file = mac.claude_transcript(&mac_cwd, &id);
    let prompt = format!("Fix the panic in {}/src/main.rs", mac_cwd.display());
    append_line(
        &mac_file,
        &claude_user_line(&id, &mac_cwd, &u1, None, &prompt),
    );
    let answer = format!("I'll read {}/src/main.rs first.", mac_cwd.display());
    append_line(
        &mac_file,
        &claude_assistant_line(&id, &mac_cwd, &u2, &u1, &answer),
    );
    let mac_content = String::from_utf8(read(&mac_file).expect("mac transcript")).expect("utf8");
    mac.sync();
    linux.sync();

    let sessions = linux.sessions();
    let Some(s) = find_session(&sessions, &id) else {
        w.fail(&format!(
            "linux: `uc sessions --json` does not list {id}:\n{sessions:#?}"
        ));
    };
    w.check(jstr(s, "/meta/agent") == Some("claude"), || {
        format!("meta.agent should be claude:\n{s:#}")
    });
    let described = [jstr(s, "/meta/title"), jstr(s, "/meta/first_prompt")]
        .iter()
        .flatten()
        .any(|t| t.contains("Fix the panic"));
    w.check(described, || {
        format!("title/first_prompt should come from the first prompt:\n{s:#}")
    });

    // Close the MacBook lid, continue on linux: the transcript is already where
    // `claude --resume` / `claude --continue` look for it, with linux paths.
    mac.daemon_stop();
    let linux_file = linux.claude_transcript(&linux_cwd, &id);
    let want = translate(&mac_content, &mac_home, &linux_home);
    wait_until(Duration::from_secs(10), || {
        read(&linux_file).as_deref() == Some(want.as_bytes())
    });
    let got = read(&linux_file);
    w.check(got.as_deref() == Some(want.as_bytes()), || {
        format!(
            "linux transcript at {} should be mac's with {mac_home} -> {linux_home}\n  expected: {}\n  found:    {:?}",
            linux_file.display(),
            clip(&want, 1500),
            got.as_deref().map(lossy)
        )
    });

    // From inside the project, `uc sessions --here` finds it.
    let here = linux.uc_json_in(&linux_cwd, &["sessions", "--here"]);
    w.check(
        here.as_array()
            .is_some_and(|a| find_session(a, &id).is_some()),
        || {
            format!(
                "linux: `uc sessions --here` in {} should list {id}:\n{here:#}",
                linux_cwd.display()
            )
        },
    );

    // claude continues on linux ...
    let line = claude_user_line(
        &id,
        &linux_cwd,
        &new_uuid(),
        Some(&u2),
        &format!("Now run the tests in {}", linux_cwd.display()),
    );
    append_line(&linux_file, &line);
    linux.sync();

    // ... and the MacBook catches up when it wakes, with mac paths.
    mac.daemon_start();
    mac.sync();
    let want_mac = format!(
        "{mac_content}{}\n",
        translate(&line, &linux_home, &mac_home)
    );
    let got = read(&mac_file);
    w.check(got.as_deref() == Some(want_mac.as_bytes()), || {
        format!(
            "mac transcript should end with linux's line (mac paths)\n  expected: {}\n  found:    {:?}",
            clip(&want_mac, 1500),
            got.as_deref().map(lossy)
        )
    });

    // One session, one file per machine, no fork.
    for m in [&mac, &linux] {
        let copies = find_named(&m.claude_dir, &format!("{id}.jsonl"));
        w.check(copies.len() == 1, || {
            format!(
                "{}: expected exactly one {id}.jsonl, found {copies:?}",
                m.name
            )
        });
    }
    let sessions = mac.sessions();
    let forks: Vec<&Value> = sessions
        .iter()
        .filter(|s| jstr(s, "/meta/forked_from").is_some())
        .collect();
    w.check(
        find_session(&sessions, &id).is_some() && forks.is_empty(),
        || format!("mac: expected session {id} and no forks:\n{sessions:#?}"),
    );
}

// ---------------------------------------------------------------- c) a machine joins later

/// A new machine joins after sessions exist: recent sessions land in its native folders with
/// its own $HOME, before its checkout of the project even exists.
#[test]
fn late_joiner_gets_sessions() {
    let Some((w, mac, _linux)) = pair("late_joiner", |c| {
        put(c, "proj/main.py", b"print('hi')\n");
    }) else {
        return;
    };
    let mac_cwd = mac.code().join("proj");
    let mac_home = mac.home.to_string_lossy().into_owned();
    let id = new_uuid();
    let u1 = new_uuid();
    let mac_file = mac.claude_transcript(&mac_cwd, &id);
    let prompt = format!("Explain {}/main.py", mac_cwd.display());
    append_line(
        &mac_file,
        &claude_user_line(&id, &mac_cwd, &u1, None, &prompt),
    );
    let mac_content = String::from_utf8(read(&mac_file).expect("mac transcript")).expect("utf8");
    mac.sync();

    let late = w.machine("late");
    late.init();
    late.sync();
    let late_home = late.home.to_string_lossy().into_owned();
    let late_file = late.claude_transcript(&late.code().join("proj"), &id);
    let want = translate(&mac_content, &mac_home, &late_home);
    let ok = wait_until(Duration::from_secs(10), || {
        read(&late_file).as_deref() == Some(want.as_bytes())
    });
    let found = find_named(&late.claude_dir, &format!("{id}.jsonl"));
    w.check(ok && found.len() == 1, || {
        format!(
            "late: transcript should be at {} with {mac_home} -> {late_home}; found {found:?}\n  expected: {}",
            late_file.display(),
            clip(&want, 1500)
        )
    });
}

// ---------------------------------------------------------------- d) Codex session

#[test]
fn codex_session_follows_you() {
    let Some((w, mac, linux)) = pair("codex_session", |c| {
        put(c, "proj/lib.rs", b"pub fn lib() {}\n");
    }) else {
        return;
    };
    let (mac_cwd, linux_cwd) = (mac.code().join("proj"), linux.code().join("proj"));

    let id = new_uuid();
    let rel = codex_rollout_rel(&id);
    let mac_file = mac.codex_dir.join(&rel);
    let prompt = format!("Refactor {}/lib.rs into modules", mac_cwd.display());
    append_line(&mac_file, &codex_meta_line(&id, &mac_cwd));
    append_line(&mac_file, &codex_turn_context_line(&mac_cwd));
    append_line(&mac_file, &codex_user_line(&prompt));
    append_line(&mac_file, &codex_event_user_line(&prompt));
    append_line(
        &mac_file,
        &codex_assistant_line(&format!("Reading {}/lib.rs", mac_cwd.display())),
    );
    let mac_content = String::from_utf8(read(&mac_file).expect("mac rollout")).expect("utf8");
    mac.sync();
    linux.sync();

    // Recent sessions are materialized eagerly (DESIGN §6.5), at the same relative path, and
    // BYTE-EXACT: Codex rollouts carry load-bearing byte offsets/ordinals (DESIGN §6.5a).
    let linux_file = linux.codex_dir.join(&rel);
    let want = mac_content.clone();
    let ok = wait_until(Duration::from_secs(10), || {
        read(&linux_file).as_deref() == Some(want.as_bytes())
    });
    w.check(ok, || {
        format!(
            "linux: {} should hold mac's rollout byte-exact\n  expected: {}\n  found:    {:?}",
            linux_file.display(),
            clip(&want, 1500),
            read(&linux_file).as_deref().map(lossy)
        )
    });

    let sessions = linux.sessions();
    let Some(s) = find_session(&sessions, &id) else {
        w.fail(&format!(
            "linux: `uc sessions --json` does not list {id}:\n{sessions:#?}"
        ));
    };
    w.check(jstr(s, "/meta/agent") == Some("codex"), || {
        format!("meta.agent should be codex:\n{s:#}")
    });

    // close the mac, `codex resume` on linux continues the rollout; the mac follows on wake.
    mac.daemon_stop();
    let line = codex_user_line(&format!("Also update {}/README.md", linux_cwd.display()));
    append_line(&linux_file, &line);
    linux.sync();
    mac.daemon_start();
    mac.sync();
    let want_mac = format!("{mac_content}{line}\n");
    let got = read(&mac_file);
    w.check(got.as_deref() == Some(want_mac.as_bytes()), || {
        format!(
            "mac rollout should end with linux's line, byte-exact\n  expected: {}\n  found:    {:?}",
            clip(&want_mac, 1500),
            got.as_deref().map(lossy)
        )
    });

    for m in [&mac, &linux] {
        let suffix = format!("-{id}.jsonl");
        let copies: Vec<_> = walk(&m.codex_dir)
            .into_iter()
            .filter(|(rel, _, _)| rel.ends_with(&suffix))
            .map(|(rel, _, _)| rel)
            .collect();
        w.check(copies.len() == 1, || {
            format!(
                "{}: expected exactly one rollout for {id}, found {copies:?}",
                m.name
            )
        });
    }
}

// ---------------------------------------------------------------- e) live elsewhere -> fork

/// The agent on the mac is still streaming when linux continues the same session: the canonical
/// session stays the mac's, linux's lines continue as a fork (DESIGN §6.4). Nothing is lost.
#[test]
fn live_session_elsewhere_forks() {
    let Some((w, mac, linux)) = pair("live_fork", |c| {
        put(c, "proj/README.md", b"proj\n");
    }) else {
        return;
    };
    let (mac_cwd, linux_cwd) = (mac.code().join("proj"), linux.code().join("proj"));
    let id = new_uuid();
    let mac_file = mac.claude_transcript(&mac_cwd, &id);
    let linux_file = linux.claude_transcript(&linux_cwd, &id);
    let u0 = new_uuid();
    append_line(
        &mac_file,
        &claude_user_line(&id, &mac_cwd, &u0, None, "Write the fork test"),
    );
    mac.sync();

    // The agent on the mac keeps streaming: mac owns the session and is live.
    let stop = Arc::new(AtomicBool::new(false));
    let streamer = {
        let (stop, path, id, cwd) = (stop.clone(), mac_file.clone(), id.clone(), mac_cwd.clone());
        let mut parent = u0.clone();
        thread::spawn(move || {
            let mut i = 0usize;
            while !stop.load(Ordering::SeqCst) {
                let u = new_uuid();
                append_line(
                    &path,
                    &claude_assistant_line(&id, &cwd, &u, &parent, &format!("mac-live-{i}")),
                );
                parent = u;
                i += 1;
                thread::sleep(Duration::from_millis(200));
            }
        })
    };
    let _stop_guard = StopOnDrop(stop.clone());

    let ok = wait_until(Duration::from_secs(15), || {
        read(&linux_file).is_some_and(|b| contains(&b, "mac-live-2"))
    });
    w.check(ok, || {
        "linux: the live mac session never streamed in (mac-live-2 missing after 15s)".into()
    });

    // `claude --resume` on linux writes to its copy while the mac is still going.
    let mut lparent = new_uuid();
    for j in 0..3 {
        let u = new_uuid();
        append_line(
            &linux_file,
            &claude_user_line(
                &id,
                &linux_cwd,
                &u,
                Some(&lparent),
                &format!("linux-too-{j}"),
            ),
        );
        lparent = u;
    }
    linux.sync_pushed(10);

    // linux's lines continue as a fork of the session
    let mut fork: Option<Value> = None;
    let ok = wait_until_every(Duration::from_secs(20), Duration::from_millis(500), || {
        fork = mac
            .sessions()
            .into_iter()
            .find(|s| jstr(s, "/meta/forked_from") == Some(id.as_str()));
        fork.is_some()
    });
    w.check(ok, || {
        format!("no session with meta.forked_from = {id} appeared within 20s")
    });
    let fork_id = fork
        .as_ref()
        .and_then(|f| jstr(f, "/meta/id"))
        .unwrap_or_default()
        .to_string();
    w.check(!fork_id.is_empty() && fork_id != id, || {
        format!("fork needs its own id:\n{fork:#?}")
    });
    let fork_name = format!("{fork_id}.jsonl");
    let mut fork_text = String::new();
    let ok = wait_until(Duration::from_secs(20), || {
        fork_text = find_named(&mac.claude_dir, &fork_name)
            .first()
            .and_then(|p| read(p))
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        fork_text.contains("linux-too-2")
    });
    w.check(ok, || {
        format!("mac: fork transcript {fork_name} with linux's lines never appeared:\n{fork_text}")
    });

    // the canonical session is the mac's alone, never mixed with linux's lines
    stop.store(true, Ordering::SeqCst);
    streamer.join().expect("streamer thread");
    mac.sync();
    let canon = String::from_utf8_lossy(&read(&mac_file).expect("mac transcript")).into_owned();
    w.check(!canon.contains("linux-too"), || {
        format!("linux's lines leaked into the live mac session:\n{canon}")
    });
    w.check(
        canon
            .lines()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()),
        || format!("mac transcript has a torn/invalid line:\n{canon}"),
    );
    for m in [&mac, &linux] {
        let copies = find_named(&m.claude_dir, &format!("{id}.jsonl"));
        w.check(copies.len() == 1, || {
            format!(
                "{}: expected exactly one {id}.jsonl, found {copies:?}",
                m.name
            )
        });
    }
}

// ---------------------------------------------------------------- the harness itself

#[test]
fn harness_self_check() {
    assert_eq!(
        claude_enc(Path::new("/Users/fabio/Code/my.proj_x")),
        "-Users-fabio-Code-my-proj-x"
    );
    assert_eq!(
        translate(
            "/h/mac/x /h/mac2/y /h/mac.d /h/mac\n\"/h/mac\"",
            "/h/mac",
            "/home/l"
        ),
        "/home/l/x /h/mac2/y /h/mac.d /home/l\n\"/home/l\""
    );
    // fabricated transcripts are valid JSON with the fields drivers read
    let cwd = Path::new("/Users/fabio/Code/proj");
    let id = new_uuid();
    let u = claude_user_line(&id, cwd, "u1", None, "say \"hi\"\n");
    let v: Value = serde_json::from_str(&u).expect("claude user line");
    assert_eq!(v["sessionId"], id.as_str());
    assert_eq!(v["cwd"], "/Users/fabio/Code/proj");
    assert_eq!(v["message"]["content"], "say \"hi\"\n");
    assert!(v["parentUuid"].is_null());
    let a: Value = serde_json::from_str(&claude_assistant_line(&id, cwd, "u2", "u1", "ok"))
        .expect("assistant");
    assert_eq!(a["message"]["content"][0]["text"], "ok");
    assert_eq!(a["parentUuid"], "u1");
    let m: Value = serde_json::from_str(&codex_meta_line(&id, cwd)).expect("codex meta");
    assert_eq!(m["payload"]["id"], id.as_str());
    assert_eq!(m["payload"]["cwd"], "/Users/fabio/Code/proj");
    for line in [
        codex_turn_context_line(cwd),
        codex_user_line("x"),
        codex_event_user_line("x"),
        codex_assistant_line("x"),
    ] {
        serde_json::from_str::<Value>(&line).expect("codex line");
    }
    let rel = codex_rollout_rel(&id);
    assert!(
        rel.starts_with("sessions/") && rel.ends_with(&format!("-{id}.jsonl")),
        "{rel}"
    );

    let dir = tempfile::Builder::new()
        .prefix("ucH")
        .tempdir_in("/tmp")
        .expect("tmp");
    put(dir.path(), "x/y.txt", b"same");
    assert_eq!(find_named(dir.path(), "y.txt").len(), 1);

    // commands are killed at the timeout, even with output still being produced
    let started = Instant::now();
    let mut sleeper = Command::new("sh");
    sleeper.args(["-c", "echo started; sleep 5"]);
    let out = run_with_timeout(
        sleeper,
        &dir.path().join("sleep"),
        Duration::from_millis(300),
    );
    assert!(!out.status.success());
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(String::from_utf8_lossy(&out.stderr).contains("killed after"));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "started\n");
    assert!(same_path(dir.path(), "~/x", &dir.path().join("x")));
}
