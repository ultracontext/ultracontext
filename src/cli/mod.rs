//! Command line (DESIGN §7). Owner: cli agent.
//!
//! The CLI is a thin client of the daemon (control socket). `--json` makes every command print
//! exactly one JSON document on stdout (errors: `{"error":{code,message,hint,exit_code}}`).
//! Exit codes: 0 ok, 1 error, 2 usage.

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

use crate::client::{control, daemon};
use crate::config::Config;
use crate::paths::{self, Paths};
use crate::proto::{Ctl, Query, StatusReport, SyncReport};
use crate::service;

mod doctor;
mod init;
pub mod output;
mod sessions;
pub mod skill;
pub mod util;

use output::{emit_json, note, outln, CliError, Color, EXIT_ERR, EXIT_OK};

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Parser, Debug)]
#[command(name = "uc", version, about = "ultracontext: your Claude Code and Codex sessions on every machine",
          long_about = None, propagate_version = true,
          after_help = "Agents: add --json to any command for one machine-readable JSON document.\n\
                        Exit codes: 0 ok, 1 error, 2 usage.")]
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
    /// Hub link, pending work, live sessions
    Status,
    /// Rescan and wait until everything is pushed and pulled ("safe to close the lid")
    Sync {
        /// Give up after this many seconds
        #[arg(long, default_value_t = 120)]
        timeout: u64,
    },
    /// All Claude Code / Codex sessions from every machine, newest first
    Sessions(SessionsArgs),
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
    /// Path of `uc` on the hub host (ssh)
    #[arg(long)]
    pub remote_uc: Option<String>,
    /// Do not sync agent sessions (and do not install the agent skill)
    #[arg(long)]
    pub no_agents: bool,
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
                Cmd::Status => cmd_status(&app),
                Cmd::Sync { timeout } => cmd_sync(&app, timeout),
                Cmd::Sessions(a) => sessions::cmd_sessions(&app, a),
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
    for (i, msg) in st.conflicts.iter().enumerate() {
        outln!(
            "{}{}",
            label(if i == 0 { "diverged" } else { "" }),
            output::paint(Color::Yellow, msg)
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
    for msg in &rep.conflicts {
        outln!("{} {msg}", output::warn_mark());
    }
    Ok(code)
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
                "--remote-uc",
                "/opt/uc",
                "--no-agents",
            ],
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
    }

    #[test]
    fn rejects_bad_usage() {
        let bad: &[&[&str]] = &[
            &[],
            &["frobnicate"],
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
}
