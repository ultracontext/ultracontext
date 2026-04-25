use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const APP_DIR: &str = ".ultracontext";
const IGNORE_FILE: &str = ".ultracontextignore";
const DEFAULT_REMOTE_ROOT: &str = "~/.ultracontext";
const DEFAULT_SEARCH_COMMAND: &str = "claude";
const DEFAULT_SEARCH_ARGS: &str = "--dangerously-skip-permissions --effort medium --model sonnet";
const CONTEXT_ENGINEER_PROMPT: &str = include_str!("prompts/context-engineer.md");
const DEFAULT_SYNC_IGNORES: &[&str] = &[
    "node_modules/",
    ".git/",
    "target/",
    "dist/",
    "build/",
    ".next/",
    ".cache/",
];

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
    enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SearchConfig {
    command: String,
    args: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    remote: String,
    remote_root: String,
    host_id: String,
    search: SearchConfig,
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
        Some("source" | "sources") => cmd_source(&args[2..]),
        Some("search") => cmd_search(&args[2..]),
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
        "UltraContext {}\n\nUsage:\n  ultracontext init [local|user@host]\n  ultracontext sync <start|status|stop|reset>\n  ultracontext source <list|add|remove|enable|disable>\n  ultracontext search <query>\n  ultracontext doctor\n\nAlias:\n  uc should point to the same binary as ultracontext.\n",
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
                    "Usage: ultracontext init [local|user@host[:remote-root]] [--host-id <id>] [--remote-root <path>]"
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
        None => prompt("Workspace target (local or user@vps): ")?,
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
        search: SearchConfig {
            command: DEFAULT_SEARCH_COMMAND.to_string(),
            args: DEFAULT_SEARCH_ARGS.to_string(),
        },
        sources,
    };

    fs::create_dir_all(config_dir()?)?;
    if config.is_local() {
        fs::create_dir_all(expand_home(&config.remote_root)?)?;
    }
    fs::write(config_path()?, config.to_toml())?;
    ensure_ignore_file()?;

    prepare_remote_workspace(&config)?;

    println!("UltraContext initialized");
    println!("  config: {}", config_path()?.display());
    println!("  ignore: {}", ignore_path()?.display());
    println!("  remote: {}:{}", config.remote, config.remote_root);
    println!("  host:   {}", config.host_id);
    println!();
    println!("Next:");
    println!("  ultracontext sync start");
    println!("  ultracontext search \"what happened?\"");
    Ok(())
}

fn cmd_sync(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("start") => sync_start(),
        Some("status") => sync_status(),
        Some("stop") => sync_stop(),
        Some("reset") => sync_reset(),
        Some("-h" | "--help") | None => {
            println!("Usage: ultracontext sync <start|status|stop|reset>");
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!("unknown sync command: {command}"))),
    }
}

fn sync_start() -> Result<()> {
    require_command("mutagen")?;
    let config = load_config()?;
    prepare_remote_workspace(&config)?;
    ensure_ignore_file()?;

    let existing = capture_command("mutagen", ["sync", "list"])?;
    let ignore_patterns = sync_ignore_patterns()?;

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
        let args = sync_create_args(&name, &local_path, remote_endpoint, &ignore_patterns);
        run_command("mutagen", args)?;
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

fn sync_reset() -> Result<()> {
    require_command("mutagen")?;
    let config = load_config()?;
    let existing = capture_command("mutagen", ["sync", "list"])?;

    for name in owned_mutagen_session_names(&config, &existing) {
        if existing.contains(&format!("Name: {name}")) {
            println!("terminate {name}");
            run_command("mutagen", ["sync", "terminate", name.as_str()])?;
        }
    }

    sync_start()
}

fn cmd_source(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("list" | "ls") => source_list(),
        Some("add") => source_add(&args[1..]),
        Some("remove" | "rm") => source_remove(&args[1..]),
        Some("enable") => source_set_enabled(&args[1..], true),
        Some("disable") => source_set_enabled(&args[1..], false),
        Some("-h" | "--help") | None => {
            print_source_help();
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!(
            "unknown source command: {command}"
        ))),
    }
}

