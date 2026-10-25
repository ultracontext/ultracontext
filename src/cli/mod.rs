//! Command line (DESIGN §7). Owner: cli agent.
//!
//! The CLI is a thin client of the daemon (control socket). `--json` makes every command print
//! exactly one JSON document on stdout (errors: `{"error":{code,message,hint,exit_code}}`).
//! Exit codes: 0 ok, 1 error, 2 usage, 3 busy/conflict.

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use crate::client::{apply, control, daemon};
use crate::config::Config;
use crate::paths::{self, Paths};
use crate::proto::{
    Ctl, Entry, LogRecord, Op, Query, SpaceInfo, SpaceStatus, StatusReport, SyncReport,
};
use crate::service;

mod branch;
mod doctor;
mod init;
pub mod output;
mod sessions;
pub mod skill;
pub mod util;

use output::{c, cc, emit_json, note, outln, CliError, Color, Table, EXIT_ERR, EXIT_OK};

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// the daemon scans (and starts uploading) the folder before answering
const ADD_TIMEOUT: Duration = Duration::from_secs(3600);
const RM_TIMEOUT: Duration = Duration::from_secs(120);
const RESTORE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Parser, Debug)]
#[command(name = "uc", version, about = "ultracontext: Dropbox for developers and their agents",
          long_about = None, propagate_version = true,
          after_help = "Agents: add --json to any command for one machine-readable JSON document.\n\
                        Exit codes: 0 ok, 1 error, 2 usage, 3 busy/conflict.")]
pub struct Cli {
    /// Machine-readable JSON output (for agents and scripts)
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Set up this machine and connect it to a hub (ssh host, user@host, tcp://h:p, unix:/p, local)
    Init(InitArgs),
    /// Sync a folder on all your machines (or map an existing hub space here with --name)
    Add(AddArgs),
    /// Stop syncing a space on this machine (files are kept)
    Rm { name: String },
    /// Spaces on the hub and where they live on this machine
    Spaces,
    /// Hub link, pending work, conflicts, live sessions
    Status,
    /// Rescan and wait until everything is pushed and pulled ("safe to close the lid")
    Sync {
        /// Give up after this many seconds
        #[arg(long, default_value_t = 120)]
        timeout: u64,
    },
    /// All Claude Code / Codex sessions from every machine, newest first
    Sessions(SessionsArgs),
    /// Continue a session from any machine, right here
    Resume(ResumeArgs),
    /// Recent changes across machines (who changed what)
    Log(LogArgs),
    /// Versions of a file
    History { path: String },
    /// Restore a file to an older version (pushed as a new change)
    Restore {
        path: String,
        /// Version to restore (see 'uc history'); default: the version before the current one
        #[arg(long)]
        seq: Option<u64>,
    },
    /// Work on a branch in its own synced folder (a git worktree next to the repo), so machines
    /// on different branches never switch each other's checkout
    Branch {
        name: String,
        /// The repository (default: the current directory)
        #[arg(long)]
        from: Option<String>,
    },
    /// Conflict copies waiting for you
    Conflicts,
    /// Diagnose setup problems
    Doctor,
    /// The background sync daemon
    #[command(subcommand)]
    Daemon(DaemonCmd),
    /// Start uc automatically at login (launchd / systemd --user)
    #[command(subcommand)]
    Service(ServiceCmd),
    /// Run or reach the hub (the always-on source of truth)
    #[command(subcommand)]
    Hub(HubCmd),
}

#[derive(Args, Debug)]
pub struct InitArgs {
    /// Hub address: ssh host alias, user@host, ssh://user@host:port, tcp://host:port, unix:/path, local
    pub hub: Option<String>,
    /// Name for this machine (default: hostname)
    #[arg(long)]
    pub name: Option<String>,
    /// Join every hub space at its default path without asking
    #[arg(long, short = 'y')]
    pub yes: bool,
    /// Path of `uc` on the hub host (ssh)
    #[arg(long)]
    pub remote_uc: Option<String>,
    /// Do not sync agent sessions (and do not install the agent skill)
    #[arg(long)]
    pub no_agents: bool,
}

#[derive(Args, Debug)]
pub struct AddArgs {
    /// Folder to sync (created if missing)
    pub dir: String,
    /// Space name (default: folder name). Use an existing hub space name to map it here.
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Args, Debug)]
pub struct SessionsArgs {
    /// Filter: text in id, title, first prompt or directory
    pub query: Option<String>,
    /// Only this agent (claude, codex)
    #[arg(long)]
    pub agent: Option<String>,
    /// Only sessions last written by this machine (id or name)
    #[arg(long)]
    pub machine: Option<String>,
    /// Only sessions of the current directory's project
    #[arg(long)]
    pub here: bool,
    #[arg(long, default_value_t = 20)]
    pub limit: u32,
}

#[derive(Args, Debug)]
pub struct ResumeArgs {
    /// Session id, id prefix, or search text (default: latest session of this project)
    pub target: Option<String>,
    /// Only this agent (claude, codex)
    #[arg(long)]
    pub agent: Option<String>,
    /// Take over a session that is live on another machine
    #[arg(long, conflicts_with = "fork")]
    pub takeover: bool,
    /// Continue as a new forked session (the original stays untouched)
    #[arg(long)]
    pub fork: bool,
    /// Print the command instead of running it
    #[arg(long)]
    pub print: bool,
}

#[derive(Args, Debug)]
pub struct LogArgs {
    /// File or folder (default: everything)
    pub path: Option<String>,
    /// Only changes newer than this: 30m, 2h, 1d, 1w
    #[arg(long, value_parser = util::since_arg)]
    pub since: Option<String>,
    #[arg(long, default_value_t = 50)]
    pub limit: u32,
}

