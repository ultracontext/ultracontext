//! Multi-machine end-to-end harness. DESIGN §2: tests override HOME / UC_HOME per process, so one
//! box can host a hub plus several "machines".
//!
//! A `World` is one `uc hub serve` process plus any number of `Machine`s. Each machine has its own
//! HOME, UC_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME. Tests drive machines only through the real
//! `uc` binary and the filesystem, the same way a user or an agent would.
//!
//! Knobs (env):
//! - `UC_E2E_KEEP=1`     keep the temp dir (it is always kept when a test fails)
//! - `UC_E2E_LOG=filter` UC_LOG for hub, daemons and CLI (default "debug")
//! - `UC_E2E_JOBS=N`     max worlds alive at once across parallel tests (default 3)
//! - `UC_E2E_REQUIRE=1`  fail instead of skip when the binary is still the unimplemented skeleton
//! - `UC_E2E_BIN=path`   test another `uc` build (default: the binary cargo just built)

#![allow(dead_code)]

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

/// The binary under test: `UC_E2E_BIN` (e.g. a release or installed build) or the one cargo built.
pub fn uc_bin() -> PathBuf {
    std::env::var_os("UC_E2E_BIN")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_uc")))
}
/// Hard limit for any single `uc` invocation.
pub const CMD_TIMEOUT: Duration = Duration::from_secs(60);
const LOG_TAIL_LINES: usize = 80;
const LISTING_MAX: usize = 150;

// ---------------------------------------------------------------- concurrency limit

static ACTIVE: Mutex<usize> = Mutex::new(0);
static RELEASED: Condvar = Condvar::new();

/// Caps how many worlds (1 hub + N daemons each) run at once; timing assertions such as
/// "visible within 5s" are meaningless on an overloaded box.
struct Slot;

impl Slot {
    fn acquire() -> Slot {
        let max = std::env::var("UC_E2E_JOBS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(3);
        let mut n = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
        while *n >= max {
            n = RELEASED.wait(n).unwrap_or_else(|e| e.into_inner());
        }
        *n += 1;
        Slot
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut n = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
        *n = n.saturating_sub(1);
        RELEASED.notify_all();
    }
}

// ---------------------------------------------------------------- world

#[derive(Debug, Clone)]
struct Dirs {
    name: String,
    home: PathBuf,
    uc_home: PathBuf,
}

/// Lives as long as the last `World` / `Machine` handle, so the hub and the temp dir always
/// outlive every daemon regardless of the order the test drops its handles in.
struct Shared {
    test: String,
    root: PathBuf,
    hub_home: PathBuf,
    hub_addr: String,
    hub_out: PathBuf,
    hub: Mutex<Option<Child>>,
    machines: Mutex<Vec<Dirs>>,
    tmp: Mutex<Option<tempfile::TempDir>>,
    cmd_seq: AtomicU32,
    _slot: Slot,
}

impl Drop for Shared {
    fn drop(&mut self) {
        let failed = std::thread::panicking();
        if let Some(mut hub) = self.hub.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = hub.kill();
            let _ = hub.wait();
        }
        if failed {
            eprintln!("{}", hub_report(self));
        }
        let keep = failed || env_flag("UC_E2E_KEEP");
        if let Some(tmp) = self.tmp.lock().unwrap_or_else(|e| e.into_inner()).take() {
            if keep {
                let p = tmp.keep();
                eprintln!("[e2e:{}] state kept at {}", self.test, p.display());
            }
        }
    }
}

pub struct World {
    shared: Arc<Shared>,
}

enum HubState {
    Up,
    Skeleton(String),
    Failed(String),
}