fn print_source_help() {
    println!(
        "Usage:\n  ultracontext source list\n  ultracontext source add <name> <path> [--disabled]\n  ultracontext source remove <name>\n  ultracontext source enable <name>\n  ultracontext source disable <name>\n\nSource names may contain letters, numbers, hyphens, and underscores."
    );
}

fn source_list() -> Result<()> {
    let config = load_config()?;
    if config.sources.is_empty() {
        println!("no sources configured");
        return Ok(());
    }

    for source in &config.sources {
        let state = if source.enabled {
            "enabled"
        } else {
            "disabled"
        };
        println!("{:<16} {:<8} {}", source.agent, state, source.local_path);
    }
    Ok(())
}

fn source_add(args: &[String]) -> Result<()> {
    let mut enabled = true;
    let mut positional = Vec::<&str>::new();

    for arg in args {
        match arg.as_str() {
            "--disabled" => enabled = false,
            "--enabled" => enabled = true,
            "-h" | "--help" => {
                println!("Usage: ultracontext source add <name> <path> [--disabled]");
                return Ok(());
            }
            value if value.starts_with('-') => {
                return Err(UcError::Message(format!(
                    "unknown source add option: {value}"
                )));
            }
            value => positional.push(value),
        }
    }

    if positional.len() != 2 {
        return Err(UcError::Message(
            "usage: ultracontext source add <name> <path> [--disabled]".to_string(),
        ));
    }

    let name = positional[0];
    let path = positional[1];
    validate_source_name(name)?;
    if path.trim().is_empty() {
        return Err(UcError::Message("source path cannot be empty".to_string()));
    }

    let mut config = load_config()?;
    let existed = upsert_source(&mut config, name, path, enabled)?;
    save_config(&config)?;

    if existed {
        println!("source {name}: updated");
    } else {
        println!("source {name}: added");
    }
    println!("Run `uc sync reset` to apply source changes.");
    Ok(())
}

fn source_remove(args: &[String]) -> Result<()> {
    let name = single_source_name_arg(args, "remove")?;
    let mut config = load_config()?;
    remove_source(&mut config, name)?;
    save_config(&config)?;

    println!("source {name}: removed");
    println!("Run `uc sync reset` to terminate old sync sessions.");
    Ok(())
}

fn source_set_enabled(args: &[String], enabled: bool) -> Result<()> {
    let action = if enabled { "enable" } else { "disable" };
    let name = single_source_name_arg(args, action)?;
    let mut config = load_config()?;
    set_source_enabled(&mut config, name, enabled)?;
    save_config(&config)?;

    println!("source {name}: {action}d");
    println!("Run `uc sync reset` to apply source changes.");
    Ok(())
}

fn single_source_name_arg<'a>(args: &'a [String], command: &str) -> Result<&'a str> {
    if args.len() != 1 || args[0] == "-h" || args[0] == "--help" {
        return Err(UcError::Message(format!(
            "usage: ultracontext source {command} <name>"
        )));
    }
    validate_source_name(&args[0])?;
    Ok(&args[0])
}

fn cmd_search(args: &[String]) -> Result<()> {
    if args.is_empty() || args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: ultracontext search <query>");
        return Ok(());
    }

    let config = load_config()?;
    let search_query = args.join(" ");
    let sessions_path = format!("{}/workspace/sessions", config.remote_root);
    let prompt = search_prompt(&sessions_path, &search_query);

    if config.is_local() {
        run_local_search(&config, &sessions_path, &prompt)
    } else {
        let remote_command = search_remote_command(&config, &sessions_path, &prompt);
        run_command(
            "ssh",
            ["-n", config.remote.as_str(), remote_command.as_str()],
        )
    }
}

fn search_remote_command(config: &Config, sessions_path: &str, prompt: &str) -> String {
    let command_setup = search_command_setup(config);
    format!(
        "{}; \
cd {} && \"$SEARCH_BIN\" -p {} {} < /dev/null",
        command_setup,
        remote_path_arg(&sessions_path),
        sh_quote(prompt),
        config.search.args
    )
}

