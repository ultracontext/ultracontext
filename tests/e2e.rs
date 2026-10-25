//! End-to-end: one hub and two "machines" (mac, linux) on this box, driven only through the real
//! `uc` binary and the filesystem (DESIGN §5, §6, §7). Each test gets its own hub and temp dirs.
//!
//!   cargo test --test e2e                  # skips while the binary is the todo!() skeleton
//!   UC_E2E_REQUIRE=1 cargo test --test e2e # never skip
//!   UC_E2E_KEEP=1 ...                      # keep /tmp/ucE2E-* state (always kept on failure)

mod common;

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use common::*;
use serde_json::Value;

// ---------------------------------------------------------------- shared setup + assertions

/// mac seeds ~/Code and shares it as space "code"; linux joins with `uc init --yes` and gets the
/// same ~/Code. Both daemons are connected and in sync when this returns.
fn code_pair(test: &str, seed: impl FnOnce(&Path)) -> Option<(World, Machine, Machine)> {
    let w = World::start(test)?;
    let mac = w.machine("mac");
    let linux = w.machine("linux");
    let code = mac.code();
    fs::create_dir_all(&code).expect("mkdir ~/Code");
    seed(&code);
    mac.init();
    mac.add_space(&code, "code");
    mac.sync();
    linux.init();
    linux.expect_space("code", &linux.code());
    linux.sync();
    assert_same_code(&w, &mac, &linux, "after linux joined");
    Some((w, mac, linux))
}

fn lossy(b: &[u8]) -> String {
    clip(&String::from_utf8_lossy(b), 600)
}

fn contains(hay: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(hay).contains(needle)
}

fn assert_same_code(w: &World, a: &Machine, b: &Machine, when: &str) {
    let sa = snapshot(&a.code());
    let sb = snapshot(&b.code());
    let d = tree_diff(&a.name, &sa, &b.name, &sb);
    w.check(d.is_empty(), || {
        format!(
            "{when}: ~/Code differs between {} and {}:\n{d}",
            a.name, b.name
        )
    });
}

fn assert_file(w: &World, m: &Machine, rel: &str, want: &[u8]) {
    let got = read(&m.code().join(rel));
    w.check(got.as_deref() == Some(want), || {
        format!(
            "{}: ~/Code/{rel}\n  expected: {:?}\n  found:    {:?}",
            m.name,
            lossy(want),
            got.as_deref().map(lossy)
        )
    });
}

fn assert_absent(w: &World, m: &Machine, rel: &str) {
    let p = m.code().join(rel);
    w.check(fs::symlink_metadata(&p).is_err(), || {
        format!("{}: ~/Code/{rel} should not exist", m.name)
    });
}

fn assert_no_conflicts(w: &World, m: &Machine) {
    let copies = conflict_copies(&m.code());
    w.check(copies.is_empty(), || {
        format!("{}: unexpected conflict copies: {copies:?}", m.name)
    });
}

/// `uc resume <target> --print --json`. While the previous owner's lease runs (DESIGN §6.4,
/// 120s) a non-TTY caller gets exit 3 "busy" and must choose; this then takes over explicitly.
fn resume_plan(w: &World, m: &Machine, target: &str) -> Value {
    let (out, v) = m.try_json(&["resume", target, "--print"]);
    if out.status.success() {
        return v.unwrap_or_else(|| {
            w.fail(&format!(
                "{}: `uc resume {target} --print --json` printed no JSON:\n{}",
                m.name,
                show(&out)
            ))
        });
    }
    let text = format!("{}{}", lossy(&out.stdout), lossy(&out.stderr)).to_lowercase();
    w.check(
        out.status.code() == Some(3) && text.contains("busy"),
        || {
            format!(
                "{}: `uc resume {target} --print --json` must succeed or exit 3 (busy):\n{}",
                m.name,
                show(&out)
            )
        },
    );
    m.uc_json(&["resume", target, "--print", "--takeover"])
}

