use std::env;
use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const APP_DIR: &str = ".ultracontext";
const DEFAULT_REMOTE_ROOT: &str = "~/.ultracontext";
const DEFAULT_SEARCH_AGENT: &str = "claude";

#[derive(Debug)]
enum UcError {
    Message(String),
    Io(io::Error),
}

impl fmt::Display for UcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UcError::Message(message) => write!(f, "{message}"),
            UcError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl From<io::Error> for UcError {
    fn from(error: io::Error) -> Self {
        UcError::Io(error)
    }
}

type Result<T> = std::result::Result<T, UcError>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Source {
    agent: String,
    local_path: String,
    remote_leaf: String,
    enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    remote: String,
    remote_root: String,
    host_id: String,
    search_agent: String,
    sources: Vec<Source>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteSpec {
    target: String,
    root: String,
}

fn main() {
    if let Err(error) = run(env::args().collect()) {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<()> {
    match args.get(1).map(String::as_str) {
        None | Some("-h" | "--help" | "help") => {
            print_help();
            Ok(())
        }
        Some("init") => cmd_init(&args[2..]),
        Some("sync") => cmd_sync(&args[2..]),
        Some("query") => cmd_query(&args[2..]),
        Some("doctor") => cmd_doctor(),
        Some("version" | "-V" | "--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!("unknown command: {command}"))),
    }
}

fn print_help() {
    println!(
        "UltraContext {}\n\nUsage:\n  ultracontext init [remote]\n  ultracontext sync <start|status|stop>\n  ultracontext query <question>\n  ultracontext doctor\n\nAlias:\n  uc should point to the same binary as ultracontext.\n",
        env!("CARGO_PKG_VERSION")
    );
}

fn cmd_init(args: &[String]) -> Result<()> {
    let mut remote_arg: Option<String> = None;
    let mut host_id_arg: Option<String> = None;
    let mut remote_root_arg: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--host-id" => {
                i += 1;
                host_id_arg = Some(require_value(args, i, "--host-id")?.to_string());
            }
            "--remote-root" => {
                i += 1;
                remote_root_arg = Some(require_value(args, i, "--remote-root")?.to_string());
            }
            "-h" | "--help" => {
                println!(
                    "Usage: ultracontext init [user@host[:remote-root]] [--host-id <id>] [--remote-root <path>]"
                );
                return Ok(());
            }
            value if value.starts_with('-') => {
                return Err(UcError::Message(format!("unknown init option: {value}")));
            }
            value => {
                if remote_arg.is_some() {
                    return Err(UcError::Message(
                        "init accepts only one remote argument".to_string(),
                    ));
                }
                remote_arg = Some(value.to_string());
            }
        }
        i += 1;
    }

    let remote_input = match remote_arg {
        Some(value) => value,
        None => prompt("Remote SSH target (example: user@vps): ")?,
    };
    let mut remote = RemoteSpec::parse(&remote_input)?;
    if let Some(remote_root) = remote_root_arg {
        remote.root = remote_root;
    }

    let host_id = host_id_arg.unwrap_or_else(default_host_id);
    let sources = default_sources();
    let config = Config {
        remote: remote.target,
        remote_root: remote.root,
        host_id,
        search_agent: DEFAULT_SEARCH_AGENT.to_string(),
        sources,
    };

    fs::create_dir_all(config_dir()?)?;
    fs::write(config_path()?, config.to_toml())?;

    prepare_remote_workspace(&config)?;

    println!("UltraContext initialized");
    println!("  config: {}", config_path()?.display());
    println!("  remote: {}:{}", config.remote, config.remote_root);
    println!("  host:   {}", config.host_id);
    println!();
    println!("Next:");
    println!("  ultracontext sync start");
    println!("  ultracontext query \"what happened?\"");
    Ok(())
}

fn cmd_sync(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("start") => sync_start(),
        Some("status") => sync_status(),
        Some("stop") => sync_stop(),
        Some("-h" | "--help") | None => {
            println!("Usage: ultracontext sync <start|status|stop>");
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!("unknown sync command: {command}"))),
    }
}