fn run_local_search(config: &Config, sessions_path: &str, prompt: &str) -> Result<()> {
    let sessions_dir = expand_home(sessions_path)?;
    if !sessions_dir.exists() {
        return Err(UcError::Message(format!(
            "local sessions directory does not exist: {}",
            sessions_dir.display()
        )));
    }

    let command = resolve_local_search_command(&config.search.command)?;
    let args = shell_words(&config.search.args);
    let mut child = external_command(&command)
        .arg("-p")
        .arg(prompt)
        .args(args)
        .current_dir(sessions_dir)
        .stdin(Stdio::null())
        .spawn()?;
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(UcError::Message(format!(
            "{} exited with {}",
            command_display(&command, &["-p".to_string(), "<prompt>".to_string()]),
            status
        )))
    }
}

fn resolve_local_search_command(command: &str) -> Result<String> {
    if command.contains('/') {
        return Ok(command.to_string());
    }
    if command == "claude" {
        let local_bin = home_dir()?.join(".local/bin/claude");
        if local_bin.exists() {
            return Ok(local_bin.to_string_lossy().to_string());
        }
    }
    Ok(command.to_string())
}

fn search_command_setup(config: &Config) -> String {
    let command_setup = if config.search.command == "claude" {
        "SEARCH_BIN=$(command -v claude || true); \
if [ -z \"$SEARCH_BIN\" ] && [ -x \"$HOME/.local/bin/claude\" ]; then SEARCH_BIN=\"$HOME/.local/bin/claude\"; fi; \
if [ -z \"$SEARCH_BIN\" ]; then echo 'claude not found on remote PATH or ~/.local/bin/claude' >&2; exit 127; fi"
            .to_string()
    } else {
        format!(
            "SEARCH_BIN=$(command -v {} || true); \
if [ -z \"$SEARCH_BIN\" ]; then echo {} >&2; exit 127; fi",
            sh_quote(&config.search.command),
            sh_quote(&format!(
                "{} not found on remote PATH",
                config.search.command
            ))
        )
    };
    command_setup
}