fn check_plan(w: &World, plan: &Value, agent: &str, id: &str, cwd: &Path, native: &Path) {
    let cwd_s = cwd.to_string_lossy();
    let native_s = native.to_string_lossy();
    w.check(jstr(plan, "/agent") == Some(agent), || {
        format!("ResumePlan.agent should be {agent:?}:\n{plan:#}")
    });
    w.check(jstr(plan, "/id") == Some(id), || {
        format!("ResumePlan.id should be the full id {id}:\n{plan:#}")
    });
    w.check(jstr(plan, "/cwd") == Some(&*cwd_s), || {
        format!("ResumePlan.cwd should be this machine's project dir {cwd_s}:\n{plan:#}")
    });
    w.check(jbool(plan, "/cwd_missing") == Some(false), || {
        format!("ResumePlan.cwd_missing should be false (the project was synced):\n{plan:#}")
    });
    w.check(jstr(plan, "/native_path") == Some(&*native_s), || {
        format!("ResumePlan.native_path should be {native_s}:\n{plan:#}")
    });
    w.check(argv(plan).iter().any(|a| a == id), || {
        format!("ResumePlan.argv should contain the session id:\n{plan:#}")
    });
}

/// Stops a background writer thread even when the test panics.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- a) folders round-trip

#[test]
fn folder_roundtrip() {
    let blob = noise(300_000, 1);
    let blob2 = noise(70_000, 2);
    let Some((w, mac, linux)) = code_pair("folder_roundtrip", |c| {
        put(c, "README.md", b"# hello\n");
        put(c, "proj/src/main.rs", b"fn main() { println!(\"hi\"); }\n");
        put(c, "proj/src/util/mod.rs", b"pub fn util() {}\n");
        set_exec(&put(c, "proj/run.sh", b"#!/bin/sh\necho run\n"), true);
        put(c, "assets/blob.bin", &blob);
        put(c, "empty.txt", b"");
        put(c, "docs/with space.md", b"spaces in names\n");
        put(c, "docs/caf\u{e9}.txt", b"nfc name\n");
        make_symlink(c, "proj/main-link.rs", "src/main.rs");
        make_symlink(c, "docs/readme", "../README.md");
        make_symlink(c, "docs/dangling", "does/not/exist");
    }) else {
        return;
    };
    let (mc, lc) = (mac.code(), linux.code());

    assert_same_code(&w, &mac, &linux, "after the initial sync");
    w.check(is_exec(&lc.join("proj/run.sh")), || {
        "linux: proj/run.sh lost its exec bit".into()
    });
    for (link, target) in [
        ("proj/main-link.rs", "src/main.rs"),
        ("docs/readme", "../README.md"),
        ("docs/dangling", "does/not/exist"),
    ] {
        let got = fs::read_link(lc.join(link)).ok();
        w.check(got.as_deref() == Some(Path::new(target)), || {
            format!("linux: {link} should be a symlink to {target:?} (verbatim), found {got:?}")
        });
    }

    // mac: modify, nested create, delete, rename a file, rename a dir, drop the exec bit, new binary
    put(&mc, "README.md", b"# hello v2\n");
    put(&mc, "deep/a/b/c/d.txt", b"deep\n");
    fs::remove_file(mc.join("empty.txt")).expect("rm");
    fs::rename(mc.join("assets/blob.bin"), mc.join("assets/renamed.bin")).expect("mv file");
    fs::rename(mc.join("proj/src"), mc.join("proj/lib")).expect("mv dir");
    set_exec(&mc.join("proj/run.sh"), false);
    put(&mc, "assets/other.bin", &blob2);
    mac.sync();
    linux.sync();

    assert_same_code(&w, &mac, &linux, "after mac's edits");
    for gone in [
        "empty.txt",
        "assets/blob.bin",
        "proj/src/main.rs",
        "proj/src/util/mod.rs",
    ] {
        assert_absent(&w, &linux, gone);
    }
    assert_file(&w, &linux, "assets/renamed.bin", &blob);
    assert_file(&w, &linux, "proj/lib/util/mod.rs", b"pub fn util() {}\n");
    w.check(!is_exec(&lc.join("proj/run.sh")), || {
        "linux: proj/run.sh should have lost its exec bit".into()
    });

    // and back: linux edits, mac follows
    put(&lc, "from-linux.txt", b"hello from linux\n");
    put(
        &lc,
        "proj/lib/main.rs",
        b"fn main() { println!(\"edited on linux\"); }\n",
    );
    fs::remove_file(lc.join("docs/with space.md")).expect("rm");
    linux.sync();
    mac.sync();

    assert_same_code(&w, &mac, &linux, "after linux's edits");
    assert_file(&w, &mac, "from-linux.txt", b"hello from linux\n");
    assert_file(
        &w,
        &mac,
        "proj/lib/main.rs",
        b"fn main() { println!(\"edited on linux\"); }\n",
    );
    assert_absent(&w, &mac, "docs/with space.md");
    assert_no_conflicts(&w, &mac);
    assert_no_conflicts(&w, &linux);
}