#[derive(Subcommand, Debug)]
pub enum DaemonCmd {
    /// Run in the foreground
    Run,
    /// Start in the background (no-op if running)
    Start,
    /// Stop the background daemon
    Stop,
    /// Is the daemon running?
    Status,
}

#[derive(Subcommand, Debug)]
pub enum ServiceCmd {
    /// Install and start the autostart service
    Install {
        /// Install the hub service instead of the daemon (on the hub box)
        #[arg(long)]
        hub: bool,
    },
    /// Stop and remove the autostart service
    Uninstall {
        #[arg(long)]
        hub: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum HubCmd {
    /// Run the hub in the foreground
    Serve {
        /// Also listen on TCP (token from UC_TOKEN), e.g. 0.0.0.0:7707
        #[arg(long)]
        tcp: Option<String>,
        /// Start in the background and return
        #[arg(long)]
        detach: bool,
    },
    /// Bridge stdio to the local hub (used over ssh)
    Connect,
}

pub fn main() -> Result<i32> {
    let argv: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let cli = match Cli::try_parse_from(&argv) {
        Ok(c) => c,
        Err(e) => {
            let json = argv.iter().any(|a| a == "--json");
            return Ok(clap_error(e, json));
        }
    };
    let json = cli.json;
    match run(cli) {
        Ok(code) => Ok(code),
        Err(e) => {
            let ce = CliError::from_anyhow(&e);
            output::print_error(&ce, json);
            Ok(ce.exit)
        }
    }
}

fn clap_error(e: clap::Error, json: bool) -> i32 {
    let code = e.exit_code();
    if json && code != EXIT_OK {
        let rendered = e.render().to_string();
        let first = rendered.lines().next().unwrap_or("usage error");
        let msg = first.trim_start_matches("error: ").to_string();
        output::print_error(&CliError::usage(msg).hint("uc --help"), true);
    } else {
        let _ = e.print();
    }
    code
}

fn run(cli: Cli) -> Result<i32> {
    let json = cli.json;
    match cli.cmd {
        // long-running: their own multi-threaded runtime, logs to stderr, no stdout output
        Cmd::Daemon(DaemonCmd::Run) => {
            multi_thread_runtime()?.block_on(daemon::run(Paths::from_env()))?;
            Ok(EXIT_OK)
        }
        Cmd::Hub(HubCmd::Serve { tcp, detach }) => hub_serve(tcp, detach, json),
        Cmd::Hub(HubCmd::Connect) => {
            // stdout is the protocol stream: nothing else may be written to it
            daemon::init_tracing("warn");
            multi_thread_runtime()?.block_on(crate::transport::bridge_stdio(&paths::uc_home()))?;
            Ok(EXIT_OK)
        }
        cmd => {
            let app = App::new(json)?;
            match cmd {
                Cmd::Init(a) => init::cmd_init(&app, a),
                Cmd::Add(a) => cmd_add(&app, a),
                Cmd::Rm { name } => cmd_rm(&app, &name),
                Cmd::Spaces => cmd_spaces(&app),
                Cmd::Status => cmd_status(&app),
                Cmd::Sync { timeout } => cmd_sync(&app, timeout),
                Cmd::Sessions(a) => sessions::cmd_sessions(&app, a),
                Cmd::Resume(a) => sessions::cmd_resume(&app, a),
                Cmd::Log(a) => cmd_log(&app, a),
                Cmd::History { path } => cmd_history(&app, &path),
                Cmd::Restore { path, seq } => cmd_restore(&app, &path, seq),
                Cmd::Conflicts => cmd_conflicts(&app),
                Cmd::Branch { name, from } => branch::cmd_branch(&app, &name, from.as_deref()),
                Cmd::Doctor => doctor::cmd_doctor(&app),
                Cmd::Daemon(d) => cmd_daemon(&app, d),
                Cmd::Service(s) => cmd_service(&app, s),
                Cmd::Hub(_) => unreachable!("handled above"),
            }
        }
    }
}

fn multi_thread_runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting the async runtime")
}

/// Per-invocation CLI context.
pub(crate) struct App {
    pub json: bool,
    pub paths: Paths,
    pub rt: tokio::runtime::Runtime,
}

impl App {
    fn new(json: bool) -> Result<App> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("starting the async runtime")?;
        Ok(App {
            json,
            paths: Paths::from_env(),
            rt,
        })
    }

    /// The initialized config, or a "run uc init" error.
    pub fn config(&self) -> Result<Config> {
        match Config::load(&self.paths.config())? {
            Some(c) if c.is_initialized() => Ok(c),
            _ => Err(CliError::new("not_initialized", "uc is not set up on this machine")
                .hint("run 'uc init <hub>' (e.g. 'uc init myserver', or 'uc init local' on the hub box)")
                .into()),
        }
    }

    /// Initialized config + a running daemon (started if needed).
    pub fn connect(&self) -> Result<Config> {
        let cfg = self.config()?;
        daemon::ensure_running(&self.paths).map_err(|e| {
            CliError::new("unreachable", format!("{e:#}")).hint(format!(
                "see {} or run 'uc doctor'",
                paths::tilde(&self.paths.daemon_log())
            ))
        })?;
        Ok(cfg)
    }

    pub fn call(&self, cmd: Ctl, timeout: Duration) -> Result<Value> {
        self.rt.block_on(control::call_timeout(
            &self.paths.daemon_sock(),
            cmd,
            timeout,
        ))
    }

    pub fn ctl<T: DeserializeOwned>(&self, cmd: Ctl, timeout: Duration) -> Result<T> {
        let v = self.call(cmd, timeout)?;
        serde_json::from_value(v).context(
            "unexpected answer from the uc daemon (different version? restart it: uc daemon stop)",
        )
    }