fn cmd_doctor() -> Result<()> {
    let config = load_config().ok();

    match &config {
        Some(config) if config.is_local() => {
            check_local_command("mutagen");
        }
        _ => {
            check_local_command("ssh");
            check_local_command("scp");
            check_local_command("mutagen");
        }
    }

    if let Some(config) = config {
        println!("config: {}", config_path()?.display());
        println!("remote: {}:{}", config.remote, config.remote_root);
        println!("host: {}", config.host_id);

        if config.is_local() {
            check_local_workspace(&config);
            check_local_search_command(&config.search.command);
        } else {
            check_remote(&config, "ssh", "true");
            check_remote(
                &config,
                "remote workspace",
                &format!(
                    "test -d {}",
                    remote_path_arg(&format!("{}/workspace", config.remote_root))
                ),
            );
            check_remote(
                &config,
                &config.search.command,
                &format!("command -v {} >/dev/null", sh_quote(&config.search.command)),
            );
        }
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

    if config.is_local() {
        for dir in dirs {
            fs::create_dir_all(expand_home(&dir)?)?;
        }
        return Ok(());
    }

    let mkdirs = dirs
        .iter()
        .map(|dir| remote_path_arg(dir))
        .collect::<Vec<_>>()
        .join(" ");
    let command = format!("mkdir -p {mkdirs}");
    run_command("ssh", ["-n", config.remote.as_str(), command.as_str()])
}

fn search_prompt(sessions_path: &str, search_query: &str) -> String {
    CONTEXT_ENGINEER_PROMPT
        .replace("{{sessions_path}}", sessions_path)
        .replace("{{query}}", search_query)
}

fn default_sources() -> Vec<Source> {
    vec![
        Source {
            agent: "claude".to_string(),
            local_path: "~/.claude".to_string(),
            enabled: expand_home("~/.claude")
                .map(|p| p.exists())
                .unwrap_or(false),
        },
        Source {
            agent: "codex".to_string(),
            local_path: "~/.codex".to_string(),
            enabled: expand_home("~/.codex").map(|p| p.exists()).unwrap_or(false),
        },
    ]
}

fn enabled_sources(config: &Config) -> impl Iterator<Item = &Source> {
    config.sources.iter().filter(|source| source.enabled)
}

fn upsert_source(config: &mut Config, name: &str, path: &str, enabled: bool) -> Result<bool> {
    validate_source_name(name)?;
    if let Some(source) = config
        .sources
        .iter_mut()
        .find(|source| source.agent == name)
    {
        source.local_path = path.to_string();
        source.enabled = enabled;
        Ok(true)
    } else {
        config.sources.push(Source {
            agent: name.to_string(),
            local_path: path.to_string(),
            enabled,
        });
        Ok(false)
    }
}

fn remove_source(config: &mut Config, name: &str) -> Result<()> {
    validate_source_name(name)?;
    let before = config.sources.len();
    config.sources.retain(|source| source.agent != name);
    if config.sources.len() == before {
        return Err(UcError::Message(format!("source not found: {name}")));
    }
    Ok(())
}

fn set_source_enabled(config: &mut Config, name: &str, enabled: bool) -> Result<()> {
    validate_source_name(name)?;
    let source = config
        .sources
        .iter_mut()
        .find(|source| source.agent == name)
        .ok_or_else(|| UcError::Message(format!("source not found: {name}")))?;
    source.enabled = enabled;
    Ok(())
}

fn remote_dir(config: &Config, source: &Source) -> String {
    format!(
        "{}/workspace/sessions/{}/{}",
        config.remote_root, config.host_id, source.agent
    )
}

fn remote_endpoint(config: &Config, source: &Source) -> String {
    if config.is_local() {
        expand_home(&remote_dir(config, source))
            .unwrap_or_else(|_| PathBuf::from(remote_dir(config, source)))
            .to_string_lossy()
            .to_string()
    } else {
        format!("{}:{}", config.remote, remote_dir(config, source))
    }
}

fn mutagen_session_name(config: &Config, source: &Source) -> String {
    format!("uc-{}-{}", config.host_id, source.agent)
}

fn owned_mutagen_session_names(config: &Config, mutagen_list: &str) -> Vec<String> {
    let prefix = format!("uc-{}-", config.host_id);
    mutagen_list
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Name: "))
        .filter(|name| name.starts_with(&prefix))
        .map(ToString::to_string)
        .collect()
}

fn sync_create_args(
    name: &str,
    local_path: &Path,
    remote_endpoint: String,
    ignore_patterns: &[String],
) -> Vec<String> {
    let mut args = vec![
        "sync".to_string(),
        "create".to_string(),
        format!("--name={name}"),
        "--mode=one-way-replica".to_string(),
        "--symlink-mode=posix-raw".to_string(),
    ];
    for ignore in ignore_patterns {
        args.push(format!("--ignore={ignore}"));
    }
    args.push(local_path.to_string_lossy().to_string());
    args.push(remote_endpoint);
    args
}

fn sync_ignore_patterns() -> Result<Vec<String>> {
    let mut patterns = DEFAULT_SYNC_IGNORES
        .iter()
        .map(|pattern| pattern.to_string())
        .collect::<Vec<_>>();

    let path = ignore_path()?;
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|error| {
            UcError::Message(format!("failed to read {}: {error}", path.display()))
        })?;
        patterns.extend(parse_ignore_patterns(&raw));
    }

    Ok(patterns)
}

fn parse_ignore_patterns(raw: &str) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(ToString::to_string)
        .collect()
}

fn ensure_ignore_file() -> Result<()> {
    let path = ignore_path()?;
    if path.exists() {
        return Ok(());
    }
    fs::write(path, default_ignore_file())?;
    Ok(())
}

fn default_ignore_file() -> &'static str {
    "# UltraContext ignore file\n\
# Patterns use Mutagen's default ignore syntax and apply to every synced source.\n\
# Generated dependency/build/cache directories are ignored by default:\n\
# node_modules/\n\
# .git/\n\
# target/\n\
# dist/\n\
# build/\n\
# .next/\n\
# .cache/\n\
\n\
# Add extra ignore patterns below.\n"
}

fn config_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(APP_DIR))
}

fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

fn ignore_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(IGNORE_FILE))
}

fn save_config(config: &Config) -> Result<()> {
    fs::create_dir_all(config_dir()?)?;
    fs::write(config_path()?, config.to_toml())?;
    Ok(())
}