// ---------------------------------------------------------------- b) live push, no `uc sync`

#[test]
fn realtime_without_explicit_sync() {
    let Some((w, mac, linux)) = code_pair("realtime", |c| {
        put(c, "seed.txt", b"seed\n");
    }) else {
        return;
    };
    let (mc, lc) = (mac.code(), linux.code());
    // No `uc` command from here on: only the daemons may move bytes.
    let live = |what: &str, cond: &mut dyn FnMut() -> bool| {
        let t = Instant::now();
        let ok = wait_until(Duration::from_secs(5), cond);
        w.check(ok, || {
            format!("{what}: not visible within 5s without `uc sync` (live push is broken)")
        });
        eprintln!("[realtime] {what}: {:.2?}", t.elapsed());
    };

    put(&mc, "live/hello.txt", b"written on mac\n");
    live("mac -> linux create", &mut || {
        read(&lc.join("live/hello.txt")).as_deref() == Some(&b"written on mac\n"[..])
    });

    put(&mc, "live/hello.txt", b"edited on mac\n");
    live("mac -> linux modify", &mut || {
        read(&lc.join("live/hello.txt")).as_deref() == Some(&b"edited on mac\n"[..])
    });

    put(&lc, "live/reply.txt", b"written on linux\n");
    live("linux -> mac create", &mut || {
        read(&mc.join("live/reply.txt")).as_deref() == Some(&b"written on linux\n"[..])
    });

    fs::remove_file(mc.join("seed.txt")).expect("rm");
    live("mac -> linux delete", &mut || {
        fs::symlink_metadata(lc.join("seed.txt")).is_err()
    });
}

// ---------------------------------------------------------------- c) conflicts keep both

#[test]
fn conflict_keeps_both() {
    let Some((w, mac, linux)) = code_pair("conflict", |c| {
        put(c, "notes.md", b"base\n");
        put(c, "dm1.txt", b"original 1\n");
        put(c, "dm2.txt", b"original 2\n");
    }) else {
        return;
    };
    let (mc, lc) = (mac.code(), linux.code());

    linux.daemon_stop();
    put(&mc, "notes.md", b"mac version\n");
    fs::remove_file(mc.join("dm1.txt")).expect("rm");
    put(&mc, "dm2.txt", b"mac modified 2\n");
    mac.sync();

    // the same files, edited on linux while it was offline
    put(&lc, "notes.md", b"linux version\n");
    put(&lc, "dm1.txt", b"linux modified 1\n");
    fs::remove_file(lc.join("dm2.txt")).expect("rm");

    linux.daemon_start();
    linux.sync();
    mac.sync();
    linux.sync();

    for m in [&mac, &linux] {
        // DESIGN §5.4: the hub (mac, first to commit) keeps the canonical path ...
        assert_file(&w, m, "notes.md", b"mac version\n");
        // ... and linux's version survives as a conflict copy that every machine gets.
        let copies = conflict_copies(&m.code());
        w.check(copies.len() == 1, || {
            format!(
                "{}: expected exactly one conflict copy (of notes.md), found {copies:?}",
                m.name
            )
        });
        let parsed = parse_conflict_name(&copies[0]);
        w.check(
            parsed == Some(("notes".to_string(), "linux".to_string(), ".md".to_string())),
            || {
                format!(
                    "{}: conflict copy {:?} should be named `notes (conflict linux YYYY-MM-DD HHMMSS).md`",
                    m.name, copies[0]
                )
            },
        );
        assert_file(&w, m, &copies[0], b"linux version\n");

        // delete vs modify: the modification wins, in both directions, with no copy
        assert_file(&w, m, "dm1.txt", b"linux modified 1\n");
        assert_file(&w, m, "dm2.txt", b"mac modified 2\n");

        let listed = m.uc_json(&["conflicts"]);
        w.check(
            listed.to_string().contains("notes (conflict linux "),
            || {
                format!(
                    "{}: `uc conflicts --json` does not list {:?}:\n{listed:#}",
                    m.name, copies[0]
                )
            },
        );
    }
    assert_same_code(&w, &mac, &linux, "after the conflict");
}

