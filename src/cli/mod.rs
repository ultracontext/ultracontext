//! Command line (DESIGN §7). Owner: cli agent.

use anyhow::Result;
use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "uc", version, about = "ultracontext: Dropbox for developers and their agents",
          long_about = None, propagate_version = true)]
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
    /// Sync a folder on all your machines
    Add(AddArgs),
    /// Stop syncing a space on this machine (files are kept)
    Rm { name: String },
    /// Spaces on the hub and where they live on this machine
    Spaces,
    /// Hub link, pending work, conflicts, live sessions
    Status,
    /// Rescan and wait until everything is pushed and pulled ("safe to close the lid")
    Sync {
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
    /// Restore a file to an older version
    Restore {
        path: String,
        #[arg(long)]
        seq: Option<u64>,
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
    /// Do not sync agent sessions
    #[arg(long)]
    pub no_agents: bool,
}

#[derive(Args, Debug)]
pub struct AddArgs {
    pub dir: String,
    /// Space name (default: folder name). Use an existing hub space name to map it here.
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Args, Debug)]
pub struct SessionsArgs {
    /// Filter: text in id, title, first prompt or directory
    pub query: Option<String>,
    #[arg(long)]
    pub agent: Option<String>,
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
    pub path: Option<String>,
    /// e.g. 30m, 2h, 1d
    #[arg(long)]
    pub since: Option<String>,
    #[arg(long, default_value_t = 50)]
    pub limit: u32,
}

#[derive(Subcommand, Debug)]
pub enum DaemonCmd {
    /// Run in the foreground
    Run,
    /// Start in the background
    Start,
    Stop,
    Status,
}

#[derive(Subcommand, Debug)]
pub enum ServiceCmd {
    Install {
        /// Also/only install the hub service (on the hub box)
        #[arg(long)]
        hub: bool,
    },
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
    let cli = Cli::parse();
    let _ = cli;
    todo!("cli agent")
}
