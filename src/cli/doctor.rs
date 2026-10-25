//! `uc doctor`: one line per check, ✓ / ! / ✗ with a fix hint; exit 1 if anything failed.

use anyhow::Result;
use serde::Serialize;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::init::hub_hint;
use super::output::{self, emit_json, outln, Color, EXIT_ERR, EXIT_OK};
use super::{skill, App};
use crate::client::control;
use crate::config::Config;
use crate::paths;
use crate::proto::{self, StatusReport};
use crate::service::{self, Role};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub status: Level,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

fn check(
    name: &'static str,
    status: Level,
    detail: impl Into<String>,
    fix: Option<String>,
) -> Check {
    Check {
        name,
        status,
        detail: detail.into(),
        fix,
    }
}

#[derive(Serialize)]
struct Report {
    ok: bool,
    checks: Vec<Check>,
}

pub fn cmd_doctor(app: &App) -> Result<i32> {
    let mut checks = Vec::new();

    let cfg = match Config::load(&app.paths.config()) {
        Ok(Some(c)) if c.is_initialized() => {
            checks.push(check(
                "config",
                Level::Ok,
                format!(
                    "hub '{}' · machine {} ({})",
                    c.hub, c.machine_name, c.machine_id
                ),
                None,
            ));
            Some(c)
        }
        Ok(_) => {
            checks.push(check(
                "config",
                Level::Fail,
                format!(
                    "not set up ({} has no hub)",
                    paths::tilde(&app.paths.config())
                ),
                Some("uc init <hub>".into()),
            ));
            None
        }
        Err(e) => {
            checks.push(check(
                "config",
                Level::Fail,
                format!("{e:#}"),
                Some(format!(
                    "fix or remove {}",
                    paths::tilde(&app.paths.config())
                )),
            ));
            None
        }
    };

    let running = control::probe(&app.paths.daemon_sock(), Duration::from_secs(2));
    let status: Option<StatusReport> = if running { app.status().ok() } else { None };
    let log = paths::tilde(&app.paths.daemon_log());
    checks.push(match (&status, running) {
        (Some(st), _) => check(
            "daemon",
            Level::Ok,
            format!(
                "running (pid {}, up {})",
                st.daemon_pid,
                output::short_duration(st.uptime_s as i64)
            ),
            None,
        ),
        (None, true) => check(
            "daemon",
            Level::Fail,
            "running but not answering",
            Some(format!("uc daemon stop && uc daemon start (log: {log})")),
        ),
        (None, false) => check(
            "daemon",
            Level::Fail,
            "not running",
            Some(format!("uc daemon start (log: {log})")),
        ),
    });

    if let Some(cfg) = &cfg {
        checks.push(match &status {
            Some(st) if st.connected => check(
                "hub",
                Level::Ok,
                format!(
                    "connected to '{}' (seq {}, this machine at {})",
                    st.hub, st.head_seq, st.cursor
                ),
                None,
            ),
            Some(st) => check(
                "hub",
                Level::Fail,
                format!(
                    "'{}' unreachable: {}",
                    st.hub,
                    st.last_error.as_deref().unwrap_or("not connected yet")
                ),
                Some(hub_hint(&cfg.hub)),
            ),
            None => check(
                "hub",
                Level::Fail,
                "unknown (daemon not running)",
                Some("uc daemon start".into()),
            ),
        });
    }

    if let Some(st) = &status {
        checks.push(versions_check(
            proto::VERSION,
            &st.daemon_version,
            st.hub_version.as_deref(),
        ));
        if st.connected {
            if let Some(e) = &st.last_error {
                checks.push(check(
                    "last error",
                    Level::Warn,
                    e.clone(),
                    Some(format!("details in {log}")),
                ));
            }
        }
        if !st.conflicts.is_empty() {
            checks.push(check(
                "conflicts",
                Level::Warn,
                format!("{} conflict copies", st.conflicts.len()),
                Some("uc conflicts".into()),
            ));
        }
        let files: u64 = st.spaces.iter().map(|s| s.files).sum();
        if let Some(c) = watch_limit_check(inotify_max_watches(), files) {
            checks.push(c);
        }
    }

    checks.push(if service::is_installed(Role::Daemon) {
        check(
            "autostart",
            Level::Ok,
            service::unit_path(Role::Daemon)
                .map(|p| paths::tilde(&p))
                .unwrap_or_default(),
            None,
        )
    } else {
        check(
            "autostart",
            Level::Warn,
            "not installed (the daemon starts on first use only)",
            Some("uc service install".into()),
        )
    });

    let me = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    checks.push(match which("uc") {
        // an older uc earlier on PATH (e.g. a previous `cargo install`) would answer agents
        // and `ssh <hub> uc` instead of this one
        Some(p) if me.is_some() && p.canonicalize().ok() != me => check(
            "PATH",
            Level::Warn,
            format!(
                "'uc' on PATH is {}, not this binary ({})",
                paths::tilde(&p),
                me.as_deref().map(paths::tilde).unwrap_or_default()
            ),
            Some(format!(
                "remove or replace the other one: ln -sf {} {}",
                me.as_deref().map(|m| m.display().to_string()).unwrap_or_default(),
                p.display()
            )),
        ),
        Some(p) => check("PATH", Level::Ok, paths::tilde(&p), None),
        None => check(
            "PATH",
            Level::Fail,
            "'uc' is not on PATH (agents and 'ssh <hub> uc' need it)",
            Some(format!(
                "link it: ln -s {} ~/.local/bin/uc (and make sure ~/.local/bin is on PATH)",
                std::env::current_exe()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "<path to uc>".into())
            )),
        ),
    });

    checks.push(disk_check(free_bytes(&app.paths.root), &app.paths.root));

    let agents: Vec<String> = skill::agent_roots()
        .into_iter()
        .map(|(agent, root)| {
            if root.is_dir() {
                format!("{agent} {}", paths::tilde(&root))
            } else {
                format!("{agent} (not installed)")
            }
        })
        .collect();
    checks.push(check("agents", Level::Ok, agents.join(" · "), None));

    let ok = !checks.iter().any(|c| c.status == Level::Fail);
    if app.json {
        emit_json(&Report { ok, checks });
    } else {
        for c in &checks {
            let mark = match c.status {
                Level::Ok => output::ok_mark(),
                Level::Warn => output::warn_mark(),
                Level::Fail => output::fail_mark(),
            };
            outln!("{mark} {:<11} {}", c.name, c.detail);
            if let (Some(fix), true) = (&c.fix, c.status != Level::Ok) {
                outln!(
                    "  {:<11} {}",
                    "",
                    output::paint(Color::Dim, &format!("fix: {fix}"))
                );
            }
        }
    }
    Ok(if ok { EXIT_OK } else { EXIT_ERR })
}