// ---------------------------------------------------------------- d) same bytes: no duplicate

#[test]
fn same_content_no_duplicate() {
    let Some((w, mac, linux)) = code_pair("same_content", |c| {
        put(c, "shared.txt", b"v1\n");
    }) else {
        return;
    };
    let (mc, lc) = (mac.code(), linux.code());
    let big = noise(200_000, 7);

    linux.daemon_stop();
    for root in [&mc, &lc] {
        put(root, "same.txt", b"identical on both machines\n");
        put(root, "new/dir/x.bin", &big);
        put(root, "shared.txt", b"v2: the same edit on both machines\n");
        if root == &mc {
            mac.sync();
        }
    }
    linux.daemon_start();
    linux.sync();
    mac.sync();
    linux.sync();

    for m in [&mac, &linux] {
        assert_no_conflicts(&w, m);
        assert_file(&w, m, "same.txt", b"identical on both machines\n");
        assert_file(&w, m, "shared.txt", b"v2: the same edit on both machines\n");
        assert_file(&w, m, "new/dir/x.bin", &big);
        let listed = m.uc_json(&["conflicts"]);
        w.check(!listed.to_string().contains("(conflict "), || {
            format!(
                "{}: identical content must not produce conflicts:\n{listed:#}",
                m.name
            )
        });
    }
    assert_same_code(&w, &mac, &linux, "after identical offline edits");
}

// ---------------------------------------------------------------- e) files agents are writing

