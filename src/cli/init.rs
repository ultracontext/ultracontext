//! `uc init`: config, agent skill, daemon, hub link.

use anyhow::{Context, Result};
use serde::Serialize;
use std::time::{Duration, Instant};

use super::output::{self, emit_json, note, outln, CliError, Color, EXIT_OK};
use super::skill::{self, SkillAction, SkillInstall};
use super::{util, App, InitArgs};
use crate::client::{control, daemon};
use crate::config::Config;
use crate::paths;
use crate::proto::{Ctl, MachineInfo, StatusReport};

const CONNECT_WAIT: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize)]
struct InitReport {
    machine: MachineInfo,
    hub: String,
    config: String,
    connected: bool,
    hub_version: Option<String>,
    skills: Vec<SkillInstall>,
}

/// Hint for a hub that cannot be reached, by address form.
pub(crate) fn hub_hint(hub: &str) -> String {
    let h = hub.trim();
    if h == "local" || h.starts_with("unix:") {
        "is the hub running on this machine? try 'uc hub serve --detach', then 'uc doctor'".into()
    } else if h.starts_with("tcp://") {
        "check the address and that UC_TOKEN (or token in config.toml) matches the hub's".into()
    } else {
        let target = h.trim_start_matches("ssh://");
        let ssh = match target.rsplit_once(':') {
            Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                format!("ssh -p {port} {host}")
            }
            _ => format!("ssh {target}"),
        };
        format!(
            "check that '{ssh} uc --version' works without a password prompt \
             (if uc is not on the hub's PATH: uc init {h} --remote-uc /path/to/uc)"
        )
    }
}

fn ask_hub(current: &str) -> Option<String> {
    let q = if current.is_empty() {
        "Hub address (ssh host like 'myserver' or 'me@host'; 'local' to make this machine the hub): ".to_string()
    } else {
        format!("Hub address [{current}]: ")
    };
    let a = util::prompt(&q)?;
    if a.is_empty() {
        (!current.is_empty()).then(|| current.to_string())
    } else {
        Some(a)
    }
}