pub(crate) fn versions_check(cli: &str, daemon: &str, hub: Option<&str>) -> Check {
    let hub_s = hub.unwrap_or("?");
    let detail = format!("cli {cli} · daemon {daemon} · hub {hub_s}");
    if cli != daemon {
        return check(
            "versions",
            Level::Warn,
            detail,
            Some("restart the daemon after upgrading: uc daemon stop && uc daemon start".into()),
        );
    }
    if hub.is_some_and(|h| h != cli) {
        return check(
            "versions",
            Level::Warn,
            detail,
            Some("install the same uc version on the hub and restart it".into()),
        );
    }
    check("versions", Level::Ok, detail, None)
}

/// inotify needs a watch per directory; the file count is a safe upper bound.
pub(crate) fn watch_limit_check(max: Option<u64>, files: u64) -> Option<Check> {
    let max = max?;
    let fix = Some(
        "echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/90-uc.conf && sudo sysctl --system"
            .to_string(),
    );
    Some(if files > max {
        check(
            "watcher",
            Level::Fail,
            format!("inotify max_user_watches {max} < {files} synced files"),
            fix,
        )
    } else if files > max / 10 * 8 {
        check(
            "watcher",
            Level::Warn,
            format!("inotify max_user_watches {max} is close to {files} synced files"),
            fix,
        )
    } else {
        check(
            "watcher",
            Level::Ok,
            format!("inotify max_user_watches {max}"),
            None,
        )
    })
}

fn inotify_max_watches() -> Option<u64> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub(crate) fn disk_check(free: Option<u64>, root: &Path) -> Check {
    const GIB: u64 = 1024 * 1024 * 1024;
    let Some(free) = free else {
        return check(
            "disk",
            Level::Warn,
            format!("cannot read free space of {}", paths::tilde(root)),
            None,
        );
    };
    let detail = format!(
        "{} free for {}",
        output::human_bytes(free),
        paths::tilde(root)
    );
    if free < GIB {
        check(
            "disk",
            Level::Fail,
            detail,
            Some("free some space: uc keeps trash/ and staging/ there".into()),
        )
    } else if free < 5 * GIB {
        check("disk", Level::Warn, detail, Some("free some space".into()))
    } else {
        check("disk", Level::Ok, detail, None)
    }
}

/// Free bytes on the filesystem holding `p` (or its nearest existing ancestor).
fn free_bytes(p: &Path) -> Option<u64> {
    let existing = p.ancestors().find(|a| a.exists())?;
    let c = CString::new(existing.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs fills a struct we own; the path is a valid NUL-terminated string.
    unsafe {
        let mut s: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some(s.f_bavail as u64 * s.f_frsize as u64)
    }
}

fn which(prog: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(prog))
        .find(|p| {
            std::fs::metadata(p)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(
            versions_check("0.1.0", "0.1.0", Some("0.1.0")).status,
            Level::Ok
        );
        assert_eq!(versions_check("0.1.0", "0.1.0", None).status, Level::Ok);
        let c = versions_check("0.2.0", "0.1.0", Some("0.2.0"));
        assert_eq!(c.status, Level::Warn);
        assert!(c.fix.unwrap().contains("uc daemon stop"));
        assert_eq!(
            versions_check("0.2.0", "0.2.0", Some("0.1.0")).status,
            Level::Warn
        );
    }

    #[test]
    fn watch_limits() {
        assert!(watch_limit_check(None, 10).is_none());
        assert_eq!(
            watch_limit_check(Some(8192), 100).unwrap().status,
            Level::Ok
        );
        assert_eq!(
            watch_limit_check(Some(8192), 7000).unwrap().status,
            Level::Warn
        );
        let c = watch_limit_check(Some(8192), 9000).unwrap();
        assert_eq!(c.status, Level::Fail);
        assert!(c.fix.unwrap().contains("max_user_watches"));
    }

    #[test]
    fn disk_levels() {
        let gib = 1024 * 1024 * 1024;
        let root = Path::new("/x");
        assert_eq!(disk_check(Some(100 * gib), root).status, Level::Ok);
        assert_eq!(disk_check(Some(2 * gib), root).status, Level::Warn);
        assert_eq!(disk_check(Some(gib / 2), root).status, Level::Fail);
        assert_eq!(disk_check(None, root).status, Level::Warn);
        assert!(free_bytes(Path::new("/tmp/definitely/not/here")).is_some());
    }

    #[test]
    fn finds_programs_on_path() {
        assert!(which("sh").is_some());
        assert!(which("uc-definitely-not-a-program").is_none());
    }
}