    pub fn query<T: DeserializeOwned>(&self, q: Query) -> Result<T> {
        self.ctl(Ctl::Query { query: q }, QUERY_TIMEOUT)
    }

    pub fn status(&self) -> Result<StatusReport> {
        self.ctl(Ctl::Status, STATUS_TIMEOUT)
    }
}

fn cwd() -> Result<std::path::PathBuf> {
    std::env::current_dir().context("the current directory is not accessible")
}

// ---------------------------------------------------------------- spaces

fn cmd_add(app: &App, a: AddArgs) -> Result<i32> {
    let cfg = app.config()?;
    let abs = util::canonicalize_lenient(&util::absolutize(&a.dir, &cwd()?));
    let explicit_name = a.name.is_some();
    let name = match a.name {
        Some(n) => n,
        None => util::default_space_name(&abs),
    };
    let agent_roots: Vec<_> = skill::agent_roots().into_iter().map(|(_, p)| p).collect();
    let protected = daemon::protected_roots(&app.paths, &agent_roots);
    let already = match daemon::check_add_space(&cfg, &name, &abs, &protected) {
        Ok(check) => check == daemon::AddCheck::AlreadySynced,
        Err(e) => return Err(CliError::from_ctl(&e).into()),
    };
    if abs.exists() && !abs.is_dir() {
        return Err(CliError::usage(format!("{} is not a folder", paths::tilde(&abs))).into());
    }
    app.connect()?;
    if !explicit_name && !already {
        // an implicit name that happens to match another folder's space would merge the two
        if let Ok(hub_spaces) = app.query::<Vec<SpaceInfo>>(Query::Spaces) {
            if let Some(other) = name_collision(&hub_spaces, &name, &paths::tilde(&abs)) {
                return Err(CliError::new(
                    "exists",
                    format!(
                        "the hub already has a space '{name}' for {}; not merging {} into it implicitly",
                        other.default_path,
                        paths::tilde(&abs)
                    ),
                )
                .hint(format!(
                    "to sync this folder into it: uc add {0} --name {name}; for a separate space: uc add {0} --name <other-name>",
                    paths::tilde(&abs)
                ))
                .into());
            }
        }
    }
    std::fs::create_dir_all(&abs).with_context(|| format!("creating {}", abs.display()))?;
    let abs = abs.canonicalize().unwrap_or(abs);
    if !app.json && !already {
        note(&format!("scanning {} …", paths::tilde(&abs)));
    }
    let st: SpaceStatus = app.ctl(
        Ctl::AddSpace {
            name: name.clone(),
            path: abs.to_string_lossy().to_string(),
        },
        ADD_TIMEOUT,
    )?;
    if app.json {
        emit_json(&st);
        return Ok(EXIT_OK);
    }
    let verb = if already {
        "already syncing"
    } else {
        "syncing"
    };
    outln!(
        "{} {verb} {} as space '{}' ({} files)",
        output::ok_mark(),
        paths::tilde(&abs),
        name,
        output::thousands(st.files)
    );
    if !already {
        outln!(
            "  on your other machines: uc add {} --name {name}",
            paths::tilde(&abs)
        );
    }
    Ok(EXIT_OK)
}

/// A hub space with this name that belongs to a different default folder.
pub(crate) fn name_collision<'a>(
    spaces: &'a [SpaceInfo],
    name: &str,
    here: &str,
) -> Option<&'a SpaceInfo> {
    spaces.iter().find(|s| {
        s.name == name && s.default_path.trim_end_matches('/') != here.trim_end_matches('/')
    })
}

fn cmd_rm(app: &App, name: &str) -> Result<i32> {
    let cfg = app.config()?;
    let Some(sc) = cfg.space(name).cloned() else {
        let names: Vec<&str> = cfg.spaces.iter().map(|s| s.name.as_str()).collect();
        let hint = if names.is_empty() {
            "no spaces are synced on this machine".to_string()
        } else {
            format!("synced here: {}", names.join(", "))
        };
        return Err(CliError::new(
            "not_found",
            format!("no space named '{name}' is synced here"),
        )
        .hint(hint)
        .into());
    };
    app.connect()?;
    app.call(
        Ctl::RmSpace {
            name: name.to_string(),
        },
        RM_TIMEOUT,
    )?;
    if app.json {
        emit_json(&json!({"removed": name, "path": sc.path}));
    } else {
        outln!(
            "{} stopped syncing '{name}' on this machine; files stay in {}",
            output::ok_mark(),
            sc.path
        );
    }
    Ok(EXIT_OK)
}

#[derive(Debug, Serialize)]
struct SpaceRow {
    name: String,
    /// home-relative path recorded by the machine that created the space
    default_path: Option<String>,
    /// where it lives on this machine (None = not synced here)
    local_path: Option<String>,
    synced_here: bool,
    files: Option<u64>,
    bytes: Option<u64>,
    pending_up: u64,
    pending_down: u64,
}