fn check_local_workspace(config: &Config) {
    match expand_home(&format!("{}/workspace", config.remote_root)) {
        Ok(path) if path.is_dir() => println!("local workspace: ok"),
        Ok(path) => println!("local workspace: missing ({})", path.display()),
        Err(error) => println!("local workspace: failed ({error})"),
    }
}

fn check_local_search_command(name: &str) {
    match resolve_local_search_command(name) {
        Ok(command) if command.contains('/') && Path::new(&command).is_file() => {
            println!("local {name}: ok ({command})")
        }
        Ok(command) if command.contains('/') => {
            println!("local {name}: missing ({command})")
        }
        Ok(command) => check_local_command(&command),
        Err(_) => println!("local {name}: missing"),
    }
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

fn validate_source_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(UcError::Message("source name cannot be empty".to_string()));
    }
    if name.len() > 64 {
        return Err(UcError::Message(format!("source name too long: {name}")));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return Err(UcError::Message(format!(
            "invalid source name: {name}. Use letters, numbers, hyphens, and underscores; start with a letter or number."
        )));
    }
    if !chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return Err(UcError::Message(format!(
            "invalid source name: {name}. Use letters, numbers, hyphens, and underscores."
        )));
    }
    Ok(())
}

fn require_value<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| UcError::Message(format!("missing value for {flag}")))
}

fn require_command(name: &str) -> Result<()> {
    let mut command = external_command("sh");
    let status = command
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
    let status = external_command("ssh")
        .arg("-n")
        .arg(&config.remote)
        .arg(command)
        .stdin(Stdio::null())
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
    let args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let status = external_command(program).args(&args).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(UcError::Message(format!(
            "{} exited with {}",
            command_display(program, &args),
            status
        )))
    }
}