fn sync_start() -> Result<()> {
    require_command("mutagen")?;
    let config = load_config()?;
    prepare_remote_workspace(&config)?;

    let existing = capture_command("mutagen", ["sync", "list"])?;

    for source in enabled_sources(&config) {
        let local_path = expand_home(&source.local_path)?;
        if !local_path.exists() {
            println!(
                "skip {}: local path does not exist ({})",
                source.agent,
                local_path.display()
            );
            continue;
        }

        let name = mutagen_session_name(&config, source);
        if existing.contains(&format!("Name: {name}")) {
            println!("resume {name}");
            run_command("mutagen", ["sync", "resume", name.as_str()])?;
            run_command("mutagen", ["sync", "flush", name.as_str()])?;
            continue;
        }

        let remote_endpoint = remote_endpoint(&config, source);
        println!("create {name}");
        run_command(
            "mutagen",
            [
                "sync",
                "create",
                &format!("--name={name}"),
                "--sync-mode=one-way-safe",
                local_path.to_string_lossy().as_ref(),
                remote_endpoint.as_str(),
            ],
        )?;
    }

    Ok(())
}

fn sync_status() -> Result<()> {
    require_command("mutagen")?;
    run_command("mutagen", ["sync", "list"])
}

fn sync_stop() -> Result<()> {
    require_command("mutagen")?;
    let config = load_config()?;
    for source in enabled_sources(&config) {
        let name = mutagen_session_name(&config, source);
        println!("pause {name}");
        run_command("mutagen", ["sync", "pause", name.as_str()])?;
    }
    Ok(())
}

fn cmd_query(args: &[String]) -> Result<()> {
    if args.is_empty() || args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: ultracontext query <question>");
        return Ok(());
    }

    let config = load_config()?;
    if config.search_agent != "claude" {
        return Err(UcError::Message(
            "only Claude is supported as search_agent in this MVP".to_string(),
        ));
    }

    let question = args.join(" ");
    let sessions_path = format!("{}/workspace/sessions", config.remote_root);
    let prompt = query_prompt(&sessions_path, &question);
    let remote_command = format!(
        "cd {} && claude -p {} --dangerously-skip-permissions",
        remote_path_arg(&sessions_path),
        sh_quote(&prompt)
    );

    run_command("ssh", [config.remote.as_str(), remote_command.as_str()])
}

fn cmd_doctor() -> Result<()> {
    let config = load_config().ok();

    check_local_command("ssh");
    check_local_command("scp");
    check_local_command("mutagen");

    if let Some(config) = config {
        println!("config: {}", config_path()?.display());
        println!("remote: {}:{}", config.remote, config.remote_root);
        println!("host: {}", config.host_id);

        check_remote(&config, "ssh", "true");
        check_remote(
            &config,
            "remote workspace",
            &format!(
                "test -d {}",
                remote_path_arg(&format!("{}/workspace", config.remote_root))
            ),
        );
        check_remote(&config, "claude", "command -v claude >/dev/null");
    } else {
        println!("config: missing ({})", config_path()?.display());
    }

    Ok(())
}

fn prepare_remote_workspace(config: &Config) -> Result<()> {
    let mut dirs = vec![format!("{}/workspace/sessions", config.remote_root)];
    for source in enabled_sources(config) {
        dirs.push(remote_dir(config, source));
    }

    let mkdirs = dirs
        .iter()
        .map(|dir| remote_path_arg(dir))
        .collect::<Vec<_>>()
        .join(" ");
    let command = format!("mkdir -p {mkdirs}");
    run_command("ssh", [config.remote.as_str(), command.as_str()])
}

fn query_prompt(sessions_path: &str, question: &str) -> String {
    format!(
        "You are UltraContext Query, a context engineer for AI agent session files.\n\
Search the synchronized session files under this directory:\n\
{sessions_path}\n\n\
The files are organized as workspace/sessions/<host-id>/<agent>/<native-agent-layout>.\n\
Answer the user's question by inspecting the files directly. Prefer concrete evidence over guesses.\n\
Include relevant agents, hosts, file paths, session ids, and timestamps when you can find them.\n\
If evidence is weak or missing, say so clearly.\n\n\
User question:\n{question}"
    )
}

fn default_sources() -> Vec<Source> {
    vec![
        Source {
            agent: "claude".to_string(),
            local_path: "~/.claude/projects".to_string(),
            remote_leaf: "projects".to_string(),
            enabled: expand_home("~/.claude/projects")
                .map(|p| p.exists())
                .unwrap_or(false),
        },
        Source {
            agent: "codex".to_string(),
            local_path: "~/.codex/sessions".to_string(),
            remote_leaf: "sessions".to_string(),
            enabled: expand_home("~/.codex/sessions")
                .map(|p| p.exists())
                .unwrap_or(false),
        },
    ]
}

fn enabled_sources(config: &Config) -> impl Iterator<Item = &Source> {
    config.sources.iter().filter(|source| source.enabled)
}

fn remote_dir(config: &Config, source: &Source) -> String {
    format!(
        "{}/workspace/sessions/{}/{}/{}",
        config.remote_root, config.host_id, source.agent, source.remote_leaf
    )
}