#[test]
fn agent_writing_file() {
    let Some((w, mac, linux)) = code_pair("agent_writes", |c| {
        put(c, "agent/README", b"agent workspace\n");
    }) else {
        return;
    };
    let (mc, lc) = (mac.code(), linux.code());

    // An agent streaming JSONL: 50 appends, 20ms apart.
    let appender = {
        let p = mc.join("agent/stream.jsonl");
        thread::spawn(move || {
            let mut all = Vec::new();
            for i in 0..50usize {
                let line = format!(r#"{{"i":{i},"chunk":"{}"}}"#, "x".repeat(i * 37 % 500));
                append_line(&p, &line);
                all.extend_from_slice(line.as_bytes());
                all.push(b'\n');
                thread::sleep(Duration::from_millis(20));
            }
            all
        })
    };
    // An agent rewriting a file in place: truncate + two writes, so readers can see torn content.
    let rewriter = {
        let p = mc.join("agent/plan.md");
        thread::spawn(move || {
            let mut last = Vec::new();
            for i in 0..50usize {
                let body = format!("# plan v{i}\n{}\n", "step ".repeat(500 + i)).into_bytes();
                let mut f = fs::File::create(&p).expect("create plan.md");
                let half = body.len() / 2;
                f.write_all(&body[..half]).expect("write");
                thread::sleep(Duration::from_millis(5));
                f.write_all(&body[half..]).expect("write");
                drop(f);
                last = body;
                thread::sleep(Duration::from_millis(15));
            }
            last
        })
    };
    let want_stream = appender.join().expect("appender thread");
    let want_plan = rewriter.join().expect("rewriter thread");

    mac.sync();
    linux.sync();

    // On mac too: uc must never put an older snapshot back over the agent's own file.
    for m in [&mac, &linux] {
        assert_file(&w, m, "agent/stream.jsonl", &want_stream);
        assert_file(&w, m, "agent/plan.md", &want_plan);
        assert_no_conflicts(&w, m);
    }
    let _ = (mc, lc);
}

// ---------------------------------------------------------------- f) ignore rules, .env, .git

#[test]
fn gitignore_and_env() {
    // Own setup: the repo exists (git init + commit) before the folder is shared, as in real life.
    let Some(w) = World::start("gitignore_env") else {
        return;
    };
    let mac = w.machine("mac");
    let linux = w.machine("linux");
    let (mc, lc) = (mac.code(), linux.code());
    let (mweb, lweb) = (mc.join("web"), lc.join("web"));
    put(&mc, "web/.gitignore", b"node_modules/\n.env\nbuild/\n");
    put(&mc, "web/src/app.js", b"console.log('app');\n");
    put(&mc, "web/node_modules/x/index.js", b"module.exports = 1;\n");
    put(&mc, "web/build/y.txt", b"build output\n");
    put(&mc, "web/.env", b"SECRET=hunter2\n");
    put(&mc, "web/.env.local", b"LOCAL=1\n");
    // Outside the repo, so `git status` on linux is not affected by files uc never syncs.
    put(&mc, "misc/keep.txt", b"keep\n");
    put(&mc, "misc/target/debug/app", b"\x7fELF");
    put(&mc, "misc/.DS_Store", b"junk");
    put(&mc, "misc/.ucignore", b"*.secret-notes\n");
    put(&mc, "misc/me.secret-notes", b"private\n");

    let git = git_available();
    if git {
        mac.git_ok(&mweb, &["init", "-q"]);
        mac.git_ok(&mweb, &["add", "-A"]);
        mac.git_ok(&mweb, &["commit", "-q", "-m", "initial commit"]);
    } else {
        eprintln!("[gitignore_and_env] git is not installed: skipping the .git checks");
    }
    mac.init();
    mac.add_space(&mc, "code");
    mac.sync();
    linux.init();
    linux.expect_space("code", &lc);
    linux.sync();

    // .env is gitignored but always_include wins (DESIGN §5.5 rule 4); dotfiles are synced.
    for rel in [
        "web/.gitignore",
        "web/src/app.js",
        "web/.env",
        "web/.env.local",
        "misc/keep.txt",
        "misc/.ucignore",
    ] {
        let want = read(&mc.join(rel)).expect("mac file");
        assert_file(&w, &linux, rel, &want);
    }
    // built-in ignores + .ucignore
    for rel in [
        "web/node_modules",
        "misc/target",
        "misc/.DS_Store",
        "misc/me.secret-notes",
    ] {
        assert_absent(&w, &linux, rel);
    }

    if git {
        // .gitignore (inside a repo)
        assert_absent(&w, &linux, "web/build");
        let log = linux.git_ok(&lweb, &["log", "--oneline"]);
        w.check(log.contains("initial commit"), || {
            format!("linux: `git log` should show the commit made on mac:\n{log}")
        });
        let st = linux.git_ok(&lweb, &["status", "--porcelain"]);
        w.check(st.trim().is_empty(), || {
            format!("linux: `git status` should be clean:\n{st}")
        });
        linux.git_ok(&lweb, &["fsck", "--no-progress"]);
        // `git status` may refresh .git/index on linux: let that land before mac commits again.
        linux.sync();
        mac.sync();

        put(&mc, "web/src/app.js", b"console.log('app v2');\n");
        mac.git_ok(&mweb, &["commit", "-q", "-am", "second commit"]);
        mac.sync();
        linux.sync();

        let log = linux.git_ok(&lweb, &["log", "--oneline"]);
        w.check(
            log.contains("second commit") && log.contains("initial commit"),
            || format!("linux: `git log` should show both commits:\n{log}"),
        );
        let mac_head = mac.git_ok(&mweb, &["rev-parse", "HEAD"]);
        let linux_head = linux.git_ok(&lweb, &["rev-parse", "HEAD"]);
        w.check(mac_head == linux_head, || {
            format!("HEAD differs: mac {mac_head} linux {linux_head}")
        });
        for m in [&mac, &linux] {
            let dir = m.code().join("web");
            let st = m.git_ok(&dir, &["status", "--porcelain"]);
            w.check(st.trim().is_empty(), || {
                format!(
                    "{}: `git status` should be clean after the second commit:\n{st}",
                    m.name
                )
            });
        }
    }
    assert_no_conflicts(&w, &mac);
    assert_no_conflicts(&w, &linux);
}

// ---------------------------------------------------------------- g) Claude Code session

#[test]
fn claude_session_follows_you() {
    let Some((w, mac, linux)) = code_pair("claude_session", |c| {
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

    // Close the MacBook lid, continue on linux.
    mac.daemon_stop();
    let plan = resume_plan(&w, &linux, &id[..8]);
    let linux_file = linux.claude_transcript(&linux_cwd, &id);
    check_plan(&w, &plan, "claude", &id, &linux_cwd, &linux_file);
    let av = argv(&plan);
    w.check(
        av.windows(2).any(|p| p[0] == "--resume" && p[1] == id),
        || format!("claude argv should contain `--resume {id}`: {av:?}"),
    );

    let want = translate(&mac_content, &mac_home, &linux_home);
    let got = read(&linux_file);
    w.check(got.as_deref() == Some(want.as_bytes()), || {
        format!(
            "linux transcript at {} should be mac's with {mac_home} -> {linux_home}\n  expected: {}\n  found:    {:?}",
            linux_file.display(),
            clip(&want, 1500),
            got.as_deref().map(lossy)
        )
    });

    // From inside the project, no id needed: `--here` and bare `uc resume` (DESIGN §7) find it.
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
    let latest = linux.uc_json_in(&linux_cwd, &["resume", "--print"]);
    w.check(jstr(&latest, "/id") == Some(id.as_str()), || {
        format!("linux: bare `uc resume` in the project should pick {id}:\n{latest:#}")
    });

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

// ---------------------------------------------------------------- h) Codex session

#[test]
fn codex_session_follows_you() {
    let Some((w, mac, linux)) = code_pair("codex_session", |c| {
        put(c, "proj/lib.rs", b"pub fn lib() {}\n");
    }) else {
        return;
    };
    let (mac_cwd, linux_cwd) = (mac.code().join("proj"), linux.code().join("proj"));
    let mac_home = mac.home.to_string_lossy().into_owned();
    let linux_home = linux.home.to_string_lossy().into_owned();

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

    // Recent sessions are materialized eagerly (DESIGN §6.5), at the same relative path.
    let linux_file = linux.codex_dir.join(&rel);
    let want = translate(&mac_content, &mac_home, &linux_home);
    let ok = wait_until(Duration::from_secs(10), || {
        read(&linux_file).as_deref() == Some(want.as_bytes())
    });
    w.check(ok, || {
        format!(
            "linux: {} should hold mac's rollout with {mac_home} -> {linux_home}\n  expected: {}\n  found:    {:?}",
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

    let plan = resume_plan(&w, &linux, &id);
    check_plan(&w, &plan, "codex", &id, &linux_cwd, &linux_file);
    let av = argv(&plan);
    w.check(
        av.len() >= 2 && av[0] == "codex" && av[1] == "resume",
        || format!("codex argv should start with [\"codex\", \"resume\"]: {av:?}"),
    );

    // codex continues on linux; the mac (online) follows.
    let line = codex_user_line(&format!("Also update {}/README.md", linux_cwd.display()));
    append_line(&linux_file, &line);
    linux.sync();
    mac.sync();
    let want_mac = format!(
        "{mac_content}{}\n",
        translate(&line, &linux_home, &mac_home)
    );
    let got = read(&mac_file);
    w.check(got.as_deref() == Some(want_mac.as_bytes()), || {
        format!(
            "mac rollout should end with linux's line (mac paths)\n  expected: {}\n  found:    {:?}",
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

// ---------------------------------------------------------------- i) takeover + fork

#[test]
fn live_session_takeover() {
    let Some((w, mac, linux)) = code_pair("takeover", |c| {
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
        &claude_user_line(&id, &mac_cwd, &u0, None, "Write the takeover test"),
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
            parent
        })
    };
    let _stop_guard = StopOnDrop(stop.clone());

    let ok = wait_until(Duration::from_secs(15), || {
        read(&linux_file).is_some_and(|b| contains(&b, "mac-live-2"))
    });
    w.check(ok, || {
        "linux: the live mac session never streamed in (mac-live-2 missing after 15s)".into()
    });

    let out = linux.uc(&["resume", &id, "--print", "--json"]);
    let text = format!("{}{}", lossy(&out.stdout), lossy(&out.stderr)).to_lowercase();
    w.check(
        out.status.code() == Some(3) && text.contains("busy"),
        || {
            format!(
                "linux: resuming a live session without a flag must exit 3 (busy):\n{}",
                show(&out)
            )
        },
    );

    let plan = linux.uc_json(&["resume", &id, "--print", "--takeover"]);
    check_plan(&w, &plan, "claude", &id, &linux_cwd, &linux_file);
    w.check(jbool(&plan, "/took_over") == Some(true), || {
        format!("took_over should be true:\n{plan:#}")
    });
    linux.sync();
    let at_takeover = read(&linux_file).expect("linux transcript");

    // The old process on the mac does not know yet and keeps writing.
    stop.store(true, Ordering::SeqCst);
    let mut parent = streamer.join().expect("streamer thread");
    for j in 0..5 {
        let u = new_uuid();
        append_line(
            &mac_file,
            &claude_assistant_line(
                &id,
                &mac_cwd,
                &u,
                &parent,
                &format!("mac-after-takeover-{j}"),
            ),
        );
        parent = u;
        thread::sleep(Duration::from_millis(100));
    }
    // claude continues on linux
    let mut linux_lines = String::new();
    let mut lparent = new_uuid();
    for j in 0..3 {
        let u = new_uuid();
        let line = claude_user_line(
            &id,
            &linux_cwd,
            &u,
            Some(&lparent),
            &format!("linux-after-takeover-{j}"),
        );
        append_line(&linux_file, &line);
        linux_lines.push_str(&line);
        linux_lines.push('\n');
        lparent = u;
    }
    linux.sync();
    mac.sync();
    linux.sync();
    mac.sync();

    // The canonical transcript is exactly what it was at takeover plus linux's own lines.
    let got = read(&linux_file).expect("linux transcript");
    let want = [at_takeover.clone(), linux_lines.clone().into_bytes()].concat();
    w.check(got == want, || {
        format!(
            "linux transcript was corrupted after the takeover\n  expected: {}\n  found:    {}",
            lossy(&want),
            lossy(&got)
        )
    });
    // ... and what it was at takeover is a clean prefix: first prompt, then mac-live-0..k in order.
    let text = String::from_utf8_lossy(&at_takeover).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    w.check(
        lines
            .iter()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()),
        || format!("transcript at takeover has a torn/invalid line:\n{text}"),
    );
    w.check(
        lines
            .first()
            .is_some_and(|l| l.contains("Write the takeover test")),
        || format!("transcript at takeover should start with the first prompt:\n{text}"),
    );
    let live: Vec<usize> = lines
        .iter()
        .skip(1)
        .filter_map(|l| {
            let v: Value = serde_json::from_str(l).ok()?;
            let t = v.pointer("/message/content/0/text")?.as_str()?;
            t.strip_prefix("mac-live-")?.parse().ok()
        })
        .collect();
    w.check(
        lines.len() == 1 + live.len() && live.iter().enumerate().all(|(i, n)| i == *n) && live.len() >= 3,
        || format!("transcript at takeover should be the prompt + mac-live-0..k (k>=2) in order:\n{text}"),
    );
    w.check(!text.contains("mac-after-takeover"), || {
        format!(
            "lines written on mac after the takeover leaked into the canonical session:\n{text}"
        )
    });

    let sessions = linux.sessions();
    let owner = find_session(&sessions, &id).and_then(|s| jstr(s, "/owner_name"));
    w.check(owner == Some("linux"), || {
        format!("session {id} should now be owned by linux:\n{sessions:#?}")
    });

    // The mac's stray lines continue as a fork (DESIGN §6.4).
    let mut fork: Option<Value> = None;
    let ok = wait_until_every(Duration::from_secs(20), Duration::from_millis(500), || {
        fork = linux
            .sessions()
            .into_iter()
            .find(|s| jstr(s, "/meta/forked_from") == Some(id.as_str()));
        fork.is_some()
    });
    w.check(ok, || {
        format!("no session with meta.forked_from = {id} appeared within 20s")
    });
    let fork = fork.unwrap_or_default();
    let fork_id = jstr(&fork, "/meta/id").unwrap_or_default().to_string();
    w.check(!fork_id.is_empty() && fork_id != id, || {
        format!("fork needs its own id:\n{fork:#}")
    });

    let fork_name = format!("{fork_id}.jsonl");
    let mut fork_text = String::new();
    let ok = wait_until(Duration::from_secs(20), || {
        fork_text = find_named(&linux.claude_dir, &fork_name)
            .first()
            .and_then(|p| read(p))
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        fork_text.contains("mac-after-takeover-4")
    });
    w.check(ok, || {
        format!("linux: fork transcript {fork_name} with mac's stray lines never appeared:\n{fork_text}")
    });
    let foreign: Vec<&str> = fork_text
        .lines()
        .filter(|l| {
            serde_json::from_str::<Value>(l)
                .ok()
                .and_then(|v| {
                    v.get("sessionId")
                        .and_then(Value::as_str)
                        .map(|s| s != fork_id)
                })
                .unwrap_or(true)
        })
        .collect();
    w.check(foreign.is_empty(), || {
        format!("fork lines must carry sessionId {fork_id} (driver fork_line):\n{foreign:#?}")
    });

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

// ---------------------------------------------------------------- j) offline catch-up

#[test]
fn offline_catchup() {
    let Some((w, mac, linux)) = code_pair("offline_catchup", |c| {
        for i in 0..6 {
            put(
                c,
                &format!("existing/{i}.txt"),
                format!("existing {i}\n").as_bytes(),
            );
        }
    }) else {
        return;
    };
    let mc = mac.code();

    linux.daemon_stop();
    // 20 changes: 14 creates, 3 modifications, 2 deletions, 1 rename
    for i in 0..14 {
        put(
            &mc,
            &format!("batch/{}/f{i}.txt", i % 3),
            format!("created offline {i}\n").as_bytes(),
        );
    }
    for i in 0..3 {
        put(
            &mc,
            &format!("existing/{i}.txt"),
            format!("modified offline {i}\n").as_bytes(),
        );
    }
    fs::remove_file(mc.join("existing/3.txt")).expect("rm");
    fs::remove_file(mc.join("existing/4.txt")).expect("rm");
    fs::create_dir_all(mc.join("renamed")).expect("mkdir");
    fs::rename(mc.join("existing/5.txt"), mc.join("renamed/5.txt")).expect("mv");
    mac.sync();

    linux.daemon_start();
    linux.sync();

    assert_same_code(&w, &mac, &linux, "after linux caught up");
    for i in 0..14 {
        assert_file(
            &w,
            &linux,
            &format!("batch/{}/f{i}.txt", i % 3),
            format!("created offline {i}\n").as_bytes(),
        );
    }
    for i in 0..3 {
        assert_file(
            &w,
            &linux,
            &format!("existing/{i}.txt"),
            format!("modified offline {i}\n").as_bytes(),
        );
    }
    assert_absent(&w, &linux, "existing/3.txt");
    assert_absent(&w, &linux, "existing/4.txt");
    assert_absent(&w, &linux, "existing/5.txt");
    assert_file(&w, &linux, "renamed/5.txt", b"existing 5\n");
    assert_no_conflicts(&w, &linux);
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
    assert_eq!(
        parse_conflict_name("notes (conflict linux 2026-10-25 071530).md"),
        Some(("notes".into(), "linux".into(), ".md".into()))
    );
    assert_eq!(
        parse_conflict_name("Makefile (conflict my mac 2026-10-25 071530)"),
        Some(("Makefile".into(), "my mac".into(), String::new()))
    );
    assert_eq!(
        parse_conflict_name("notes (conflict linux yesterday).md"),
        None
    );
    assert_eq!(parse_conflict_name("notes.md"), None);

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

    // snapshots see content, exec bits and symlink targets
    let dir = tempfile::Builder::new()
        .prefix("ucH")
        .tempdir_in("/tmp")
        .expect("tmp");
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    for root in [&a, &b] {
        put(root, "x/y.txt", b"same");
        set_exec(&put(root, "run.sh", b"#!/bin/sh\n"), true);
        make_symlink(root, "link", "x/y.txt");
    }
    assert_eq!(tree_diff("a", &snapshot(&a), "b", &snapshot(&b)), "");
    set_exec(&b.join("run.sh"), false);
    put(&b, "x/z.txt", b"extra");
    let d = tree_diff("a", &snapshot(&a), "b", &snapshot(&b));
    assert!(
        d.contains("differs: run.sh") && d.contains("only on b: x/z.txt"),
        "{d}"
    );
    assert_eq!(conflict_copies(&a), Vec::<String>::new());
    put(&a, "x/y (conflict mac 2026-10-25 071530).txt", b"other");
    assert_eq!(
        conflict_copies(&a),
        vec!["x/y (conflict mac 2026-10-25 071530).txt".to_string()]
    );
    assert_eq!(find_named(&a, "y.txt").len(), 1);

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