fn cmd_spaces(app: &App) -> Result<i32> {
    let cfg = app.connect()?;
    let status = app.status()?;
    let hub: Option<Vec<SpaceInfo>> = match app.query::<Vec<SpaceInfo>>(Query::Spaces) {
        Ok(s) => Some(s),
        Err(e) => {
            if !app.json {
                note(&format!(
                    "{} hub unreachable, showing this machine only: {}",
                    output::warn_mark(),
                    CliError::from_anyhow(&e).msg
                ));
            }
            None
        }
    };
    let mut rows: BTreeMap<String, SpaceRow> = BTreeMap::new();
    // '@claude' / '@codex' hold agent sessions (see `uc sessions`), not folders
    for s in hub.iter().flatten().filter(|s| !s.name.starts_with('@')) {
        rows.insert(
            s.name.clone(),
            SpaceRow {
                name: s.name.clone(),
                default_path: Some(s.default_path.clone()),
                local_path: None,
                synced_here: false,
                files: Some(s.files),
                bytes: Some(s.bytes),
                pending_up: 0,
                pending_down: 0,
            },
        );
    }
    for s in &cfg.spaces {
        let row = rows.entry(s.name.clone()).or_insert_with(|| SpaceRow {
            name: s.name.clone(),
            default_path: None,
            local_path: None,
            synced_here: true,
            files: None,
            bytes: None,
            pending_up: 0,
            pending_down: 0,
        });
        row.local_path = Some(s.local_path().to_string_lossy().to_string());
        row.synced_here = true;
        if let Some(st) = status.spaces.iter().find(|x| x.name == s.name) {
            row.pending_up = st.pending_up;
            row.pending_down = st.pending_down;
            row.files = row.files.or(Some(st.files));
        }
    }
    let rows: Vec<SpaceRow> = rows.into_values().collect();
    if app.json {
        emit_json(&rows);
        return Ok(EXIT_OK);
    }
    if rows.is_empty() {
        outln!("no spaces yet; sync a folder with: uc add ~/Code");
        return Ok(EXIT_OK);
    }
    let mut t = Table::new(&["NAME", "HERE", "FILES", "SIZE", "PENDING"]);
    for r in &rows {
        let here = match &r.local_path {
            Some(p) => c(paths::tilde(Path::new(p))),
            None => cc(
                format!(
                    "not synced (uc add {} --name {})",
                    r.default_path.as_deref().unwrap_or("<dir>"),
                    r.name
                ),
                Color::Dim,
            ),
        };
        let pending = if r.pending_up + r.pending_down == 0 {
            c("")
        } else {
            cc(
                format!("↑{} ↓{}", r.pending_up, r.pending_down),
                Color::Yellow,
            )
        };
        t.row(vec![
            cc(r.name.clone(), Color::Bold),
            here,
            c(r.files.map(output::thousands).unwrap_or_default()),
            c(r.bytes.map(output::human_bytes).unwrap_or_default()),
            pending,
        ]);
    }
    t.print();
    Ok(EXIT_OK)
}

// ---------------------------------------------------------------- status / sync

fn cmd_status(app: &App) -> Result<i32> {
    app.connect()?;
    let st = app.status()?;
    if app.json {
        emit_json(&st);
    } else {
        print_status(&st, paths::now_ms());
    }
    Ok(EXIT_OK)
}

fn print_status(st: &StatusReport, now: i64) {
    let label = |s: &str| output::paint(Color::Dim, &format!("{s:<11}"));
    if st.connected {
        outln!(
            "{} connected to {}  {}",
            output::paint(Color::Green, "●"),
            output::paint(Color::Bold, &st.hub),
            output::paint(
                Color::Dim,
                &format!(
                    "hub {} · seq {}",
                    st.hub_version.as_deref().unwrap_or("?"),
                    st.head_seq
                )
            )
        );
    } else {
        outln!(
            "{} offline: hub {} unreachable{}",
            output::paint(Color::Red, "●"),
            output::paint(Color::Bold, &st.hub),
            st.last_error
                .as_deref()
                .map(|e| format!(" ({e})"))
                .unwrap_or_default()
        );
    }
    if let Some(m) = &st.machine {
        outln!(
            "{}{} ({}) · daemon {} · pid {} · up {}",
            label("machine"),
            m.name,
            m.id,
            st.daemon_version,
            st.daemon_pid,
            output::short_duration(st.uptime_s as i64)
        );
    }
    if st.spaces.is_empty() {
        outln!("{}none yet: uc add ~/Code", label("spaces"));
    }
    let name_w = st
        .spaces
        .iter()
        .map(|s| s.name.chars().count())
        .max()
        .unwrap_or(0);
    let path_w = st
        .spaces
        .iter()
        .map(|s| paths::tilde(Path::new(&s.path)).chars().count())
        .max()
        .unwrap_or(0);
    for (i, s) in st.spaces.iter().enumerate() {
        let mut line = format!(
            "{}{:<name_w$}  {:<path_w$}  {:>9} files",
            label(if i == 0 { "spaces" } else { "" }),
            s.name,
            paths::tilde(Path::new(&s.path)),
            output::thousands(s.files),
        );
        if s.pending_up + s.pending_down > 0 {
            line.push_str(&format!(
                "  {}",
                output::paint(
                    Color::Yellow,
                    &format!("↑{} ↓{}", s.pending_up, s.pending_down)
                )
            ));
        }
        if !s.case_collisions.is_empty() {
            line.push_str(&format!(
                "  {}",
                output::paint(
                    Color::Yellow,
                    &format!("{} case collisions not applied", s.case_collisions.len())
                )
            ));
        }
        outln!("{line}");
    }
    let pending = if st.pending_up + st.pending_down == 0 {
        output::paint(Color::Green, "nothing to push or pull")
    } else {
        output::paint(
            Color::Yellow,
            &format!(
                "↑ {} to push · ↓ {} to pull",
                st.pending_up, st.pending_down
            ),
        )
    };
    outln!("{}{pending}", label("pending"));
    if !st.conflicts.is_empty() {
        outln!(
            "{}{}  → uc conflicts",
            label("conflicts"),
            output::paint(Color::Yellow, &st.conflicts.len().to_string())
        );
    }
    for (i, s) in st.sessions_live.iter().enumerate() {
        let dir = s
            .local_cwd
            .as_deref()
            .map(|d| paths::tilde(Path::new(d)))
            .unwrap_or_default();
        let title = s
            .meta
            .title
            .as_deref()
            .or(s.meta.first_prompt.as_deref())
            .unwrap_or("");
        outln!(
            "{}{} {} {}  {}  {}  {}  {}",
            label(if i == 0 { "live" } else { "" }),
            output::paint(Color::Green, "●"),
            s.meta.agent,
            output::paint(Color::Cyan, output::short_id(&s.meta.id)),
            s.owner_name.as_deref().unwrap_or("?"),
            output::rel_time(now, now - s.idle_ms),
            dir,
            output::truncate(title, 50)
        );
    }
    if st.connected {
        if let Some(e) = &st.last_error {
            outln!("{}{}", label("last error"), output::paint(Color::Yellow, e));
        }
    } else {
        outln!("{}", output::paint(Color::Dim, "hint: run 'uc doctor'"));
    }
}