impl World {
    /// Start a hub in a fresh temp dir. `None` means the binary is still the unimplemented
    /// skeleton (the test is skipped, unless UC_E2E_REQUIRE=1).
    pub fn start(test: &str) -> Option<World> {
        let slot = Slot::acquire();
        let tmp = tempfile::Builder::new()
            .prefix("ucE2E-")
            .tempdir_in("/tmp")
            .expect("create temp dir under /tmp");
        // Canonical root: on macOS /tmp is a symlink to /private/tmp and FSEvents reports real paths.
        let root = fs::canonicalize(tmp.path()).expect("canonicalize temp dir");
        let hub_home = root.join("hub");
        let hub_host_home = root.join("hubhost");
        fs::create_dir_all(&hub_home).expect("create hub UC_HOME");
        fs::create_dir_all(&hub_host_home).expect("create hub HOME");
        fs::create_dir_all(root.join("cmd")).expect("create cmd log dir");
        let hub_out = root.join("cmd").join("hub-serve.out");
        let hub_addr = format!("unix:{}", hub_home.join("hub.sock").display());

        let out = fs::File::create(&hub_out).expect("create hub output file");
        let err = out.try_clone().expect("clone hub output file");
        let child = Command::new(uc_bin())
            .args(["hub", "serve"])
            .current_dir(&root)
            .env("UC_HOME", &hub_home)
            .env("HOME", &hub_host_home)
            .env("UC_LOG", log_filter())
            .env("NO_COLOR", "1")
            .env_remove("UC_TOKEN")
            .env_remove("UC_SSH")
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
            .expect("spawn `uc hub serve`");

        let w = World {
            shared: Arc::new(Shared {
                test: test.to_string(),
                root,
                hub_home,
                hub_addr,
                hub_out,
                hub: Mutex::new(Some(child)),
                machines: Mutex::new(Vec::new()),
                tmp: Mutex::new(Some(tmp)),
                cmd_seq: AtomicU32::new(0),
                _slot: slot,
            }),
        };
        match w.wait_hub() {
            HubState::Up => Some(w),
            HubState::Skeleton(out) => {
                if env_flag("UC_E2E_REQUIRE") {
                    w.fail(&format!(
                        "UC_E2E_REQUIRE=1 but the hub is unimplemented:\n{out}"
                    ));
                }
                eprintln!(
                    "[e2e:{test}] SKIPPED: `uc hub serve` is still a todo!() stub. \
                     Set UC_E2E_REQUIRE=1 to make this a failure."
                );
                None
            }
            HubState::Failed(msg) => w.fail(&msg),
        }
    }