fn remote_endpoint(config: &Config, source: &Source) -> String {
    format!("{}:{}", config.remote, remote_dir(config, source))
}

fn mutagen_session_name(config: &Config, source: &Source) -> String {
    format!("uc-{}-{}", config.host_id, source.agent)
}

fn config_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(APP_DIR))
}

fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

fn load_config() -> Result<Config> {
    let path = config_path()?;
    let raw = fs::read_to_string(&path)
        .map_err(|error| UcError::Message(format!("failed to read {}: {error}", path.display())))?;
    Config::from_toml(&raw)
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| UcError::Message("HOME is not set".to_string()))
}

fn expand_home(path: &str) -> Result<PathBuf> {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(home_dir()?.join(rest));
    }
    Ok(PathBuf::from(path))
}

fn prompt(label: &str) -> Result<String> {
    print!("{label}");
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let value = line.trim().to_string();
    if value.is_empty() {
        return Err(UcError::Message("empty input".to_string()));
    }
    Ok(value)
}

fn default_host_id() -> String {
    let raw = env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| capture_command("hostname", std::iter::empty::<&str>()).ok())
        .unwrap_or_else(|| "local".to_string());
    sanitize_id(raw.trim())
}

fn sanitize_id(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "local".to_string()
    } else {
        trimmed
    }
}

fn require_value<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| UcError::Message(format!("missing value for {flag}")))
}

fn require_command(name: &str) -> Result<()> {
    let status = Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {} >/dev/null 2>&1", sh_quote(name)))
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(UcError::Message(format!(
            "required command not found: {name}"
        )))
    }
}

fn check_local_command(name: &str) {
    match require_command(name) {
        Ok(()) => println!("local {name}: ok"),
        Err(_) => println!("local {name}: missing"),
    }
}

fn check_remote(config: &Config, label: &str, command: &str) {
    let status = Command::new("ssh")
        .arg(&config.remote)
        .arg(command)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(status) if status.success() => println!("remote {label}: ok"),
        _ => println!("remote {label}: failed"),
    }
}

fn run_command<I, S>(program: &str, args: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let status = Command::new(program).args(args).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(UcError::Message(format!("{program} exited with {status}")))
    }
}