fn cmd_sync(app: &App, timeout_s: u64) -> Result<i32> {
    app.connect()?;
    if !app.json {
        note("syncing …");
    }
    let rep: SyncReport = app.ctl(
        Ctl::Sync {
            timeout_ms: timeout_s.saturating_mul(1000),
        },
        Duration::from_secs(timeout_s.saturating_add(60)),
    )?;
    let code = if rep.ok { EXIT_OK } else { EXIT_ERR };
    if app.json {
        emit_json(&rep);
        return Ok(code);
    }
    if rep.ok {
        outln!(
            "{} in sync (seq {}): safe to close the lid",
            output::ok_mark(),
            rep.cursor
        );
    } else {
        outln!(
            "{} not in sync after {timeout_s}s: ↑ {} to push · ↓ {} to pull (seq {}/{})",
            output::fail_mark(),
            rep.pending_up,
            rep.pending_down,
            rep.cursor,
            rep.head_seq
        );
        note("hint: 'uc status' shows what is pending; 'uc doctor' checks the hub link");
    }
    if !rep.conflicts.is_empty() {
        outln!(
            "{} {} conflict copies: uc conflicts",
            output::warn_mark(),
            rep.conflicts.len()
        );
    }
    Ok(code)
}

// ---------------------------------------------------------------- log / history / restore

/// "~/Code/x.txt" when the space is synced here, else "space:path".
fn display_path(cfg: &Config, space: &str, path: &str) -> String {
    match cfg.space(space) {
        Some(s) => format!(
            "{}/{path}",
            paths::tilde(&s.local_path()).trim_end_matches('/')
        ),
        None if space.starts_with('@') => format!("{space}/{path}"),
        None => format!("{space}:{path}"),
    }
}

fn op_cell(op: Op) -> (String, Color) {
    let (s, color) = match op {
        Op::Put => ("put", Color::Green),
        Op::Delete => ("delete", Color::Red),
        Op::Append => ("append", Color::Cyan),
        Op::Reset => ("reset", Color::Yellow),
        Op::Claim => ("claim", Color::Dim),
    };
    cc(s, color)
}

fn machine_of(r: &LogRecord) -> String {
    if r.origin_name.is_empty() {
        r.origin.clone()
    } else {
        r.origin_name.clone()
    }
}

fn cmd_log(app: &App, a: LogArgs) -> Result<i32> {
    let cfg = app.connect()?;
    let (space, path) = match &a.path {
        None => (None, None),
        Some(p) => {
            let l = util::locate(&cfg.spaces, p, &cwd()?)?;
            let path = l.rel.map(|rel| {
                if l.abs.is_dir() || p.ends_with('/') {
                    format!("{rel}/")
                } else {
                    rel
                }
            });
            (Some(l.space), path)
        }
    };
    let since_ms = match &a.since {
        Some(s) => {
            let d = util::parse_since(s).map_err(CliError::usage)?;
            Some(paths::now_ms() - d.as_millis() as i64)
        }
        None => None,
    };
    let recs: Vec<LogRecord> = app.query(Query::Log {
        space,
        path,
        since_ms,
        limit: Some(a.limit),
    })?;
    if app.json {
        emit_json(&recs);
        return Ok(EXIT_OK);
    }
    if recs.is_empty() {
        outln!(
            "no changes{}",
            a.since
                .as_ref()
                .map(|s| format!(" in the last {s}"))
                .unwrap_or_default()
        );
        return Ok(EXIT_OK);
    }
    let now = paths::now_ms();
    let mut t = Table::new(&["WHEN", "MACHINE", "OP", "SIZE", "PATH"]);
    for r in &recs {
        t.row(vec![
            c(output::rel_time(now, r.at)),
            c(machine_of(r)),
            op_cell(r.op),
            c(if r.op == Op::Delete {
                String::new()
            } else {
                output::human_bytes(r.size)
            }),
            c(display_path(&cfg, &r.space, &r.path)),
        ]);
    }
    t.print();
    Ok(EXIT_OK)
}

fn locate_file(cfg: &Config, input: &str, what: &str) -> Result<(String, String)> {
    let l = util::locate(&cfg.spaces, input, &cwd()?)?;
    match l.rel {
        Some(rel) => Ok((l.space, rel)),
        None => Err(CliError::usage(format!(
            "{what} needs a file, not the root of space '{}'",
            l.space
        ))
        .hint(format!("for a whole folder use: uc log {input}"))
        .into()),
    }
}

