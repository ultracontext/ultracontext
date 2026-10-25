//! Autostart: launchd (macOS) / systemd --user (Linux). Owner: cli agent.
//!
//! File generation is pure (unit tested); only loading/unloading shells out.
//! Restart policy: restart on failure only (launchd `KeepAlive{SuccessfulExit=false}`, systemd
//! `Restart=on-failure`), so `uc daemon stop` (a clean exit) is not immediately undone.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths::{self, Paths};

/// Environment variables carried into the service (the daemon must see the same agent roots,
/// state dir and ssh command as the user's shell).
const PASS_ENV: &[&str] = &[
    "UC_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "UC_SSH",
    "UC_LOG",
    "PATH",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// the per-machine sync daemon (`uc daemon run`)
    Daemon,
    /// the hub (`uc hub serve`)
    Hub,
}

impl Role {
    pub fn launchd_label(self) -> &'static str {
        match self {
            Role::Daemon => "dev.ultracontext.daemon",
            Role::Hub => "dev.ultracontext.hub",
        }
    }
    pub fn systemd_unit(self) -> &'static str {
        match self {
            Role::Daemon => "uc.service",
            Role::Hub => "uc-hub.service",
        }
    }
    pub fn args(self) -> &'static [&'static str] {
        match self {
            Role::Daemon => &["daemon", "run"],
            Role::Hub => &["hub", "serve"],
        }
    }
    fn description(self) -> &'static str {
        match self {
            Role::Daemon => "ultracontext sync daemon (uc)",
            Role::Hub => "ultracontext hub (uc)",
        }
    }
}

/// Everything that goes into a service definition.
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceSpec {
    pub role: Role,
    pub exe: PathBuf,
    pub log: PathBuf,
    pub env: Vec<(String, String)>,
}