fn capture_command<I, S>(program: &str, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new(program).args(args).output()?;
    if !output.status.success() {
        return Err(UcError::Message(format!(
            "{program} exited with {}",
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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

fn parse_string_value(raw: &str) -> Result<String> {
    let value = raw.trim();
    if !(value.starts_with('"') && value.ends_with('"') && value.len() >= 2) {
        return Err(UcError::Message(format!(
            "expected quoted string, got: {value}"
        )));
    }
    Ok(value[1..value.len() - 1].replace("\\\"", "\""))
}

fn parse_bool_value(raw: &str) -> Result<bool> {
    match raw.trim() {
        "true" => Ok(true),
        "false" => Ok(false),
        value => Err(UcError::Message(format!("expected boolean, got: {value}"))),
    }
}

impl RemoteSpec {
    fn parse(input: &str) -> Result<Self> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(UcError::Message("remote cannot be empty".to_string()));
        }

        if let Some((target, root)) = split_remote_root(trimmed) {
            if target.is_empty() || root.is_empty() {
                return Err(UcError::Message(format!("invalid remote: {trimmed}")));
            }
            return Ok(Self {
                target: target.to_string(),
                root: root.to_string(),
            });
        }

        Ok(Self {
            target: trimmed.to_string(),
            root: DEFAULT_REMOTE_ROOT.to_string(),
        })
    }
}

fn split_remote_root(input: &str) -> Option<(&str, &str)> {
    let colon = input.find(':')?;
    let before = &input[..colon];
    let after = &input[colon + 1..];
    if before.contains('/') || after.is_empty() {
        return None;
    }
    Some((before, after))
}

impl Config {
    fn to_toml(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("remote = \"{}\"\n", escape_toml(&self.remote)));
        out.push_str(&format!(
            "remote_root = \"{}\"\n",
            escape_toml(&self.remote_root)
        ));
        out.push_str(&format!("host_id = \"{}\"\n", escape_toml(&self.host_id)));
        out.push_str(&format!(
            "search_agent = \"{}\"\n",
            escape_toml(&self.search_agent)
        ));
        out.push('\n');
        for source in &self.sources {
            out.push_str(&format!("[sources.{}]\n", source.agent));
            out.push_str(&format!("path = \"{}\"\n", escape_toml(&source.local_path)));
            out.push_str(&format!(
                "remote_leaf = \"{}\"\n",
                escape_toml(&source.remote_leaf)
            ));
            out.push_str(&format!("enabled = {}\n\n", source.enabled));
        }
        out
    }

    fn from_toml(raw: &str) -> Result<Self> {
        let mut remote = String::new();
        let mut remote_root = DEFAULT_REMOTE_ROOT.to_string();
        let mut host_id = String::new();
        let mut search_agent = DEFAULT_SEARCH_AGENT.to_string();
        let mut sources = Vec::<Source>::new();
        let mut current_source: Option<Source> = None;

        for line in raw.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }

            if line.starts_with('[') && line.ends_with(']') {
                if let Some(source) = current_source.take() {
                    sources.push(source);
                }
                let section = &line[1..line.len() - 1];
                let agent = section
                    .strip_prefix("sources.")
                    .ok_or_else(|| UcError::Message(format!("unsupported section: {section}")))?;
                current_source = Some(Source {
                    agent: agent.to_string(),
                    local_path: String::new(),
                    remote_leaf: String::new(),
                    enabled: true,
                });
                continue;
            }

            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| UcError::Message(format!("invalid config line: {line}")))?;
            let key = key.trim();
            let value = value.trim();

            if let Some(source) = current_source.as_mut() {
                match key {
                    "path" => source.local_path = parse_string_value(value)?,
                    "remote_leaf" => source.remote_leaf = parse_string_value(value)?,
                    "enabled" => source.enabled = parse_bool_value(value)?,
                    _ => return Err(UcError::Message(format!("unknown source key: {key}"))),
                }
                continue;
            }

            match key {
                "remote" => remote = parse_string_value(value)?,
                "remote_root" => remote_root = parse_string_value(value)?,
                "host_id" => host_id = parse_string_value(value)?,
                "search_agent" => search_agent = parse_string_value(value)?,
                _ => return Err(UcError::Message(format!("unknown config key: {key}"))),
            }
        }

        if let Some(source) = current_source.take() {
            sources.push(source);
        }

        if remote.is_empty() {
            return Err(UcError::Message("config missing remote".to_string()));
        }
        if host_id.is_empty() {
            return Err(UcError::Message("config missing host_id".to_string()));
        }

        for source in &sources {
            if source.local_path.is_empty() || source.remote_leaf.is_empty() {
                return Err(UcError::Message(format!(
                    "source {} is incomplete",
                    source.agent
                )));
            }
        }

        Ok(Self {
            remote,
            remote_root,
            host_id,
            search_agent,
            sources,
        })
    }
}

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_with_default_root() {
        assert_eq!(
            RemoteSpec::parse("user@example.com").unwrap(),
            RemoteSpec {
                target: "user@example.com".to_string(),
                root: "~/.ultracontext".to_string()
            }
        );
    }

    #[test]
    fn parses_remote_with_explicit_root() {
        assert_eq!(
            RemoteSpec::parse("user@example.com:/srv/uc").unwrap(),
            RemoteSpec {
                target: "user@example.com".to_string(),
                root: "/srv/uc".to_string()
            }
        );
    }

    #[test]
    fn sanitizes_host_id() {
        assert_eq!(
            sanitize_id("Fabio's MacBook Pro.local"),
            "fabio-s-macbook-pro-local"
        );
    }

    #[test]
    fn roundtrips_config() {
        let cfg = Config {
            remote: "fabio@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "fabio-macbook".to_string(),
            search_agent: "claude".to_string(),
            sources: vec![Source {
                agent: "claude".to_string(),
                local_path: "~/.claude/projects".to_string(),
                remote_leaf: "projects".to_string(),
                enabled: true,
            }],
        };

        assert_eq!(Config::from_toml(&cfg.to_toml()).unwrap(), cfg);
    }

    #[test]
    fn builds_remote_paths() {
        let cfg = Config {
            remote: "fabio@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "fabio-macbook".to_string(),
            search_agent: "claude".to_string(),
            sources: vec![],
        };
        let source = Source {
            agent: "codex".to_string(),
            local_path: "~/.codex/sessions".to_string(),
            remote_leaf: "sessions".to_string(),
            enabled: true,
        };

        assert_eq!(
            remote_dir(&cfg, &source),
            "~/.ultracontext/workspace/sessions/fabio-macbook/codex/sessions"
        );
    }

    #[test]
    fn quotes_remote_home_paths_without_blocking_tilde_expansion() {
        assert_eq!(
            remote_path_arg("~/.ultracontext/workspace"),
            "~/'.ultracontext/workspace'"
        );
        assert_eq!(
            remote_path_arg("/srv/Ultra Context"),
            "'/srv/Ultra Context'"
        );
    }
}