fn capture_command<I, S>(program: &str, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let output = external_command(program).args(&args).output()?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(UcError::Message(format!(
            "{} exited with {}\nstdout:\n{}\nstderr:\n{}",
            command_display(program, &args),
            output.status,
            stdout.trim_end(),
            stderr.trim_end()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn shell_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (Some(_), c) => current.push(c),
            (None, '\'' | '"') => quote = Some(ch),
            (None, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (None, c) if c.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            (None, c) => current.push(c),
        }
    }

    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn external_command(program: &str) -> Command {
    let mut command = Command::new(program);
    if let Some(home) = env::var_os("ULTRACONTEXT_EXTERNAL_HOME") {
        command.env("HOME", home);
    }
    command
}

fn command_display(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string())
        .chain(args.iter().map(|arg| {
            if arg
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-_./:=@~".contains(ch))
            {
                arg.clone()
            } else {
                sh_quote(arg)
            }
        }))
        .collect::<Vec<_>>()
        .join(" ")
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
    fn is_local(&self) -> bool {
        self.remote == "local"
    }

    fn to_toml(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("remote = \"{}\"\n", escape_toml(&self.remote)));
        out.push_str(&format!(
            "remote_root = \"{}\"\n",
            escape_toml(&self.remote_root)
        ));
        out.push_str(&format!("host_id = \"{}\"\n", escape_toml(&self.host_id)));
        out.push('\n');
        out.push_str("[search]\n");
        out.push_str(&format!(
            "command = \"{}\"\n",
            escape_toml(&self.search.command)
        ));
        out.push_str(&format!("args = \"{}\"\n", escape_toml(&self.search.args)));
        out.push('\n');
        for source in &self.sources {
            out.push_str(&format!("[sources.{}]\n", source.agent));
            out.push_str(&format!("path = \"{}\"\n", escape_toml(&source.local_path)));
            out.push_str(&format!("enabled = {}\n\n", source.enabled));
        }
        out
    }

    fn from_toml(raw: &str) -> Result<Self> {
        let mut remote = String::new();
        let mut remote_root = DEFAULT_REMOTE_ROOT.to_string();
        let mut host_id = String::new();
        let mut search = SearchConfig {
            command: DEFAULT_SEARCH_COMMAND.to_string(),
            args: DEFAULT_SEARCH_ARGS.to_string(),
        };
        let mut sources = Vec::<Source>::new();
        let mut current_source: Option<Source> = None;
        let mut section = ConfigSection::Root;

        for line in raw.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }

            if line.starts_with('[') && line.ends_with(']') {
                if let Some(source) = current_source.take() {
                    sources.push(source);
                }
                let section_name = &line[1..line.len() - 1];
                if section_name == "search" {
                    section = ConfigSection::Search;
                } else if let Some(agent) = section_name.strip_prefix("sources.") {
                    validate_source_name(agent)?;
                    section = ConfigSection::Source;
                    current_source = Some(Source {
                        agent: agent.to_string(),
                        local_path: String::new(),
                        enabled: true,
                    });
                } else {
                    return Err(UcError::Message(format!(
                        "unsupported section: {section_name}"
                    )));
                }
                continue;
            }

            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| UcError::Message(format!("invalid config line: {line}")))?;
            let key = key.trim();
            let value = value.trim();

            match section {
                ConfigSection::Root => match key {
                    "remote" => remote = parse_string_value(value)?,
                    "remote_root" => remote_root = parse_string_value(value)?,
                    "host_id" => host_id = parse_string_value(value)?,
                    "search_agent" => search.command = parse_string_value(value)?,
                    "claude_args" => search.args = parse_string_value(value)?,
                    _ => return Err(UcError::Message(format!("unknown config key: {key}"))),
                },
                ConfigSection::Search => match key {
                    "command" => search.command = parse_string_value(value)?,
                    "args" => search.args = parse_string_value(value)?,
                    _ => return Err(UcError::Message(format!("unknown search key: {key}"))),
                },
                ConfigSection::Source => {
                    let source = current_source.as_mut().ok_or_else(|| {
                        UcError::Message("source key outside source section".to_string())
                    })?;
                    match key {
                        "path" => source.local_path = parse_string_value(value)?,
                        "remote_leaf" => {
                            let _ = parse_string_value(value)?;
                        }
                        "enabled" => source.enabled = parse_bool_value(value)?,
                        _ => return Err(UcError::Message(format!("unknown source key: {key}"))),
                    }
                }
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

        let sources = sources
            .into_iter()
            .map(normalize_legacy_source)
            .collect::<Vec<_>>();

        for source in &sources {
            validate_source_name(&source.agent)?;
            if source.local_path.is_empty() {
                return Err(UcError::Message(format!(
                    "source {} is incomplete",
                    source.agent
                )));
            }
        }
        let mut seen_sources = HashSet::new();
        for source in &sources {
            if !seen_sources.insert(source.agent.as_str()) {
                return Err(UcError::Message(format!(
                    "duplicate source: {}",
                    source.agent
                )));
            }
        }

        Ok(Self {
            remote,
            remote_root,
            host_id,
            search,
            sources,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConfigSection {
    Root,
    Search,
    Source,
}

fn normalize_legacy_source(mut source: Source) -> Source {
    match (source.agent.as_str(), source.local_path.as_str()) {
        ("claude", "~/.claude/projects") => source.local_path = "~/.claude".to_string(),
        ("codex", "~/.codex/sessions") => source.local_path = "~/.codex".to_string(),
        _ => {}
    }
    source
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
        assert_eq!(sanitize_id("User's Laptop.local"), "user-s-laptop-local");
    }

    #[test]
    fn roundtrips_config() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            search: SearchConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions --effort low".to_string(),
            },
            sources: vec![Source {
                agent: "claude".to_string(),
                local_path: "~/.claude".to_string(),
                enabled: true,
            }],
        };

        assert_eq!(Config::from_toml(&cfg.to_toml()).unwrap(), cfg);
    }

    #[test]
    fn builds_remote_paths() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            search: SearchConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
            sources: vec![],
        };
        let source = Source {
            agent: "codex".to_string(),
            local_path: "~/.codex".to_string(),
            enabled: true,
        };

        assert_eq!(
            remote_dir(&cfg, &source),
            "~/.ultracontext/workspace/sessions/work-laptop/codex"
        );
    }

    #[test]
    fn local_remote_uses_plain_filesystem_endpoint() {
        let cfg = Config {
            remote: "local".to_string(),
            remote_root: "/tmp/uc".to_string(),
            host_id: "mini".to_string(),
            search: SearchConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
            sources: vec![],
        };
        let source = Source {
            agent: "codex".to_string(),
            local_path: "~/.codex".to_string(),
            enabled: true,
        };

        assert!(cfg.is_local());
        assert_eq!(
            remote_endpoint(&cfg, &source),
            "/tmp/uc/workspace/sessions/mini/codex"
        );
    }

    #[test]
    fn validates_source_names_for_paths_and_session_names() {
        for name in ["openclaw", "agent_1", "agent-1", "a1"] {
            validate_source_name(name).unwrap();
        }

        for name in ["", ".hidden", "../bad", "bad/name", "bad name", "bad$name"] {
            assert!(validate_source_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn parses_custom_source_sections() {
        let raw = r#"
remote = "local"
remote_root = "~/.ultracontext"
host_id = "mini"

[sources.openclaw]
path = "~/.openclaw"
enabled = true

[sources.project_notes]
path = "~/notes"
enabled = false
"#;

        let cfg = Config::from_toml(raw).unwrap();

        assert_eq!(cfg.sources.len(), 2);
        assert_eq!(cfg.sources[0].agent, "openclaw");
        assert_eq!(cfg.sources[0].local_path, "~/.openclaw");
        assert!(cfg.sources[0].enabled);
        assert_eq!(cfg.sources[1].agent, "project_notes");
        assert!(!cfg.sources[1].enabled);
    }

    #[test]
    fn rejects_invalid_source_sections() {
        let raw = r#"
remote = "local"
remote_root = "~/.ultracontext"
host_id = "mini"

[sources.bad/name]
path = "~/.bad"
enabled = true
"#;

        assert!(Config::from_toml(raw).is_err());
    }

    #[test]
    fn updates_and_removes_sources() {
        let mut cfg = Config {
            remote: "local".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "mini".to_string(),
            search: SearchConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
            sources: vec![],
        };

        assert!(!upsert_source(&mut cfg, "openclaw", "~/.openclaw", true).unwrap());
        assert!(upsert_source(&mut cfg, "openclaw", "~/OpenClaw", false).unwrap());
        assert_eq!(cfg.sources.len(), 1);
        assert_eq!(cfg.sources[0].local_path, "~/OpenClaw");
        assert!(!cfg.sources[0].enabled);

        set_source_enabled(&mut cfg, "openclaw", true).unwrap();
        assert!(cfg.sources[0].enabled);
        remove_source(&mut cfg, "openclaw").unwrap();
        assert!(cfg.sources.is_empty());
    }

    #[test]
    fn finds_all_owned_mutagen_sessions_for_reset() {
        let cfg = Config {
            remote: "local".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "mini".to_string(),
            search: SearchConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
            sources: vec![],
        };
        let existing = "Name: uc-mini-claude\nName: uc-mini-oldsource\nName: uc-other-codex\n";

        assert_eq!(
            owned_mutagen_session_names(&cfg, existing),
            vec!["uc-mini-claude", "uc-mini-oldsource"]
        );
    }

    #[test]
    fn upgrades_legacy_session_only_sources() {
        let raw = r#"
remote = "user@vps"
remote_root = "~/.ultracontext"
host_id = "work-laptop"
search_agent = "claude"
claude_args = "--dangerously-skip-permissions --effort low"

[sources.claude]
path = "~/.claude/projects"
remote_leaf = "projects"
enabled = true

[sources.codex]
path = "~/.codex/sessions"
remote_leaf = "sessions"
enabled = true
"#;

        let cfg = Config::from_toml(raw).unwrap();

        assert_eq!(cfg.sources[0].local_path, "~/.claude");
        assert_eq!(cfg.sources[1].local_path, "~/.codex");
        assert_eq!(cfg.search.command, "claude");
        assert_eq!(
            cfg.search.args,
            "--dangerously-skip-permissions --effort low"
        );
    }

    #[test]
    fn renders_context_engineer_prompt_from_template() {
        let prompt = search_prompt("/remote/workspace/sessions", "what changed?");

        assert!(prompt.contains("/remote/workspace/sessions"));
        assert!(prompt.contains("what changed?"));
        assert!(prompt.contains("internal event timestamps"));
        assert!(prompt.contains("subagents"));
        assert!(!prompt.contains("{{sessions_path}}"));
        assert!(!prompt.contains("{{query}}"));
    }

    #[test]
    fn uses_configured_search_command_and_args() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            search: SearchConfig {
                command: "custom-search".to_string(),
                args: "--dangerously-skip-permissions --effort low --model sonnet".to_string(),
            },
            sources: vec![],
        };

        let command = search_remote_command(&cfg, "~/.ultracontext/workspace/sessions", "prompt");

        assert!(command.contains("command -v 'custom-search'"), "{command}");
        assert!(
            command.contains("--dangerously-skip-permissions --effort low --model sonnet"),
            "{command}"
        );
    }

    #[test]
    fn splits_search_args_for_local_execution() {
        assert_eq!(
            shell_words("--dangerously-skip-permissions --model 'sonnet 4' --effort low"),
            vec![
                "--dangerously-skip-permissions",
                "--model",
                "sonnet 4",
                "--effort",
                "low"
            ]
        );
    }

    #[test]
    fn search_section_overrides_legacy_search_keys() {
        let raw = r#"
remote = "user@vps"
remote_root = "~/.ultracontext"
host_id = "work-laptop"
search_agent = "claude"
claude_args = "--dangerously-skip-permissions"

[search]
command = "custom-search"
args = "--custom-flag"
"#;

        let cfg = Config::from_toml(raw).unwrap();

        assert_eq!(cfg.search.command, "custom-search");
        assert_eq!(cfg.search.args, "--custom-flag");
    }

    #[test]
    fn defaults_search_config_when_missing() {
        let raw = r#"
remote = "user@vps"
remote_root = "~/.ultracontext"
host_id = "work-laptop"
"#;

        let cfg = Config::from_toml(raw).unwrap();

        assert_eq!(cfg.search.command, "claude");
        assert_eq!(
            cfg.search.args,
            "--dangerously-skip-permissions --effort medium --model sonnet"
        );
    }

    #[test]
    fn parses_search_section() {
        let raw = r#"
remote = "user@vps"
remote_root = "~/.ultracontext"
host_id = "work-laptop"

[search]
command = "custom-search"
args = "--fast"
"#;

        let cfg = Config::from_toml(raw).unwrap();

        assert_eq!(cfg.search.command, "custom-search");
        assert_eq!(cfg.search.args, "--fast");
        assert_eq!(
            cfg.to_toml(),
            "remote = \"user@vps\"\nremote_root = \"~/.ultracontext\"\nhost_id = \"work-laptop\"\n\n[search]\ncommand = \"custom-search\"\nargs = \"--fast\"\n\n"
        );
    }

    #[test]
    fn keeps_claude_path_fallback_for_default_search_command() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            search: SearchConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
            sources: vec![],
        };

        let command = search_remote_command(&cfg, "~/.ultracontext/workspace/sessions", "prompt");

        assert!(command.contains("$HOME/.local/bin/claude"), "{command}");
    }

    #[test]
    fn parses_ultracontextignore_patterns() {
        let patterns = parse_ignore_patterns(
            r#"
# comment
node_modules/

scratch-cache/
dist/
"#,
        );

        assert_eq!(patterns, vec!["node_modules/", "scratch-cache/", "dist/"]);
    }

    #[test]
    fn sync_create_args_include_generated_ignores_without_secret_ignores() {
        let local_path = PathBuf::from("/tmp/source");
        let ignore_patterns = DEFAULT_SYNC_IGNORES
            .iter()
            .map(|pattern| pattern.to_string())
            .collect::<Vec<_>>();

        let args = sync_create_args(
            "uc-test-codex",
            &local_path,
            "user@vps:~/.ultracontext/workspace/sessions/test/codex".to_string(),
            &ignore_patterns,
        );

        assert!(args.contains(&"--ignore=node_modules/".to_string()));
        assert!(args.contains(&"--ignore=.git/".to_string()));
        assert!(!args.contains(&"--ignore=.env".to_string()));
        assert!(!args.contains(&"--ignore=auth.json".to_string()));
        assert_eq!(args[args.len() - 2], "/tmp/source");
    }

    #[test]
    fn search_command_does_not_read_stdin() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            search: SearchConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
            sources: vec![],
        };

        let command = search_remote_command(&cfg, "~/.ultracontext/workspace/sessions", "prompt");

        assert!(command.ends_with("< /dev/null"), "{command}");
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