pub fn cmd_init(app: &App, a: InitArgs) -> Result<i32> {
    app.paths
        .ensure()
        .with_context(|| format!("creating {}", app.paths.root.display()))?;
    let previous = Config::load(&app.paths.config())?;
    let mut cfg = previous
        .clone()
        .unwrap_or_else(Config::new_for_this_machine);
    let interactive = util::interactive(app.json);

    let hub = match a.hub.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
        Some(h) => h.to_string(),
        None if interactive => ask_hub(&cfg.hub).unwrap_or_default(),
        None if cfg.is_initialized() => cfg.hub.clone(),
        None => String::new(),
    };
    if hub.is_empty() {
        return Err(CliError::usage("which hub? pass its address: uc init <HUB>")
            .hint("e.g. 'uc init myserver' (an ssh host), 'uc init me@host', or 'uc init local' on the hub box")
            .into());
    }
    crate::transport::HubAddr::parse(&hub).map_err(|e| {
        CliError::usage(format!("invalid hub address '{hub}': {e:#}")).hint(
            "forms: host, user@host, ssh://user@host:port, tcp://host:port, unix:/path, local",
        )
    })?;
    cfg.hub = hub.clone();
    if let Some(n) = a.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        cfg.machine_name = n.to_string();
    }
    if let Some(r) = &a.remote_uc {
        cfg.remote_uc = r.trim().to_string();
    }
    if a.no_agents {
        cfg.agents.claude = false;
        cfg.agents.codex = false;
    }
    let settings_changed = previous.as_ref().map_or(true, |p| {
        p.hub != cfg.hub
            || p.remote_uc != cfg.remote_uc
            || p.machine_name != cfg.machine_name
            || p.agents != cfg.agents
    });
    // sync state (cursor, bases) belongs to one hub: start over when switching hubs, or when
    // the daemon found that the hub behind the same address was replaced
    let new_hub = previous
        .as_ref()
        .is_some_and(|p| p.is_initialized() && p.hub != cfg.hub)
        || daemon::hub_mismatch_marker(&app.paths).exists();
    cfg.save(&app.paths.config())
        .with_context(|| format!("saving {}", app.paths.config().display()))?;

    let skills = if a.no_agents {
        Vec::new()
    } else {
        skill::install_all().unwrap_or_else(|e| {
            if !app.json {
                note(&format!(
                    "{} could not install the agent skill: {e:#}",
                    output::warn_mark()
                ));
            }
            Vec::new()
        })
    };

    // a running daemon must pick up the new config (it owns config writes from here on)
    let sock = app.paths.daemon_sock();
    if new_hub {
        app.rt.block_on(daemon::stop(&app.paths))?;
        if let Some(backup) = daemon::reset_sync_state(&app.paths)? {
            if !app.json {
                note(&format!(
                    "new hub: starting with fresh sync state (previous state kept in {})",
                    paths::tilde(&backup)
                ));
            }
        }
    } else if control::probe(&sock, Duration::from_secs(2)) {
        if settings_changed {
            app.rt.block_on(daemon::stop(&app.paths))?;
        } else {
            let _ = app.call(Ctl::Reload, Duration::from_secs(30));
        }
    }
    app.connect()?;

    if !app.json {
        note(&format!("connecting to {hub} …"));
    }
    let deadline = Instant::now() + CONNECT_WAIT;
    let st: StatusReport = loop {
        let st = app.status()?;
        if st.connected || Instant::now() >= deadline {
            break st;
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    if !st.connected {
        let why = st.last_error.clone().unwrap_or_else(|| "timed out".into());
        return Err(CliError::new(
            "offline",
            format!("saved the config, but could not reach the hub at '{hub}': {why}"),
        )
        .hint(format!(
            "{} (the daemon keeps retrying in the background)",
            hub_hint(&hub)
        ))
        .into());
    }

    let cfg_now = app.config()?;
    let report = InitReport {
        machine: cfg_now.machine_info(),
        hub: hub.clone(),
        config: app.paths.config().to_string_lossy().to_string(),
        connected: st.connected,
        hub_version: st.hub_version.clone(),
        skills,
    };
    if app.json {
        emit_json(&report);
        return Ok(EXIT_OK);
    }
    print_report(&report);
    Ok(EXIT_OK)
}

fn print_report(r: &InitReport) {
    outln!(
        "{} {} is connected to {} {}",
        output::ok_mark(),
        output::paint(Color::Bold, &r.machine.name),
        output::paint(Color::Bold, &r.hub),
        output::paint(
            Color::Dim,
            &format!("(hub {})", r.hub_version.as_deref().unwrap_or("?"))
        )
    );
    for s in &r.skills {
        let what = match s.action {
            SkillAction::Installed => "installed",
            SkillAction::Updated => "updated",
            SkillAction::Unchanged => "up to date",
            SkillAction::Kept => "kept your edited copy of",
        };
        outln!(
            "{} {what} the uc skill for {} ({})",
            output::ok_mark(),
            s.agent,
            paths::tilde(&s.path)
        );
    }
    outln!();
    outln!("{}", output::paint(Color::Bold, "Next steps"));
    let steps = [
        ("uc status", "hub link, pending work, live sessions"),
        (
            "uc sessions",
            "Claude Code / Codex sessions from every machine",
        ),
        ("uc service install", "start uc automatically at login"),
    ];
    for (cmd, what) in steps {
        outln!(
            "  {} {}",
            output::paint(Color::Cyan, &format!("{cmd:<20}")),
            output::paint(Color::Dim, what)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_by_address_form() {
        assert!(hub_hint("myserver").contains("ssh myserver uc --version"));
        assert!(hub_hint("ssh://me@box:2222").contains("'ssh -p 2222 me@box uc --version'"));
        assert!(hub_hint("local").contains("uc hub serve --detach"));
        assert!(hub_hint("unix:/tmp/h.sock").contains("uc hub serve"));
        assert!(hub_hint("tcp://h:7707").contains("UC_TOKEN"));
    }
}