impl ServiceSpec {
    /// Spec for this machine: the current executable, log under UC_HOME, pass-through env.
    pub fn for_this_machine(role: Role) -> Result<ServiceSpec> {
        let exe = std::env::current_exe().context("locating the uc executable")?;
        let exe = exe.canonicalize().unwrap_or(exe);
        let p = Paths::from_env();
        let log = match role {
            Role::Daemon => p.daemon_log(),
            Role::Hub => p.hub_log(),
        };
        let env = PASS_ENV
            .iter()
            .filter_map(|k| {
                let v = std::env::var(k).ok()?;
                (!v.is_empty()).then(|| (k.to_string(), v))
            })
            .collect();
        Ok(ServiceSpec {
            role,
            exe,
            log,
            env,
        })
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// launchd agent plist.
pub fn launchd_plist(spec: &ServiceSpec) -> String {
    let mut args = format!(
        "    <string>{}</string>\n",
        xml_escape(&spec.exe.to_string_lossy())
    );
    for a in spec.role.args() {
        args.push_str(&format!("    <string>{a}</string>\n"));
    }
    let mut env = String::new();
    if !spec.env.is_empty() {
        env.push_str("  <key>EnvironmentVariables</key>\n  <dict>\n");
        for (k, v) in &spec.env {
            env.push_str(&format!(
                "    <key>{}</key>\n    <string>{}</string>\n",
                xml_escape(k),
                xml_escape(v)
            ));
        }
        env.push_str("  </dict>\n");
    }
    let log = xml_escape(&spec.log.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
{env}  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = spec.role.launchd_label(),
    )
}

/// systemd quoting: double quotes, backslash escapes, and `%` doubled (specifier syntax).
fn systemd_quote(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

/// systemd --user unit.
pub fn systemd_unit(spec: &ServiceSpec) -> String {
    let mut exec = systemd_quote(&spec.exe.to_string_lossy());
    for a in spec.role.args() {
        exec.push(' ');
        exec.push_str(a);
    }
    let env: String = spec
        .env
        .iter()
        .map(|(k, v)| format!("Environment={}\n", systemd_quote(&format!("{k}={v}"))))
        .collect();
    format!(
        "[Unit]\n\
         Description={desc}\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec}\n\
         Restart=on-failure\n\
         RestartSec=2\n\
         {env}\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        desc = spec.role.description(),
    )
}

pub fn launchd_path(role: Role) -> PathBuf {
    paths::home()
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", role.launchd_label()))
}

pub fn systemd_path(role: Role) -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| paths::home().join(".config"));
    base.join("systemd/user").join(role.systemd_unit())
}

/// Where this OS keeps the service definition.
pub fn unit_path(role: Role) -> Result<PathBuf> {
    match paths::os_name() {
        "macos" => Ok(launchd_path(role)),
        "linux" => Ok(systemd_path(role)),
        other => bail!("autostart is not supported on {other}"),
    }
}

pub fn is_installed(role: Role) -> bool {
    unit_path(role).map(|p| p.exists()).unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallReport {
    pub role: Role,
    pub path: PathBuf,
    /// the service manager accepted and started it
    pub loaded: bool,
    pub notes: Vec<String>,
}

/// Write the service definition and start it.
pub fn install(role: Role) -> Result<InstallReport> {
    let spec = ServiceSpec::for_this_machine(role)?;
    let path = unit_path(role)?;
    if let Some(dir) = spec.log.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let content = if paths::os_name() == "macos" {
        launchd_plist(&spec)
    } else {
        systemd_unit(&spec)
    };
    write_file(&path, &content)?;
    let mut notes = Vec::new();
    let loaded = if paths::os_name() == "macos" {
        launchd_load(role, &path, &mut notes)
    } else {
        systemd_enable(role, &mut notes)
    };
    Ok(InstallReport {
        role,
        path,
        loaded,
        notes,
    })
}

/// Stop the service and remove its definition. Returns the removed path, if any.
pub fn uninstall(role: Role) -> Result<Option<PathBuf>> {
    let path = unit_path(role)?;
    if paths::os_name() == "macos" {
        let target = format!("gui/{}/{}", uid(), role.launchd_label());
        if !run_quiet("launchctl", &["bootout", &target]) && path.exists() {
            run_quiet("launchctl", &["unload", "-w", &path.to_string_lossy()]);
        }
    } else {
        run_quiet(
            "systemctl",
            &["--user", "disable", "--now", role.systemd_unit()],
        );
    }
    let existed = path.exists();
    if existed {
        std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
    }
    if paths::os_name() == "linux" {
        run_quiet("systemctl", &["--user", "daemon-reload"]);
    }
    Ok(existed.then_some(path))
}

fn write_file(path: &Path, content: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn uid() -> u32 {
    // SAFETY: getuid cannot fail.
    unsafe { libc::getuid() }
}

fn launchd_load(role: Role, plist: &Path, notes: &mut Vec<String>) -> bool {
    let domain = format!("gui/{}", uid());
    // re-installing: unload the old definition first, or bootstrap fails with "already loaded"
    run_quiet(
        "launchctl",
        &["bootout", &format!("{domain}/{}", role.launchd_label())],
    );
    let p = plist.to_string_lossy();
    if run_quiet("launchctl", &["bootstrap", &domain, &p]) {
        return true;
    }
    if run_quiet("launchctl", &["load", "-w", &p]) {
        return true;
    }
    notes.push(format!(
        "launchctl could not load {p}; try: launchctl bootstrap {domain} {p}"
    ));
    false
}

fn systemd_enable(role: Role, notes: &mut Vec<String>) -> bool {
    let unit = role.systemd_unit();
    let ok = run_quiet("systemctl", &["--user", "daemon-reload"])
        && run_quiet("systemctl", &["--user", "enable", "--now", unit]);
    if !ok {
        notes.push(format!(
            "systemctl --user failed (no user session bus?); try: systemctl --user enable --now {unit}"
        ));
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "$USER".into());
    notes.push(format!(
        "on a headless box, keep it running after logout: loginctl enable-linger {user}"
    ));
    ok
}

fn run_quiet(prog: &str, args: &[&str]) -> bool {
    match Command::new(prog).args(args).output() {
        Ok(o) => {
            if !o.status.success() {
                tracing::debug!(
                    "{prog} {}: {}",
                    args.join(" "),
                    String::from_utf8_lossy(&o.stderr).trim()
                );
            }
            o.status.success()
        }
        Err(e) => {
            tracing::debug!("{prog}: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(role: Role) -> ServiceSpec {
        ServiceSpec {
            role,
            exe: PathBuf::from("/opt/my tools/uc"),
            log: PathBuf::from("/home/f/.ultracontext/logs/daemon.log"),
            env: vec![
                ("UC_HOME".into(), "/home/f/.uc&co".into()),
                ("PATH".into(), "/usr/bin:/bin:/home/f/100%/bin".into()),
            ],
        }
    }

    #[test]
    fn plist_for_daemon() {
        let p = launchd_plist(&spec(Role::Daemon));
        assert!(p.starts_with("<?xml"));
        assert!(p.contains("<string>dev.ultracontext.daemon</string>"));
        assert!(p.contains(
            "    <string>/opt/my tools/uc</string>\n    <string>daemon</string>\n    <string>run</string>\n"
        ));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(p.contains("<key>SuccessfulExit</key>\n    <false/>"));
        assert!(p.contains("<key>UC_HOME</key>\n    <string>/home/f/.uc&amp;co</string>"));
        assert_eq!(
            p.matches("<string>/home/f/.ultracontext/logs/daemon.log</string>")
                .count(),
            2
        );
        // well-formed enough: balanced dict tags
        assert_eq!(p.matches("<dict>").count(), p.matches("</dict>").count());
    }

    #[test]
    fn plist_for_hub_without_env() {
        let mut s = spec(Role::Hub);
        s.env.clear();
        let p = launchd_plist(&s);
        assert!(p.contains("<string>dev.ultracontext.hub</string>"));
        assert!(p.contains("<string>hub</string>\n    <string>serve</string>"));
        assert!(!p.contains("EnvironmentVariables"));
    }

    #[test]
    fn systemd_units() {
        let u = systemd_unit(&spec(Role::Daemon));
        assert!(u.contains("ExecStart=\"/opt/my tools/uc\" daemon run\n"));
        assert!(u.contains("Restart=on-failure\nRestartSec=2\n"));
        assert!(u.contains("Environment=\"UC_HOME=/home/f/.uc&co\"\n"));
        assert!(u.contains("Environment=\"PATH=/usr/bin:/bin:/home/f/100%%/bin\"\n"));
        assert!(u.contains("[Install]\nWantedBy=default.target\n"));
        let h = systemd_unit(&spec(Role::Hub));
        assert!(!h.contains("daemon run") && h.contains("\" hub serve\n"));
        assert_eq!(Role::Hub.systemd_unit(), "uc-hub.service");
        assert_eq!(systemd_quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn unit_paths_follow_home() {
        let home = paths::home();
        assert_eq!(
            launchd_path(Role::Daemon),
            home.join("Library/LaunchAgents/dev.ultracontext.daemon.plist")
        );
        assert!(systemd_path(Role::Hub).ends_with("systemd/user/uc-hub.service"));
    }
}