    fn wait_hub(&self) -> HubState {
        let sock = self.shared.hub_home.join("hub.sock");
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if UnixStream::connect(&sock).is_ok() {
                return HubState::Up;
            }
            let exited = {
                let mut hub = self.shared.hub.lock().unwrap_or_else(|e| e.into_inner());
                match hub.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(status))) => Some(status.to_string()),
                    Some(Err(e)) => Some(format!("wait error: {e}")),
                    _ => None,
                }
            };
            if let Some(status) = exited {
                let out = read_lossy(&self.shared.hub_out);
                if out.contains("not yet implemented") {
                    return HubState::Skeleton(out);
                }
                return HubState::Failed(format!(
                    "`uc hub serve` exited early ({status}) before listening on {}",
                    sock.display()
                ));
            }
            if Instant::now() >= deadline {
                return HubState::Failed(format!(
                    "`uc hub serve` is running but {} accepts no connections after 15s",
                    sock.display()
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A machine with its own HOME (`<root>/<name>`), UC_HOME, ~/.claude and ~/.codex. Not
    /// initialized yet: call `init()`.
    pub fn machine(&self, name: &str) -> Machine {
        let home = self.shared.root.join(name);
        let uc_home = home.join(".ultracontext");
        let claude_dir = home.join(".claude");
        let codex_dir = home.join(".codex");
        for d in [&home, &claude_dir, &codex_dir] {
            fs::create_dir_all(d).expect("create machine dirs");
        }
        self.shared
            .machines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Dirs {
                name: name.to_string(),
                home: home.clone(),
                uc_home: uc_home.clone(),
            });
        Machine {
            name: name.to_string(),
            home,
            uc_home,
            claude_dir,
            codex_dir,
            shared: self.shared.clone(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.shared.root
    }

    pub fn hub_addr(&self) -> &str {
        &self.shared.hub_addr
    }

    pub fn hub_home(&self) -> &Path {
        &self.shared.hub_home
    }

    /// Full diagnostics: every machine's status, files and daemon.log tail, plus the hub logs.
    pub fn report(&self) -> String {
        world_report(&self.shared)
    }

    pub fn fail(&self, msg: &str) -> ! {
        panic!("{msg}\n{}", self.report())
    }

    pub fn check(&self, cond: bool, msg: impl FnOnce() -> String) {
        if !cond {
            self.fail(&msg());
        }
    }
}

// ---------------------------------------------------------------- machine

pub struct Machine {
    pub name: String,
    pub home: PathBuf,
    pub uc_home: PathBuf,
    pub claude_dir: PathBuf,
    pub codex_dir: PathBuf,
    shared: Arc<Shared>,
}

impl Drop for Machine {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "── {} daemon.log (last {LOG_TAIL_LINES} lines)\n{}",
                self.name,
                tail_lines(&self.daemon_log(), LOG_TAIL_LINES)
            );
        }
        let pid = self.daemon_pid();
        if self.uc_home.join("daemon.sock").exists() || pid.is_some() {
            let _ = self.run(
                &self.home,
                &["daemon", "stop"],
                Duration::from_secs(10),
                false,
            );
        }
        if let Some(pid) = pid.or_else(|| self.daemon_pid()) {
            if !wait_until(Duration::from_secs(3), || !pid_alive(pid)) && is_uc_process(pid) {
                // SAFETY: plain kill(2) on a pid verified to be running our uc binary.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
}

impl Machine {
    // ---- paths

    /// `~/Code` on this machine.
    pub fn code(&self) -> PathBuf {
        self.home.join("Code")
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.home.join(rel)
    }

    pub fn daemon_log(&self) -> PathBuf {
        self.uc_home.join("logs").join("daemon.log")
    }

    pub fn daemon_pid(&self) -> Option<i32> {
        fs::read_to_string(self.uc_home.join("daemon.pid"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
    }

    /// Daemon reachable on its control socket (never auto-starts one, unlike the CLI).
    pub fn daemon_alive(&self) -> bool {
        UnixStream::connect(self.uc_home.join("daemon.sock")).is_ok()
            || self.daemon_pid().is_some_and(pid_alive)
    }

    // ---- running uc

    fn command(&self, cwd: &Path, args: &[&str]) -> Command {
        let mut c = Command::new(uc_bin());
        c.args(args)
            .current_dir(cwd)
            .env("HOME", &self.home)
            .env("UC_HOME", &self.uc_home)
            .env("CLAUDE_CONFIG_DIR", &self.claude_dir)
            .env("CODEX_HOME", &self.codex_dir)
            .env("UC_LOG", log_filter())
            .env("NO_COLOR", "1")
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_DATA_HOME", self.home.join(".local/share"))
            .env("XDG_STATE_HOME", self.home.join(".local/state"))
            .env_remove("UC_TOKEN")
            .env_remove("UC_SSH");
        c
    }

    fn run(&self, cwd: &Path, args: &[&str], timeout: Duration, trace: bool) -> Output {
        let n = self.shared.cmd_seq.fetch_add(1, Ordering::SeqCst);
        let base = self
            .shared
            .root
            .join("cmd")
            .join(format!("{n:04}-{}", self.name));
        let started = Instant::now();
        let out = run_with_timeout(self.command(cwd, args), &base, timeout);
        if trace {
            eprintln!(
                "[{}] $ uc {}  -> {} in {:.1?}{}",
                self.name,
                args.join(" "),
                out.status,
                started.elapsed(),
                if out.status.success() {
                    String::new()
                } else {
                    format!("\n{}", show(&out))
                }
            );
        }
        out
    }

    /// Run `uc <args>` in `$HOME` (raw result, never panics on a non-zero exit).
    pub fn uc(&self, args: &[&str]) -> Output {
        self.uc_in(&self.home, args)
    }

    pub fn uc_in(&self, cwd: &Path, args: &[&str]) -> Output {
        self.run(cwd, args, CMD_TIMEOUT, true)
    }

    /// Run and require exit 0; returns stdout.
    pub fn uc_ok(&self, args: &[&str]) -> String {
        let out = self.uc(args);
        if !out.status.success() {
            self.fail(&format!(
                "`uc {}` failed on {}:\n{}",
                args.join(" "),
                self.name,
                show(&out)
            ));
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// `uc <args> --json` in `$HOME`; requires exit 0 and one JSON document on stdout.
    pub fn uc_json(&self, args: &[&str]) -> Value {
        self.uc_json_in(&self.home, args)
    }

    pub fn uc_json_in(&self, cwd: &Path, args: &[&str]) -> Value {
        let (out, v) = self.try_json_in(cwd, args);
        if !out.status.success() {
            self.fail(&format!(
                "`uc {} --json` failed on {}:\n{}",
                args.join(" "),
                self.name,
                show(&out)
            ));
        }
        match v {
            Some(v) => v,
            None => self.fail(&format!(
                "`uc {} --json` on {} did not print one JSON document:\n{}",
                args.join(" "),
                self.name,
                show(&out)
            )),
        }
    }

    /// `uc <args> --json` without judging the exit code.
    pub fn try_json(&self, args: &[&str]) -> (Output, Option<Value>) {
        self.try_json_in(&self.home, args)
    }

    pub fn try_json_in(&self, cwd: &Path, args: &[&str]) -> (Output, Option<Value>) {
        let mut a = args.to_vec();
        a.push("--json");
        let out = self.uc_in(cwd, &a);
        let v = parse_json(&out.stdout);
        (out, v)
    }

    // ---- lifecycle

    /// `uc init unix:<hub>/hub.sock --name <name>`, then wait until the daemon is connected.
    pub fn init(&self) {
        let addr = self.shared.hub_addr.clone();
        self.uc_ok(&["init", &addr, "--name", &self.name]);
        self.wait_connected();
    }

    /// Poll `uc status --json` until `connected == true` (the CLI starts the daemon if needed).
    pub fn wait_connected(&self) -> Value {
        let mut last = String::new();
        let mut status = Value::Null;
        let ok = wait_until_every(Duration::from_secs(20), Duration::from_millis(250), || {
            let (out, v) = self.try_json(&["status"]);
            let connected = v
                .as_ref()
                .and_then(|v| v.get("connected"))
                .and_then(Value::as_bool)
                == Some(true);
            last = show(&out);
            if let Some(v) = v {
                status = v;
            }
            connected
        });
        if !ok {
            self.fail(&format!(
                "{}: daemon never reported connected=true within 20s. Last `uc status --json`:\n{last}",
                self.name
            ));
        }
        status
    }

    pub fn status(&self) -> Value {
        self.uc_json(&["status"])
    }

    /// `uc sync --timeout 30 --json`; requires `ok && !timed_out` (SyncReport).
    pub fn sync(&self) -> Value {
        let v = self.uc_json(&["sync", "--timeout", "30"]);
        let ok = v.get("ok").and_then(Value::as_bool) == Some(true);
        let timed_out = v.get("timed_out").and_then(Value::as_bool) == Some(true);
        if !ok || timed_out {
            self.fail(&format!("`uc sync` on {} is not ok:\n{v:#}", self.name));
        }
        v
    }

    /// `uc sync --timeout <secs> --json` that only requires everything local to be pushed
    /// (`pending_up == 0`); remote changes may legitimately stay pending, e.g. for a diverged
    /// transcript left alone while hot (DESIGN §6.4).
    pub fn sync_pushed(&self, secs: u32) -> Value {
        let secs = secs.to_string();
        let (out, v) = self.try_json(&["sync", "--timeout", &secs]);
        let Some(v) = v else {
            self.fail(&format!(
                "`uc sync --json` on {} did not print a SyncReport:\n{}",
                self.name,
                show(&out)
            ));
        };
        if v.get("pending_up").and_then(Value::as_u64) != Some(0) {
            self.fail(&format!(
                "`uc sync` on {}: local changes not pushed:\n{v:#}",
                self.name
            ));
        }
        v
    }

    /// `uc daemon stop`, then wait until the control socket and the process are gone.
    /// Do not run any other `uc` command on this machine until `daemon_start`: the CLI would
    /// start the daemon again.
    pub fn daemon_stop(&self) {
        self.uc_ok(&["daemon", "stop"]);
        if !wait_until(Duration::from_secs(10), || !self.daemon_alive()) {
            self.fail(&format!(
                "{}: daemon still alive 10s after `uc daemon stop`",
                self.name
            ));
        }
    }

    pub fn daemon_start(&self) {
        self.uc_ok(&["daemon", "start"]);
        self.wait_connected();
    }

    /// `uc sessions --json` (Vec<SessionInfo>).
    pub fn sessions(&self) -> Vec<Value> {
        let v = self.uc_json(&["sessions", "--limit", "100"]);
        match v.as_array() {
            Some(a) => a.clone(),
            None => self.fail(&format!(
                "`uc sessions --json` on {} is not an array:\n{v:#}",
                self.name
            )),
        }
    }

    // ---- agents

    /// Native Claude Code transcript path for a session started in `cwd`.
    pub fn claude_transcript(&self, cwd: &Path, id: &str) -> PathBuf {
        self.claude_dir
            .join("projects")
            .join(claude_enc(cwd))
            .join(format!("{id}.jsonl"))
    }

    // ---- diagnostics

    pub fn report(&self) -> String {
        world_report(&self.shared)
    }

    pub fn fail(&self, msg: &str) -> ! {
        panic!("{msg}\n{}", self.report())
    }

    pub fn check(&self, cond: bool, msg: impl FnOnce() -> String) {
        if !cond {
            self.fail(&msg());
        }
    }
}

// ---------------------------------------------------------------- reports

fn world_report(s: &Shared) -> String {
    let mut r = format!(
        "\n════════ e2e diagnostics: {} ({})\n",
        s.test,
        s.root.display()
    );
    let machines = s.machines.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for d in &machines {
        r.push_str(&machine_report(s, d));
    }
    r.push_str(&hub_report(s));
    r
}

fn machine_report(s: &Shared, d: &Dirs) -> String {
    let mut r = format!("──────── machine {} (HOME={})\n", d.name, d.home.display());
    let daemon_up = UnixStream::connect(d.uc_home.join("daemon.sock")).is_ok();
    if daemon_up {
        // Only when the daemon is up: the CLI would otherwise start one and change the scenario.
        let mut c = Command::new(uc_bin());
        c.args(["status", "--json"])
            .current_dir(&d.home)
            .env("HOME", &d.home)
            .env("UC_HOME", &d.uc_home)
            .env("CLAUDE_CONFIG_DIR", d.home.join(".claude"))
            .env("CODEX_HOME", d.home.join(".codex"))
            .env("UC_LOG", "warn")
            .env("NO_COLOR", "1");
        let n = s.cmd_seq.fetch_add(1, Ordering::SeqCst);
        let out = run_with_timeout(
            c,
            &s.root.join("cmd").join(format!("{n:04}-{}-diag", d.name)),
            Duration::from_secs(10),
        );
        r.push_str(&format!(
            "uc status --json -> {}\n{}\n",
            out.status,
            show(&out)
        ));
    } else {
        r.push_str("daemon: not running\n");
    }
    r.push_str(&format!(
        "files (excluding .ultracontext, .git/objects):\n{}",
        listing(&d.home)
    ));
    let trash = d.uc_home.join("trash");
    if trash.exists() {
        r.push_str(&format!("trash:\n{}", listing(&trash)));
    }
    r.push_str(&format!(
        "daemon.log (last {LOG_TAIL_LINES} lines):\n{}\n",
        tail_lines(&d.uc_home.join("logs").join("daemon.log"), LOG_TAIL_LINES)
    ));
    r
}

fn hub_report(s: &Shared) -> String {
    format!(
        "──────── hub (UC_HOME={})\nhub serve stdout/stderr (last {LOG_TAIL_LINES} lines):\n{}\nhub.log (last {LOG_TAIL_LINES} lines):\n{}\n",
        s.hub_home.display(),
        tail_lines(&s.hub_out, LOG_TAIL_LINES),
        tail_lines(&s.hub_home.join("hub").join("hub.log"), LOG_TAIL_LINES),
    )
}

/// Human-readable dump of a command result.
pub fn show(out: &Output) -> String {
    format!(
        "exit: {}\nstdout: {}\nstderr: {}",
        out.status,
        clip(&String::from_utf8_lossy(&out.stdout), 4000),
        clip(&String::from_utf8_lossy(&out.stderr), 4000)
    )
}

pub fn clip(s: &str, max: usize) -> String {
    let s = s.trim_end();
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = s.len() - max;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…[{} bytes clipped]…{}", cut, &s[cut..])
}

pub fn tail_lines(path: &Path, n: usize) -> String {
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return format!("  <{}: {e}>", path.display()),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(256 * 1024);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_to_end(&mut buf).is_err() {
        return format!("  <{}: unreadable>", path.display());
    }
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn read_lossy(path: &Path) -> String {
    fs::read(path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

/// `ls -R`-style listing with sizes, exec bits and symlink targets (skips uc state and git objects).
pub fn listing(root: &Path) -> String {
    let mut out = String::new();
    let mut n = 0usize;
    for (rel, abs, md) in walk(root) {
        if rel.starts_with(".ultracontext/") || rel.contains(".git/objects/") {
            continue;
        }
        n += 1;
        if n > LISTING_MAX {
            out.push_str("  …\n");
            break;
        }
        if md.file_type().is_symlink() {
            let target = fs::read_link(&abs)
                .map(|t| t.display().to_string())
                .unwrap_or_default();
            out.push_str(&format!("  {rel} -> {target}\n"));
        } else {
            let exec = if md.permissions().mode() & 0o111 != 0 {
                " x"
            } else {
                ""
            };
            out.push_str(&format!("  {rel}  {}B{exec}\n", md.len()));
        }
    }
    if n == 0 {
        out.push_str("  <empty>\n");
    }
    out
}

// ---------------------------------------------------------------- filesystem helpers

/// Files and symlinks under `root` (recursive, symlinks not followed), sorted by relative path.
pub fn walk(root: &Path) -> Vec<(String, PathBuf, fs::Metadata)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let abs = e.path();
            let Ok(md) = fs::symlink_metadata(&abs) else {
                continue;
            };
            if md.is_dir() {
                stack.push(abs);
            } else if md.is_file() || md.file_type().is_symlink() {
                let rel = abs
                    .strip_prefix(root)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push((rel, abs, md));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Write a file, creating parent directories.
pub fn put(root: &Path, rel: &str, data: &[u8]) -> PathBuf {
    let p = root.join(rel);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).expect("create parent dirs");
    }
    fs::write(&p, data).unwrap_or_else(|e| panic!("write {}: {e}", p.display()));
    p
}

pub fn read(p: &Path) -> Option<Vec<u8>> {
    fs::read(p).ok()
}

/// Append one complete line with a single write(2), the way agents stream JSONL.
pub fn append_line(p: &Path, line: &str) {
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).expect("create parent dirs");
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .unwrap_or_else(|e| panic!("open {}: {e}", p.display()));
    f.write_all(format!("{line}\n").as_bytes())
        .unwrap_or_else(|e| panic!("append {}: {e}", p.display()));
}

/// Files named exactly `name` anywhere under `root`.
pub fn find_named(root: &Path, name: &str) -> Vec<PathBuf> {
    walk(root)
        .into_iter()
        .filter(|(_, abs, _)| abs.file_name().is_some_and(|n| n == name))
        .map(|(_, abs, _)| abs)
        .collect()
}

/// `true` when `reported` (absolute or `~/...`) names the same directory as `expected`.
pub fn same_path(home: &Path, reported: &str, expected: &Path) -> bool {
    let p = if reported == "~" {
        home.to_path_buf()
    } else if let Some(rest) = reported.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(reported)
    };
    let norm = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    norm(&p) == norm(expected)
}

// ---------------------------------------------------------------- JSON helpers

/// Exactly one JSON document (surrounding whitespace allowed).
pub fn parse_json(stdout: &[u8]) -> Option<Value> {
    serde_json::from_slice(stdout).ok()
}

pub fn jstr<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr).and_then(Value::as_str)
}

/// The SessionInfo whose `meta.id` is `id`.
pub fn find_session<'a>(list: &'a [Value], id: &str) -> Option<&'a Value> {
    list.iter().find(|s| jstr(s, "/meta/id") == Some(id))
}

// ---------------------------------------------------------------- agent transcripts

/// Claude Code's project dir name: the cwd with every non-alphanumeric char replaced by '-'.
pub fn claude_enc(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn js(s: &str) -> String {
    serde_json::to_string(s).expect("serialize string")
}

fn js_opt(s: Option<&str>) -> String {
    s.map(js).unwrap_or_else(|| "null".into())
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// One Claude Code transcript line (user turn), field order as Claude Code writes it.
pub fn claude_user_line(
    session: &str,
    cwd: &Path,
    uuid: &str,
    parent: Option<&str>,
    text: &str,
) -> String {
    format!(
        r#"{{"parentUuid":{},"isSidechain":false,"userType":"external","cwd":{},"sessionId":{},"version":"2.0.27","gitBranch":"main","type":"user","message":{{"role":"user","content":{}}},"uuid":{},"timestamp":{}}}"#,
        js_opt(parent),
        js(&cwd.to_string_lossy()),
        js(session),
        js(text),
        js(uuid),
        js(&now_iso()),
    )
}

/// One Claude Code transcript line (assistant turn).
pub fn claude_assistant_line(
    session: &str,
    cwd: &Path,
    uuid: &str,
    parent: &str,
    text: &str,
) -> String {
    format!(
        r#"{{"parentUuid":{},"isSidechain":false,"userType":"external","cwd":{},"sessionId":{},"version":"2.0.27","gitBranch":"main","message":{{"id":{},"type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[{{"type":"text","text":{}}}],"stop_reason":"end_turn","stop_sequence":null,"usage":{{"input_tokens":1200,"output_tokens":64}}}},"requestId":{},"type":"assistant","uuid":{},"timestamp":{}}}"#,
        js(parent),
        js(&cwd.to_string_lossy()),
        js(session),
        js(&format!("msg_{}", short_id(uuid, "msg"))),
        js(text),
        js(&format!("req_{}", short_id(uuid, "req"))),
        js(uuid),
        js(&now_iso()),
    )
}

fn short_id(seed: &str, salt: &str) -> String {
    blake3::hash(format!("{salt}:{seed}").as_bytes()).to_hex()[..24].to_string()
}

/// Codex rollout path relative to CODEX_HOME for a session created now.
pub fn codex_rollout_rel(id: &str) -> String {
    let now = chrono::Utc::now();
    format!(
        "sessions/{}/rollout-{}-{id}.jsonl",
        now.format("%Y/%m/%d"),
        now.format("%Y-%m-%dT%H-%M-%S")
    )
}

pub fn codex_meta_line(id: &str, cwd: &Path) -> String {
    let ts = now_iso();
    format!(
        r#"{{"timestamp":{ts},"type":"session_meta","payload":{{"id":{},"timestamp":{ts},"cwd":{},"originator":"codex_cli_rs","cli_version":"0.162.1","instructions":null,"git":{{"commit_hash":"4f1c2a9d0e8b7c6a5f4e3d2c1b0a9f8e7d6c5b4a","branch":"main","repository_url":"git@github.com:example/proj.git"}}}}}}"#,
        js(id),
        js(&cwd.to_string_lossy()),
        ts = js(&ts),
    )
}

pub fn codex_turn_context_line(cwd: &Path) -> String {
    let cwd = js(&cwd.to_string_lossy());
    format!(
        r#"{{"timestamp":{},"type":"turn_context","payload":{{"cwd":{cwd},"approval_policy":"on-request","sandbox_policy":{{"mode":"workspace-write","writable_roots":[{cwd}],"network_access":false}},"model":"gpt-5-codex","effort":"medium","summary":"auto"}}}}"#,
        js(&now_iso()),
    )
}

pub fn codex_user_line(text: &str) -> String {
    format!(
        r#"{{"timestamp":{},"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":{}}}]}}}}"#,
        js(&now_iso()),
        js(text),
    )
}

pub fn codex_event_user_line(text: &str) -> String {
    format!(
        r#"{{"timestamp":{},"type":"event_msg","payload":{{"type":"user_message","message":{},"images":[]}}}}"#,
        js(&now_iso()),
        js(text),
    )
}

pub fn codex_assistant_line(text: &str) -> String {
    format!(
        r#"{{"timestamp":{},"type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":{}}}]}}}}"#,
        js(&now_iso()),
        js(text),
    )
}

/// Replace `from` with `to` only at a path boundary (DESIGN §6.2): the next char must not be
/// alphanumeric, '-', '_' or '.'. This is the expected effect of clean + smudge on a transcript.
pub fn translate(text: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(from) {
        let after = &rest[i + from.len()..];
        let boundary = after.chars().next().map_or(true, |c| {
            !(c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
        });
        out.push_str(&rest[..i]);
        out.push_str(if boundary { to } else { from });
        rest = after;
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------- processes and waiting

/// Run with stdout/stderr redirected to files (a detached grandchild that inherits a pipe would
/// otherwise block the reader forever); kill after `timeout`.
pub fn run_with_timeout(mut cmd: Command, base: &Path, timeout: Duration) -> Output {
    let out_path = base.with_extension("out");
    let err_path = base.with_extension("err");
    let (Ok(out_f), Ok(err_f)) = (fs::File::create(&out_path), fs::File::create(&err_path)) else {
        panic!("cannot create command output files at {}", base.display());
    };
    cmd.stdin(Stdio::null()).stdout(out_f).stderr(err_f);
    let mut child = cmd
        .spawn()
        .unwrap_or_else(|e| panic!("spawn {:?}: {e}", cmd.get_program()));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().expect("wait for killed child");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("wait for {:?}: {e}", cmd.get_program()),
        }
    };
    let stdout = fs::read(&out_path).unwrap_or_default();
    let mut stderr = fs::read(&err_path).unwrap_or_default();
    if timed_out {
        stderr.extend_from_slice(format!("\n[e2e] killed after {timeout:?}").as_bytes());
    }
    Output {
        status,
        stdout,
        stderr,
    }
}

pub fn wait_until(timeout: Duration, f: impl FnMut() -> bool) -> bool {
    wait_until_every(timeout, Duration::from_millis(50), f)
}

pub fn wait_until_every(timeout: Duration, every: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(every);
    }
}

pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks for existence/permission.
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Is `pid` running our `uc` binary? Guards the leftover-daemon kill against pid reuse.
fn is_uc_process(pid: i32) -> bool {
    Command::new("ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&*uc_bin().to_string_lossy()))
        .unwrap_or(false)
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.is_empty() && v != "0")
}

fn log_filter() -> String {
    std::env::var("UC_E2E_LOG").unwrap_or_else(|_| "debug".into())
}