fn cmd_history(app: &App, input: &str) -> Result<i32> {
    let cfg = app.connect()?;
    let (space, path) = locate_file(&cfg, input, "history")?;
    let recs: Vec<LogRecord> = app.query(Query::History {
        space: space.clone(),
        path: path.clone(),
        limit: None,
    })?;
    if app.json {
        emit_json(&recs);
        return Ok(EXIT_OK);
    }
    if recs.is_empty() {
        return Err(
            CliError::new("not_found", format!("no history for {input}"))
                .hint("is it ignored (.gitignore/.ucignore) or not synced yet? see 'uc status'")
                .into(),
        );
    }
    let now = paths::now_ms();
    let mut t = Table::new(&["SEQ", "WHEN", "MACHINE", "OP", "SIZE", "HASH"]);
    for (i, r) in recs.iter().enumerate() {
        let seq = if i == 0 {
            cc(format!("{} (current)", r.seq), Color::Bold)
        } else {
            c(r.seq.to_string())
        };
        t.row(vec![
            seq,
            c(output::rel_time(now, r.at)),
            c(machine_of(r)),
            op_cell(r.op),
            c(if r.op == Op::Delete {
                String::new()
            } else {
                output::human_bytes(r.size)
            }),
            cc(r.hash.get(..10).unwrap_or(&r.hash), Color::Dim),
        ]);
    }
    t.print();
    outln!(
        "{}",
        output::paint(
            Color::Dim,
            &format!("restore one: uc restore {input} --seq <SEQ>")
        )
    );
    Ok(EXIT_OK)
}

/// Default restore target: the newest version with content before the current one
/// (or, if the file is currently deleted, its last content).
pub(crate) fn pick_restore_target(recs: &[LogRecord]) -> Option<&LogRecord> {
    let current = recs.first()?;
    let skip = usize::from(current.op != Op::Delete);
    recs.iter().skip(skip).find(|r| r.op == Op::Put)
}

fn cmd_restore(app: &App, input: &str, seq: Option<u64>) -> Result<i32> {
    let cfg = app.connect()?;
    let (space, path) = locate_file(&cfg, input, "restore")?;
    let recs: Vec<LogRecord> = app.query(Query::History {
        space: space.clone(),
        path: path.clone(),
        limit: None,
    })?;
    let target = match seq {
        Some(s) => recs.iter().find(|r| r.seq == s).ok_or_else(|| {
            CliError::new("not_found", format!("{input} has no version {s}"))
                .hint(format!("list versions: uc history {input}"))
        })?,
        None => pick_restore_target(&recs).ok_or_else(|| {
            CliError::new(
                "not_found",
                format!("{input} has no earlier version to restore"),
            )
            .hint(format!("list versions: uc history {input}"))
        })?,
    };
    if target.op != Op::Put {
        return Err(CliError::usage(format!(
            "version {} of {input} is a {:?}, not content",
            target.seq, target.op
        ))
        .hint(format!("pick a 'put' version from: uc history {input}"))
        .into());
    }
    app.call(
        Ctl::Restore {
            space: space.clone(),
            path: path.clone(),
            seq: target.seq,
        },
        RESTORE_TIMEOUT,
    )?;
    if app.json {
        emit_json(
            &json!({"space": space, "path": path, "seq": target.seq, "restored_from": target}),
        );
    } else {
        outln!(
            "{} restored {input} to version {} ({} by {}); syncing to your machines",
            output::ok_mark(),
            target.seq,
            output::rel_time(paths::now_ms(), target.at),
            machine_of(target)
        );
    }
    Ok(EXIT_OK)
}

// ---------------------------------------------------------------- conflicts

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct ConflictRow {
    space: String,
    path: String,
    /// absolute path on this machine
    local_path: Option<String>,
    /// the file this is a conflict copy of
    original: String,
}

/// `notes.md.conflict-box-20261025-141502` -> `notes.md`
pub(crate) fn original_of(path: &str) -> String {
    apply::conflict_original(path).unwrap_or(path).to_string()
}

fn cmd_conflicts(app: &App) -> Result<i32> {
    let cfg = app.connect()?;
    let st = app.status()?;
    let mut rows: BTreeMap<(String, String), ConflictRow> = BTreeMap::new();
    // the hub knows conflict copies made on every machine
    if st.connected {
        for s in &cfg.spaces {
            let entries: Vec<Entry> = match app.query(Query::Entries {
                space: s.name.clone(),
                prefix: None,
            }) {
                Ok(e) => e,
                Err(e) => {
                    if !app.json {
                        note(&format!(
                            "{} {}: {}",
                            output::warn_mark(),
                            s.name,
                            CliError::from_anyhow(&e).msg
                        ));
                    }
                    continue;
                }
            };
            for e in entries
                .into_iter()
                .filter(|e| !e.deleted && apply::is_conflict_name(&e.path))
            {
                let local = paths::join_canonical(&s.local_path(), &e.path);
                rows.insert(
                    (s.name.clone(), e.path.clone()),
                    ConflictRow {
                        original: original_of(&e.path),
                        local_path: Some(local.to_string_lossy().to_string()),
                        space: s.name.clone(),
                        path: e.path,
                    },
                );
            }
        }
    }
    let known: Vec<String> = rows
        .values()
        .flat_map(|r| {
            [
                r.local_path.clone().unwrap_or_default(),
                format!("{}/{}", r.space, r.path),
            ]
        })
        .collect();
    for cpath in &st.conflicts {
        if known
            .iter()
            .any(|k| k == cpath || k.ends_with(&format!("/{cpath}")))
        {
            continue;
        }
        rows.insert(
            (String::new(), cpath.clone()),
            ConflictRow {
                space: String::new(),
                path: cpath.clone(),
                local_path: None,
                original: original_of(cpath),
            },
        );
    }
    let rows: Vec<ConflictRow> = rows.into_values().collect();
    if app.json {
        emit_json(&rows);
        return Ok(EXIT_OK);
    }
    if rows.is_empty() {
        outln!("{} no conflicts", output::ok_mark());
        return Ok(EXIT_OK);
    }
    for r in &rows {
        let shown = r
            .local_path
            .as_deref()
            .map(|p| paths::tilde(Path::new(p)))
            .unwrap_or_else(|| r.path.clone());
        outln!("{} {shown}", output::warn_mark());
        outln!("  {} {}", output::paint(Color::Dim, "copy of"), r.original);
    }
    outln!(
        "{}",
        output::paint(
            Color::Dim,
            "resolve: read both, merge into the original, then delete the conflict copy"
        )
    );
    Ok(EXIT_OK)
}

// ---------------------------------------------------------------- daemon / service / hub

#[derive(Debug, Serialize)]
struct DaemonState {
    running: bool,
    pid: Option<u32>,
    version: Option<String>,
    uptime_s: Option<u64>,
    connected: Option<bool>,
    log: String,
}

fn daemon_state(app: &App) -> DaemonState {
    let running = control::probe(&app.paths.daemon_sock(), Duration::from_secs(2));
    let st = if running { app.status().ok() } else { None };
    DaemonState {
        running,
        pid: st
            .as_ref()
            .map(|s| s.daemon_pid)
            .or_else(|| daemon::running_pid(&app.paths)),
        version: st.as_ref().map(|s| s.daemon_version.clone()),
        uptime_s: st.as_ref().map(|s| s.uptime_s),
        connected: st.as_ref().map(|s| s.connected),
        log: app.paths.daemon_log().to_string_lossy().to_string(),
    }
}

fn print_daemon_state(s: &DaemonState) {
    if s.running {
        outln!(
            "{} daemon running (pid {}, {}, up {}){}",
            output::ok_mark(),
            s.pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into()),
            s.version.as_deref().unwrap_or("?"),
            output::short_duration(s.uptime_s.unwrap_or(0) as i64),
            match s.connected {
                Some(false) => " · hub offline",
                _ => "",
            }
        );
    } else {
        outln!(
            "{} daemon not running (log: {})",
            output::fail_mark(),
            paths::tilde(Path::new(&s.log))
        );
    }
}

fn cmd_daemon(app: &App, d: DaemonCmd) -> Result<i32> {
    match d {
        DaemonCmd::Run => unreachable!("handled in run()"),
        DaemonCmd::Start => {
            app.connect()?;
            let s = daemon_state(app);
            if app.json {
                emit_json(&s);
            } else {
                print_daemon_state(&s);
            }
            Ok(EXIT_OK)
        }
        DaemonCmd::Stop => {
            let stopped = app.rt.block_on(daemon::stop(&app.paths))?;
            if app.json {
                emit_json(&json!({"stopped": stopped, "was_running": stopped}));
            } else if stopped {
                outln!("{} daemon stopped", output::ok_mark());
            } else {
                outln!("daemon was not running");
            }
            Ok(EXIT_OK)
        }
        DaemonCmd::Status => {
            let s = daemon_state(app);
            if app.json {
                emit_json(&s);
            } else {
                print_daemon_state(&s);
            }
            Ok(if s.running { EXIT_OK } else { EXIT_ERR })
        }
    }
}

fn cmd_service(app: &App, s: ServiceCmd) -> Result<i32> {
    match s {
        ServiceCmd::Install { hub } => {
            let role = if hub {
                service::Role::Hub
            } else {
                service::Role::Daemon
            };
            if role == service::Role::Daemon {
                app.config()?;
                // the service manager's daemon must be the only one
                app.rt.block_on(daemon::stop(&app.paths))?;
            }
            let rep = service::install(role)?;
            if app.json {
                emit_json(&rep);
            } else {
                let mark = if rep.loaded {
                    output::ok_mark()
                } else {
                    output::warn_mark()
                };
                outln!(
                    "{mark} installed {} ({})",
                    paths::tilde(&rep.path),
                    if rep.loaded { "started" } else { "not started" }
                );
                for n in &rep.notes {
                    outln!("  {n}");
                }
            }
            Ok(if rep.loaded { EXIT_OK } else { EXIT_ERR })
        }
        ServiceCmd::Uninstall { hub } => {
            let role = if hub {
                service::Role::Hub
            } else {
                service::Role::Daemon
            };
            let removed = service::uninstall(role)?;
            if app.json {
                emit_json(&json!({"role": role, "removed": removed}));
            } else {
                match removed {
                    Some(p) => outln!("{} removed {}", output::ok_mark(), paths::tilde(&p)),
                    None => outln!("no {role:?} service was installed"),
                }
            }
            Ok(EXIT_OK)
        }
    }
}

fn hub_serve(tcp: Option<String>, detach: bool, json: bool) -> Result<i32> {
    let uc_home = paths::uc_home();
    let token = std::env::var("UC_TOKEN")
        .ok()
        .filter(|t| !t.trim().is_empty());
    if tcp.is_some() && token.is_none() {
        return Err(CliError::usage("--tcp requires a token: set UC_TOKEN")
            .hint("e.g. UC_TOKEN=$(openssl rand -hex 16) uc hub serve --tcp 0.0.0.0:7707")
            .into());
    }
    if detach {
        if tcp.is_some() {
            return Err(CliError::usage("--tcp cannot be combined with --detach")
                .hint("run it in the foreground, or under 'uc service install --hub'")
                .into());
        }
        crate::hub::spawn_detached(&uc_home)?;
        let p = Paths::new(uc_home);
        if json {
            emit_json(&json!({"running": true, "socket": p.hub_sock(), "log": p.hub_log()}));
        } else {
            outln!(
                "{} hub running (socket {}, log {})",
                output::ok_mark(),
                paths::tilde(&p.hub_sock()),
                paths::tilde(&p.hub_log())
            );
        }
        return Ok(EXIT_OK);
    }
    daemon::init_tracing("info");
    multi_thread_runtime()?.block_on(crate::hub::serve(crate::hub::HubOpts {
        uc_home,
        tcp,
        token,
        lease_idle_ms: crate::hub::DEFAULT_LEASE_IDLE_MS,
    }))?;
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("uc").chain(args.iter().copied()))
    }

    #[test]
    fn clap_tree_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn parses_every_command() {
        let ok: &[&[&str]] = &[
            &["init"],
            &[
                "init",
                "myhub",
                "--name",
                "mac",
                "--yes",
                "--remote-uc",
                "/opt/uc",
                "--no-agents",
            ],
            &["init", "local", "-y"],
            &["add", "~/Code"],
            &["add", ".", "--name", "code"],
            &["rm", "code"],
            &["spaces"],
            &["status"],
            &["--json", "status"],
            &["status", "--json"],
            &["sync"],
            &["sync", "--timeout", "30"],
            &["sessions"],
            &[
                "sessions",
                "auth bug",
                "--agent",
                "claude",
                "--machine",
                "box",
                "--here",
                "--limit",
                "5",
            ],
            &["resume"],
            &["resume", "1a2b3c", "--takeover"],
            &[
                "resume",
                "fix login",
                "--fork",
                "--print",
                "--agent",
                "codex",
            ],
            &["log"],
            &["log", "src/", "--since", "2h", "--limit", "10"],
            &["history", "a.txt"],
            &["restore", "a.txt"],
            &["restore", "a.txt", "--seq", "42"],
            &["conflicts"],
            &["doctor"],
            &["daemon", "run"],
            &["daemon", "start"],
            &["daemon", "stop"],
            &["daemon", "status"],
            &["service", "install"],
            &["service", "install", "--hub"],
            &["service", "uninstall", "--hub"],
            &["hub", "serve"],
            &["hub", "serve", "--tcp", "0.0.0.0:7707", "--detach"],
            &["hub", "connect"],
        ];
        for args in ok {
            assert!(
                parse(args).is_ok(),
                "should parse: {args:?}: {:?}",
                parse(args).err()
            );
        }
    }

    #[test]
    fn parsed_values() {
        let cli = parse(&["--json", "sessions", "q", "--here", "--limit", "3"]).unwrap();
        assert!(cli.json);
        match cli.cmd {
            Cmd::Sessions(a) => {
                assert_eq!(a.query.as_deref(), Some("q"));
                assert!(a.here);
                assert_eq!(a.limit, 3);
            }
            other => panic!("{other:?}"),
        }
        match parse(&["sync"]).unwrap().cmd {
            Cmd::Sync { timeout } => assert_eq!(timeout, 120),
            other => panic!("{other:?}"),
        }
        match parse(&["log", "--since", "30m"]).unwrap().cmd {
            Cmd::Log(a) => {
                assert_eq!(a.since.as_deref(), Some("30m"));
                assert_eq!(a.limit, 50);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rejects_bad_usage() {
        let bad: &[&[&str]] = &[
            &[],
            &["frobnicate"],
            &["add"],
            &["rm"],
            &["history"],
            &["resume", "x", "--takeover", "--fork"],
            &["log", "--since", "yesterday"],
            &["sync", "--timeout", "soon"],
            &["daemon"],
            &["service", "install", "--bogus"],
        ];
        for args in bad {
            let e = parse(args).expect_err(&format!("should fail: {args:?}"));
            assert_eq!(e.exit_code(), output::EXIT_USAGE, "{args:?}");
        }
        assert_eq!(parse(&["--version"]).unwrap_err().exit_code(), EXIT_OK);
    }

    fn rec(seq: u64, op: Op) -> LogRecord {
        LogRecord {
            seq,
            op,
            at: 0,
            space: "code".into(),
            path: "a.txt".into(),
            kind: crate::proto::Kind::File,
            hash: "h".into(),
            size: 1,
            origin: "m".into(),
            origin_name: String::new(),
        }
    }

    #[test]
    fn restore_target_defaults() {
        // newest first
        let recs = vec![
            rec(9, Op::Put),
            rec(7, Op::Delete),
            rec(5, Op::Put),
            rec(2, Op::Put),
        ];
        assert_eq!(pick_restore_target(&recs).unwrap().seq, 5);
        let deleted = vec![rec(9, Op::Delete), rec(5, Op::Put)];
        assert_eq!(pick_restore_target(&deleted).unwrap().seq, 5);
        assert!(pick_restore_target(&[rec(1, Op::Put)]).is_none());
        assert!(pick_restore_target(&[]).is_none());
        assert_eq!(machine_of(&rec(1, Op::Put)), "m");
    }

    #[test]
    fn implicit_space_names_never_merge_folders() {
        let space = |name: &str, path: &str| SpaceInfo {
            name: name.into(),
            default_path: path.into(),
            created_at: 0,
            files: 0,
            bytes: 0,
        };
        let hub = vec![space("notes", "~/work/notes"), space("code", "~/Code")];
        assert!(name_collision(&hub, "notes", "~/notes").is_some());
        assert!(
            name_collision(&hub, "code", "~/Code").is_none(),
            "same folder elsewhere = mapping"
        );
        assert!(name_collision(&hub, "code", "~/Code/").is_none());
        assert!(name_collision(&hub, "new", "~/new").is_none());
    }

    #[test]
    fn conflict_originals() {
        assert_eq!(original_of("notes.md.conflict-box-20261025-141502"), "notes.md");
        assert_eq!(
            original_of("dir/Makefile.conflict-my-mac-20261025-141502"),
            "dir/Makefile"
        );
        assert_eq!(original_of("plain.txt"), "plain.txt");
    }

    #[test]
    fn display_paths() {
        let mut cfg = Config::new_for_this_machine();
        cfg.spaces.push(crate::config::SpaceConfig {
            name: "code".into(),
            path: "~/Code".into(),
        });
        assert_eq!(display_path(&cfg, "code", "a/b.rs"), "~/Code/a/b.rs");
        assert_eq!(display_path(&cfg, "notes", "x.md"), "notes:x.md");
        assert_eq!(
            display_path(&cfg, "@claude", "sessions/x.jsonl"),
            "@claude/sessions/x.jsonl"
        );
    }
}
