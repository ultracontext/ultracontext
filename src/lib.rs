use console::{Key, Term, style};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsStr;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, Once};
use std::time::{SystemTime, UNIX_EPOCH};

const APP_DIR: &str = ".ultracontext";
const IGNORE_FILE: &str = ".ultracontextignore";
const IGNORES_DIR: &str = "ignores";
const DEFAULT_REMOTE_ROOT: &str = "~/.ultracontext";
const ULTRACONTEXT_SKILL: &str = include_str!("../skills/ultracontext/SKILL.md");
const INSTALL_URL: &str = "https://ultracontext.com/install.sh";
// Ignore patterns live under ~/.ultracontext/ignores:
// - .ultracontextignore for global rules
// - <source>/.ultracontextignore for source-specific rules
const DEFAULT_SYNC_IGNORES: &[&str] = &[];

static CLICLACK_THEME: Once = Once::new();
static PROMPT_HINT: Mutex<Option<&'static str>> = Mutex::new(None);

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KnownSource {
    agent: &'static str,
    label: &'static str,
    path: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    remote: String,
    remote_root: String,
    host_id: String,
    sources: Vec<Source>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteSpec {
    target: String,
    root: String,
}

struct SelectOption<T> {
    value: T,
    label: String,
    hint: String,
    disabled: bool,
}

struct MultiOption {
    value: String,
    label: String,
    hint: String,
}

#[derive(Debug, PartialEq, Eq)]
enum PromptFlow<T> {
    Next(T),
    Back,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteMode {
    SelfHosted,
    Back,
}

pub fn main_entry() {
    setup_cliclack_theme();
    if let Err(error) = run(env::args().collect()) {
        ui_error(format!("error: {error}"));
        std::process::exit(1);
    }
}

struct UcTheme;

impl cliclack::Theme for UcTheme {
    fn format_footer(&self, state: &cliclack::ThemeState) -> String {
        self.format_footer_with_message(state, "")
    }

    fn format_footer_with_message(&self, state: &cliclack::ThemeState, message: &str) -> String {
        match state {
            cliclack::ThemeState::Active => {
                let hint = if message.is_empty() {
                    current_prompt_hint().unwrap_or("")
                } else {
                    message
                };
                if hint.is_empty() {
                    "└\n".to_string()
                } else {
                    format!("│\n└  {hint}\n")
                }
            }
            cliclack::ThemeState::Cancel => "└  Operation cancelled.\n".to_string(),
            cliclack::ThemeState::Submit => "│\n".to_string(),
            cliclack::ThemeState::Error(error) => format!("└  {error}\n"),
        }
    }
}

fn setup_cliclack_theme() {
    CLICLACK_THEME.call_once(|| {
        cliclack::set_theme(UcTheme);
    });
}

fn current_prompt_hint() -> Option<&'static str> {
    PROMPT_HINT.lock().ok().and_then(|hint| *hint)
}

fn with_prompt_hint<T>(
    hint: &'static str,
    prompt: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    if let Ok(mut current) = PROMPT_HINT.lock() {
        *current = Some(hint);
    }
    let result = prompt();
    if let Ok(mut current) = PROMPT_HINT.lock() {
        *current = None;
    }
    result
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
        Some("event" | "events") => cmd_event(&args[2..]),
        Some("driver" | "drivers") => cmd_driver(&args[2..]),
        Some("status") => cmd_status(&args[2..]),
        Some("doctor") => cmd_doctor(),
        Some("update") => cmd_update(&args[2..]),
        Some("__refresh-runtime-assets") => refresh_runtime_assets(),
        Some("version" | "-V" | "--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!("unknown command: {command}"))),
    }
}

fn print_help() {
    println!(
        "UltraContext {}\n\nUsage:\n  uc init [local|user@host]\n  uc status\n  uc sync <start|list|status|stop|reset>\n  uc source <list|add|remove|enable|disable>\n  uc event <emit|commit|tail|flush|status>\n  uc driver <list|run>\n  uc doctor\n  uc update\n",
        env!("CARGO_PKG_VERSION")
    );
}

fn fancy_ui() -> bool {
    io::stderr().is_terminal()
        && env::var_os("ULTRACONTEXT_PLAIN").is_none()
        && env::var_os("CI").is_none()
}

fn can_prompt() -> bool {
    fancy_ui() && io::stdin().is_terminal()
}

fn ui_intro(message: impl fmt::Display) {
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::intro(message);
    } else {
        println!("{message}");
    }
}

fn ui_outro(message: impl fmt::Display) {
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::outro(message);
    } else {
        println!("{message}");
    }
}

fn ui_note(title: impl fmt::Display, message: impl fmt::Display) {
    let title = title.to_string();
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::note(title, message);
    } else {
        println!("{title}");
        println!("{message}");
    }
}

fn ui_info(message: impl fmt::Display) {
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::log::info(message);
    } else {
        println!("{message}");
    }
}

fn ui_step(message: impl fmt::Display) {
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::log::step(message);
    } else {
        println!("{message}");
    }
}

fn ui_success(message: impl fmt::Display) {
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::log::success(message);
    } else {
        println!("{message}");
    }
}

fn ui_warn(message: impl fmt::Display) {
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::log::warning(message);
    } else {
        println!("{message}");
    }
}

fn ui_error(message: impl fmt::Display) {
    let message = message.to_string();
    if fancy_ui() {
        let _ = cliclack::log::error(message);
    } else {
        eprintln!("{message}");
    }
}

fn cmd_init(args: &[String]) -> Result<()> {
    let mut remote_arg: Option<String> = None;
    let mut host_id_arg: Option<String> = None;
    let mut remote_root_arg: Option<String> = None;
    let mut sync_arg: Option<bool> = None;
    let mut yes = false;

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
            "--sync" => sync_arg = Some(true),
            "--no-sync" => sync_arg = Some(false),
            "-y" | "--yes" => yes = true,
            "-h" | "--help" => {
                print_init_help();
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

    let interactive = can_prompt() && !yes;
    let existing_config = load_config().ok();
    let mut reconfigure_defaults: Option<Config> = None;

    let has_config_args =
        remote_arg.is_some() || host_id_arg.is_some() || remote_root_arg.is_some();
    let mut intro_printed = false;

    if existing_config.is_some() {
        if has_config_args {
            reconfigure_defaults = existing_config.clone();
        } else {
            if interactive {
                ui_intro("UltraContext setup");
                intro_printed = true;
                ui_info(format!("config: {}", config_path()?.display()));
                let action =
                    cliclack::select("UltraContext is already set up here. What should we do?")
                        .initial_value("reconfigure")
                        .item(
                            "reconfigure",
                            "Reconfigure",
                            "choose workspace and agents again",
                        )
                        .item("quit", "Quit", "")
                        .interact()?;
                if action == "quit" {
                    ui_outro("Setup unchanged");
                    return Ok(());
                }
                reconfigure_defaults = existing_config.clone();
            } else {
                setup_existing(sync_arg, interactive)?;
                return Ok(());
            }
        }
    }

    if !intro_printed {
        ui_intro("UltraContext setup");
    }

    let (remote_input, sources) = if interactive && remote_arg.is_none() {
        let source_defaults = setup_source_defaults(reconfigure_defaults.as_ref());
        loop {
            let remote_input = prompt_workspace_target(reconfigure_defaults.as_ref())?;
            match prompt_sources(
                source_defaults.clone(),
                reconfigure_defaults.as_ref().map(configured_source_names),
            )? {
                PromptFlow::Next(sources) => break (remote_input, sources),
                PromptFlow::Back => continue,
            }
        }
    } else {
        let remote_input = match remote_arg {
            Some(value) => value,
            None => {
                return Err(UcError::Message(
                    "usage: uc init [local|user@host]".to_string(),
                ));
            }
        };
        (
            remote_input,
            noninteractive_init_sources(reconfigure_defaults.as_ref()),
        )
    };

    let mut remote = RemoteSpec::parse(&remote_input)?;
    if let Some(remote_root) = remote_root_arg {
        remote.root = remote_root;
    } else if let Some(config) = reconfigure_defaults
        .as_ref()
        .filter(|config| config.remote == remote.target)
    {
        remote.root = config.remote_root.clone();
    }

    let host_id = host_id_arg.unwrap_or_else(|| {
        reconfigure_defaults
            .as_ref()
            .map(|config| config.host_id.clone())
            .unwrap_or_else(default_host_id)
    });

    if let Some(previous) = reconfigure_defaults.as_ref() {
        prepare_reconfigured_workspace(previous, &remote, &host_id)?;
    }

    let config = setup_task("Configure workspace", "Workspace configured", || {
        initialize_config(remote, host_id, sources)
    })?;

    setup_install_skill()?;

    let start_sync = sync_arg.unwrap_or_else(|| {
        if interactive {
            confirm_default("Start sync now?", true).unwrap_or(true)
        } else {
            true
        }
    });
    if start_sync {
        setup_start_sync()?;
    }

    finish_setup()?;
    let _ = config;
    Ok(())
}

fn setup_existing(sync_arg: Option<bool>, interactive: bool) -> Result<()> {
    setup_install_skill()?;
    let start_sync = sync_arg.unwrap_or_else(|| {
        if interactive {
            confirm_default("Start or resume sync now?", true).unwrap_or(true)
        } else {
            true
        }
    });
    if start_sync {
        setup_start_sync()?;
    }
    finish_setup()
}

fn finish_setup() -> Result<()> {
    cmd_status(&[])?;
    ui_note(
        "Next",
        "Open Codex and ask: \"what was the last thing Claude did?\"",
    );
    ui_outro("UltraContext is ready");
    Ok(())
}

fn print_init_help() {
    println!(
        "Usage: uc init [local|user@host] [--host-id <id>] [--remote-root <path>] [--no-sync] [--yes]"
    );
}

fn prompt_workspace_target(defaults: Option<&Config>) -> Result<String> {
    loop {
        let initial_target = defaults
            .map(|config| if config.is_local() { "local" } else { "remote" })
            .unwrap_or("remote");
        let target = with_prompt_hint("[↑/↓] move [enter] select", || {
            cliclack::select("Where should your UltraContext live?")
                .initial_value(initial_target)
                .item(
                    "remote",
                    "Remote (recommended)",
                    "shared across all machines",
                )
                .item("local", "Local", "this machine only")
                .interact()
        })?;

        if target == "local" {
            return Ok("local".to_string());
        }

        match prompt_remote_mode()? {
            RemoteMode::SelfHosted => {
                let mut prompt = cliclack::input("SSH target").placeholder("user@vps");
                if let Some(config) = defaults.filter(|config| !config.is_local()) {
                    prompt = prompt.default_input(&config.remote);
                }
                return Ok(prompt.interact()?);
            }
            RemoteMode::Back => {}
        }
    }
}

fn prompt_remote_mode() -> Result<RemoteMode> {
    let options = vec![
        SelectOption {
            value: RemoteMode::SelfHosted,
            label: "UltraContext Cloud".to_string(),
            hint: "coming soon".to_string(),
            disabled: true,
        },
        SelectOption {
            value: RemoteMode::SelfHosted,
            label: "Self-hosted VPS".to_string(),
            hint: "use your own SSH server".to_string(),
            disabled: false,
        },
    ];

    match keyboard_select(
        "How do you want to run the remote workspace?",
        &options,
        RemoteMode::SelfHosted,
        "[↑/↓] move [enter] select [←] back",
    )? {
        PromptFlow::Next(mode) => Ok(mode),
        PromptFlow::Back => Ok(RemoteMode::Back),
    }
}

fn prompt_sources(
    mut sources: Vec<Source>,
    initial: Option<Vec<String>>,
) -> Result<PromptFlow<Vec<Source>>> {
    let selected = match prompt_agent_multiselect(&sources, initial)? {
        PromptFlow::Next(selected) => selected,
        PromptFlow::Back => return Ok(PromptFlow::Back),
    };

    sources.retain(|source| selected.contains(&source.agent));
    for source in &mut sources {
        source.enabled = source_path_exists(&source.local_path);
    }
    Ok(PromptFlow::Next(sources))
}

fn prompt_agent_multiselect(
    sources: &[Source],
    initial: Option<Vec<String>>,
) -> Result<PromptFlow<Vec<String>>> {
    let mut initial = initial.unwrap_or_else(|| {
        sources
            .iter()
            .filter(|source| source_path_exists(&source.local_path))
            .map(|source| source.agent.clone())
            .collect::<Vec<_>>()
    });
    if initial.is_empty() {
        initial = sources.iter().map(|source| source.agent.clone()).collect();
    }

    let options = sources
        .iter()
        .map(|source| {
            let known = known_source(source.agent.as_str());
            let label = known
                .map(|source| source.label)
                .unwrap_or(source.agent.as_str());
            let hint = if source_path_exists(&source.local_path) {
                "detected".to_string()
            } else {
                format!("missing: {}", source.local_path)
            };
            MultiOption {
                value: source.agent.clone(),
                label: label.to_string(),
                hint,
            }
        })
        .collect::<Vec<_>>();

    keyboard_multiselect(
        "Which agents should UltraContext configure here?",
        &options,
        initial,
        "[↑/↓] move [space] toggle [enter] continue [←] back",
    )
}

fn keyboard_select<T>(
    prompt: &str,
    options: &[SelectOption<T>],
    initial: T,
    footer: &str,
) -> Result<PromptFlow<T>>
where
    T: Clone + PartialEq,
{
    if options.is_empty() {
        return Err(UcError::Message("select prompt has no options".to_string()));
    }
    let mut cursor = initial_select_cursor(options, &initial);
    let mut term = Term::stderr();
    term.hide_cursor()?;
    let result = (|| -> io::Result<PromptFlow<T>> {
        let mut previous_lines = 0;
        loop {
            let frame = render_keyboard_select(prompt, options, cursor, footer, false);
            redraw_keyboard_prompt(&mut term, &mut previous_lines, &frame)?;

            match term.read_key()? {
                Key::ArrowLeft => {
                    term.clear_last_lines(previous_lines)?;
                    return Ok(PromptFlow::Back);
                }
                Key::ArrowUp | Key::Char('k') => cursor = move_select_cursor(options, cursor, -1),
                Key::ArrowDown | Key::ArrowRight | Key::Char('j') => {
                    cursor = move_select_cursor(options, cursor, 1)
                }
                Key::Enter if !options[cursor].disabled => {
                    let frame = render_keyboard_select(prompt, options, cursor, footer, true);
                    redraw_keyboard_prompt(&mut term, &mut previous_lines, &frame)?;
                    return Ok(PromptFlow::Next(options[cursor].value.clone()));
                }
                _ => {}
            }
        }
    })();
    term.show_cursor()?;
    Ok(result?)
}

fn keyboard_multiselect(
    prompt: &str,
    options: &[MultiOption],
    initial: Vec<String>,
    footer: &str,
) -> Result<PromptFlow<Vec<String>>> {
    if options.is_empty() {
        return Ok(PromptFlow::Next(Vec::new()));
    }

    let mut cursor = 0;
    let mut selected = initial.into_iter().collect::<HashSet<_>>();
    let mut term = Term::stderr();
    term.hide_cursor()?;
    let result = (|| -> io::Result<PromptFlow<Vec<String>>> {
        let mut previous_lines = 0;
        loop {
            let frame =
                render_keyboard_multiselect(prompt, options, cursor, &selected, footer, false);
            redraw_keyboard_prompt(&mut term, &mut previous_lines, &frame)?;

            match term.read_key()? {
                Key::ArrowLeft => {
                    term.clear_last_lines(previous_lines)?;
                    return Ok(PromptFlow::Back);
                }
                Key::ArrowUp | Key::Char('k') => {
                    cursor = cursor.saturating_sub(1);
                }
                Key::ArrowDown | Key::ArrowRight | Key::Char('j') if cursor + 1 < options.len() => {
                    cursor += 1;
                }
                Key::Char(' ') => {
                    let value = options[cursor].value.clone();
                    if !selected.insert(value.clone()) {
                        selected.remove(&value);
                    }
                }
                Key::Enter => {
                    let frame = render_keyboard_multiselect(
                        prompt, options, cursor, &selected, footer, true,
                    );
                    redraw_keyboard_prompt(&mut term, &mut previous_lines, &frame)?;
                    let values = options
                        .iter()
                        .filter(|option| selected.contains(&option.value))
                        .map(|option| option.value.clone())
                        .collect();
                    return Ok(PromptFlow::Next(values));
                }
                _ => {}
            }
        }
    })();
    term.show_cursor()?;
    Ok(result?)
}

fn redraw_keyboard_prompt(
    term: &mut Term,
    previous_lines: &mut usize,
    frame: &str,
) -> io::Result<()> {
    if *previous_lines > 0 {
        term.clear_last_lines(*previous_lines)?;
    }
    term.write_all(frame.as_bytes())?;
    term.flush()?;
    *previous_lines = frame.lines().count();
    Ok(())
}

fn initial_select_cursor<T: PartialEq>(options: &[SelectOption<T>], initial: &T) -> usize {
    options
        .iter()
        .position(|option| !option.disabled && option.value == *initial)
        .or_else(|| options.iter().position(|option| !option.disabled))
        .unwrap_or(0)
}

fn move_select_cursor<T>(options: &[SelectOption<T>], cursor: usize, direction: isize) -> usize {
    let mut next = cursor as isize + direction;
    while next >= 0 && (next as usize) < options.len() {
        let index = next as usize;
        if !options[index].disabled {
            return index;
        }
        next += direction;
    }
    cursor
}

fn render_keyboard_select<T>(
    prompt: &str,
    options: &[SelectOption<T>],
    cursor: usize,
    footer: &str,
    submitted: bool,
) -> String {
    let mut out = format!("◇  {prompt}\n");
    for (index, option) in options.iter().enumerate() {
        if submitted && index != cursor {
            continue;
        }
        let selected = index == cursor;
        let marker = if selected { "●" } else { "○" };
        let label = if option.disabled {
            style(&option.label).dim().to_string()
        } else {
            option.label.clone()
        };
        let hint = if option.hint.is_empty() {
            String::new()
        } else if option.disabled || selected && !submitted {
            format!(" {}", style(format!("({})", option.hint)).dim())
        } else {
            String::new()
        };
        out.push_str(&format!("│  {marker} {label}{hint}\n"));
    }
    if submitted {
        out.push_str("│\n");
    } else {
        out.push_str(&format!("│\n└  {footer}\n"));
    }
    out
}

fn render_keyboard_multiselect(
    prompt: &str,
    options: &[MultiOption],
    cursor: usize,
    selected: &HashSet<String>,
    footer: &str,
    submitted: bool,
) -> String {
    let mut out = format!("◇  {prompt}\n");
    for (index, option) in options.iter().enumerate() {
        let is_selected = selected.contains(&option.value);
        if submitted && !is_selected {
            continue;
        }
        let marker = if is_selected { "■" } else { "□" };
        let hint = if !submitted && index == cursor && !option.hint.is_empty() {
            format!(" {}", style(format!("({})", option.hint)).dim())
        } else {
            String::new()
        };
        out.push_str(&format!("│  {marker} {}{hint}\n", option.label));
    }
    if submitted {
        out.push_str("│\n");
    } else {
        out.push_str(&format!("│\n└  {footer}\n"));
    }
    out
}

fn confirm_default(message: &str, default: bool) -> Result<bool> {
    Ok(cliclack::confirm(message)
        .initial_value(default)
        .interact()?)
}

fn setup_install_skill() -> Result<()> {
    if env::var("ULTRACONTEXT_INSTALL_SKILL").ok().as_deref() == Some("0") {
        ui_info("agent skill: skipped");
        return Ok(());
    }
    let installed = setup_task(
        "Install agent skill",
        "Agent skill installed",
        install_agent_skills,
    )?;
    for path in installed {
        ui_info(format!("skill: {}", path.display()));
    }
    Ok(())
}

fn setup_start_sync() -> Result<()> {
    setup_task("Start sync", "Sync started", || sync_start(&[]))
}

fn setup_task<T, F>(start: &str, success: &str, task: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    if fancy_ui() {
        let spinner = cliclack::spinner();
        spinner.start(start);
        match task() {
            Ok(value) => {
                spinner.stop(success);
                Ok(value)
            }
            Err(error) => {
                spinner.error(format!("{start} failed"));
                Err(error)
            }
        }
    } else {
        ui_step(start);
        let value = task()?;
        ui_success(success);
        Ok(value)
    }
}

fn initialize_config(remote: RemoteSpec, host_id: String, sources: Vec<Source>) -> Result<Config> {
    let config = Config {
        remote: remote.target,
        remote_root: remote.root,
        host_id,
        sources,
    };

    fs::create_dir_all(config_dir()?)?;
    if config.is_local() {
        fs::create_dir_all(expand_home(&config.remote_root)?)?;
    }
    fs::write(config_path()?, config.to_toml())?;
    ensure_ignore_file()?;
    ensure_source_ignore_files(&config.sources)?;
    prepare_remote_workspace(&config)?;
    Ok(config)
}

fn cmd_sync(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("start") => sync_start(&args[1..]),
        Some("list" | "ls") => sync_list(&args[1..]),
        Some("status") => sync_status(&args[1..]),
        Some("stop" | "pause") => sync_stop(&args[1..]),
        Some("remove" | "rm" | "terminate") => sync_remove_removed(&args[1..]),
        Some("reset") => sync_reset(&args[1..]),
        Some("-h" | "--help") | None => {
            println!("Usage: uc sync <start|list|status|stop|reset>");
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!("unknown sync command: {command}"))),
    }
}

fn sync_start(args: &[String]) -> Result<()> {
    if sync_help(args, "Usage: uc sync start") {
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message(
            "`uc sync start` starts all enabled sources. Use `uc source enable <name>` to resume one source.".to_string(),
        ));
    }

    require_command("mutagen")?;
    let config = load_config()?;
    ensure_ignore_file()?;
    ensure_source_ignore_files(&config.sources)?;

    let existing = capture_command("mutagen", ["sync", "list"])?;
    prepare_remote_workspace(&config)?;

    for source in enabled_sources(&config) {
        sync_start_source(&config, source, &existing)?;
    }

    Ok(())
}

fn sync_list(args: &[String]) -> Result<()> {
    if sync_help(args, "Usage: uc sync list") {
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message("usage: uc sync list".to_string()));
    }

    require_command("mutagen")?;
    let config = load_config()?;
    let output = capture_command("mutagen", ["sync", "list"])?;
    let entries = sync_list_entries(&config, &output);

    if entries.is_empty() {
        println!("No sync sources configured. Run `uc init`.");
        return Ok(());
    }

    for (i, entry) in entries.iter().enumerate() {
        if i > 0 {
            println!();
        }
        render_sync_list_entry(entry);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncListEntry {
    source: String,
    source_state: String,
    session: String,
    sync_state: String,
    local_path: Option<String>,
    remote_endpoint: Option<String>,
}

fn sync_list_entries(config: &Config, mutagen_list: &str) -> Vec<SyncListEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    for source in &config.sources {
        let session = mutagen_session_name(config, source);
        seen.insert(session.clone());
        let source_state = if source.enabled {
            "enabled"
        } else {
            "disabled"
        };
        let sync_state =
            mutagen_session_status(mutagen_list, &session).unwrap_or_else(|| "missing".to_string());
        entries.push(SyncListEntry {
            source: source.agent.clone(),
            source_state: source_state.to_string(),
            session,
            sync_state,
            local_path: Some(source.local_path.clone()),
            remote_endpoint: Some(remote_endpoint(config, source)),
        });
    }

    for session in owned_mutagen_session_names(config, mutagen_list) {
        if seen.contains(&session) {
            continue;
        }
        let source = short_source_name(&session);
        let sync_state =
            mutagen_session_status(mutagen_list, &session).unwrap_or_else(|| "unknown".to_string());
        entries.push(SyncListEntry {
            source: source.to_string(),
            source_state: "orphan".to_string(),
            session,
            sync_state,
            local_path: None,
            remote_endpoint: None,
        });
    }

    entries
}

fn render_sync_list_entry(entry: &SyncListEntry) {
    let (color, glyph) = sync_list_entry_style(entry);
    println!(
        "{} {}  {}  {}",
        style(glyph).fg(color),
        style(&entry.source).bold(),
        style(&entry.sync_state).fg(color),
        style(&entry.source_state).dim()
    );
    println!("  session {}", style(&entry.session).dim());

    if let (Some(local), Some(remote)) = (&entry.local_path, &entry.remote_endpoint) {
        println!("  {}  →  {}", style(local).dim(), style(remote).dim());
    }
}

fn sync_list_entry_style(entry: &SyncListEntry) -> (console::Color, &'static str) {
    let state = entry.source_state.to_lowercase();
    if state == "disabled" {
        return (console::Color::Yellow, "⏸");
    }
    if state == "orphan" {
        return (console::Color::White, "·");
    }
    if entry.sync_state.eq_ignore_ascii_case("missing") {
        return (console::Color::Red, "✗");
    }
    status_style(&entry.sync_state)
}

fn sync_status(args: &[String]) -> Result<()> {
    if sync_help(args, "Usage: uc sync status") {
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message("usage: uc sync status".to_string()));
    }

    require_command("mutagen")?;
    let output = capture_command("mutagen", ["sync", "list", "--long"])?;
    let sessions = parse_mutagen_sessions(&output);

    if sessions.is_empty() {
        println!("No sync sessions. Run `uc sync start`.");
        return Ok(());
    }

    for (i, s) in sessions.iter().enumerate() {
        if i > 0 {
            println!();
        }
        render_session(s);
    }
    Ok(())
}

#[derive(Debug, Default, Clone)]
struct SessionInfo {
    name: String,
    alpha_url: String,
    beta_url: String,
    alpha_files: Option<u64>,
    beta_files: Option<u64>,
    alpha_size: String,
    beta_size: String,
    alpha_connected: bool,
    beta_connected: bool,
    status: String,
    progress_pct: Option<u8>,
    transition_problems: Vec<String>,
}

fn parse_mutagen_sessions(out: &str) -> Vec<SessionInfo> {
    let mut sessions = Vec::new();
    let mut cur: Option<SessionInfo> = None;
    let mut side: Option<&'static str> = None;
    let mut in_transition_problems = false;

    for raw in out.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();

        if let Some(name) = trimmed.strip_prefix("Name: ") {
            if let Some(s) = cur.take() {
                sessions.push(s);
            }
            cur = Some(SessionInfo {
                name: name.to_string(),
                ..Default::default()
            });
            side = None;
            in_transition_problems = false;
            continue;
        }
        let Some(s) = cur.as_mut() else {
            continue;
        };

        if let Some(status) = trimmed.strip_prefix("Status: ") {
            s.status = status.to_string();
            s.progress_pct = parse_progress_pct(status);
            in_transition_problems = false;
            continue;
        }
        if trimmed == "Transition problems:" {
            in_transition_problems = true;
            continue;
        }
        if in_transition_problems {
            if !trimmed.is_empty() {
                s.transition_problems.push(trimmed.to_string());
            }
            continue;
        }
        if trimmed == "Alpha:" {
            side = Some("alpha");
            continue;
        }
        if trimmed == "Beta:" {
            side = Some("beta");
            continue;
        }
        if let Some(url) = trimmed.strip_prefix("URL: ") {
            match side {
                Some("alpha") => s.alpha_url = url.to_string(),
                Some("beta") => s.beta_url = url.to_string(),
                _ => {}
            }
            continue;
        }
        if let Some(connected) = trimmed.strip_prefix("Connected: ") {
            let c = connected.eq_ignore_ascii_case("yes");
            match side {
                Some("alpha") => s.alpha_connected = c,
                Some("beta") => s.beta_connected = c,
                _ => {}
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_suffix(" symbolic links") {
            let _ = rest;
            continue;
        }
        if trimmed.ends_with(" files") || trimmed.contains(" files (") {
            let count: u64 = trimmed
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            let size = trimmed
                .split_once('(')
                .and_then(|(_, r)| r.split_once(')'))
                .map(|(s, _)| s.to_string())
                .unwrap_or_default();
            match side {
                Some("alpha") => {
                    s.alpha_files = Some(count);
                    s.alpha_size = size;
                }
                Some("beta") => {
                    s.beta_files = Some(count);
                    s.beta_size = size;
                }
                _ => {}
            }
            continue;
        }
    }
    if let Some(s) = cur {
        sessions.push(s);
    }
    sessions
}

fn parse_progress_pct(status: &str) -> Option<u8> {
    let pct_idx = status.find('%')?;
    let prefix = &status[..pct_idx];
    let num: String = prefix
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    num.parse().ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SessionProgress {
    pct: u8,
    current_files: Option<u64>,
    total_files: Option<u64>,
}

fn session_progress(s: &SessionInfo) -> Option<SessionProgress> {
    if let Some(pct) = s.progress_pct {
        return Some(SessionProgress {
            pct,
            current_files: None,
            total_files: None,
        });
    }

    if !is_progress_status(&s.status) {
        return None;
    }

    let total = s.alpha_files?;
    if total == 0 {
        return None;
    }
    let current = s.beta_files.unwrap_or(0);
    let pct = current.saturating_mul(100).checked_div(total).unwrap_or(0);

    Some(SessionProgress {
        pct: pct.min(100) as u8,
        current_files: Some(current),
        total_files: Some(total),
    })
}

fn is_progress_status(status: &str) -> bool {
    let status = status.to_lowercase();
    status.contains("applying")
        || status.contains("staging")
        || status.contains("transitioning")
        || status.contains("scanning")
        || status.contains("reconciling")
}

fn render_bar(pct: u8, width: usize) -> String {
    let pct = pct.min(100) as usize;
    let filled = (pct * width) / 100;
    let empty = width.saturating_sub(filled);
    format!("{}{}", "█".repeat(filled), "░".repeat(empty))
}

fn short_source_name(session_name: &str) -> &str {
    session_name.rsplit('-').next().unwrap_or(session_name)
}

fn render_session(s: &SessionInfo) {
    let label = short_source_name(&s.name);
    let (color, glyph) = status_style(&s.status);

    println!(
        "{} {}  {}",
        style(glyph).fg(color),
        style(label).bold(),
        style(&s.status).fg(color)
    );

    if let Some(progress) = session_progress(s) {
        match (progress.current_files, progress.total_files) {
            (Some(current), Some(total)) => println!(
                "  {} {:>3}%  {current}/{total} files",
                render_bar(progress.pct, 32),
                progress.pct
            ),
            _ => println!("  {} {:>3}%", render_bar(progress.pct, 32), progress.pct),
        }
    }

    for problem in &s.transition_problems {
        println!(
            "  {} {}",
            style("problem").fg(console::Color::Red),
            style(elide(problem, 180)).fg(console::Color::Red)
        );
    }

    let conn_a = if s.alpha_connected { "●" } else { "○" };
    let conn_b = if s.beta_connected { "●" } else { "○" };
    println!(
        "  {} alpha {}  →  {} beta {}",
        style(conn_a).fg(if s.alpha_connected {
            console::Color::Green
        } else {
            console::Color::Red
        }),
        style(&s.alpha_url).dim(),
        style(conn_b).fg(if s.beta_connected {
            console::Color::Green
        } else {
            console::Color::Red
        }),
        style(&s.beta_url).dim()
    );

    let a_f = s.alpha_files.map(|n| n.to_string()).unwrap_or_default();
    let b_f = s.beta_files.map(|n| n.to_string()).unwrap_or_default();
    println!(
        "  {} files ({}) on alpha · {} files ({}) on beta",
        style(&a_f).bold(),
        s.alpha_size,
        style(&b_f).bold(),
        s.beta_size
    );
}

fn status_style(status: &str) -> (console::Color, &'static str) {
    let s = status.to_lowercase();
    if s.contains("watching") {
        (console::Color::Green, "✓")
    } else if s.contains("paused") {
        (console::Color::Yellow, "⏸")
    } else if s.contains("applying")
        || s.contains("reconciling")
        || s.contains("staging")
        || s.contains("transitioning")
        || s.contains("scanning")
    {
        (console::Color::Cyan, "↻")
    } else if s.contains("error") || s.contains("conflict") {
        (console::Color::Red, "✗")
    } else {
        (console::Color::White, "·")
    }
}

fn elide(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(3);
    format!("{}...", value.chars().take(keep).collect::<String>())
}

fn sync_stop(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: uc sync stop");
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message(
            "`uc sync stop` pauses all enabled sources. Use `uc source disable <name>` to pause one source.".to_string(),
        ));
    }

    require_command("mutagen")?;
    let config = load_config()?;
    for source in enabled_sources(&config) {
        sync_pause_source(&config, source)?;
    }
    Ok(())
}

fn sync_remove_removed(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print_sync_remove_removed_help(sync_remove_removed_target(args));
        return Ok(());
    }

    Err(UcError::Message(sync_remove_removed_message(
        sync_remove_removed_target(args),
    )))
}

fn sync_remove_removed_target(args: &[String]) -> Option<&str> {
    args.iter()
        .find(|arg| arg.as_str() != "-h" && arg.as_str() != "--help")
        .map(String::as_str)
}

fn print_sync_remove_removed_help(target: Option<&str>) {
    println!("{}", sync_remove_removed_message(target));
}

fn sync_remove_removed_message(target: Option<&str>) -> String {
    let source = target.unwrap_or("<name>");
    format!(
        "`uc sync remove` was removed.\n\nUse `uc source remove {source}` to remove a configured source.\nUse `uc sync stop` to pause syncing."
    )
}

fn sync_reset(args: &[String]) -> Result<()> {
    if sync_help(args, "Usage: uc sync reset") {
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message("usage: uc sync reset".to_string()));
    }

    require_command("mutagen")?;
    let config = load_config()?;
    let existing = capture_command("mutagen", ["sync", "list"])?;

    for name in owned_mutagen_session_names(&config, &existing) {
        if mutagen_session_exists(&existing, &name) {
            ui_step(format!("terminate {name}"));
            run_command("mutagen", ["sync", "terminate", name.as_str()])?;
        }
    }

    sync_start(&[])
}

fn sync_help(args: &[String], usage: &str) -> bool {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("{usage}");
        true
    } else {
        false
    }
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
        "Usage:\n  uc source list\n  uc source add <name> <path> [--disabled]\n  uc source remove <name> [--yes]\n  uc source enable <name>\n  uc source disable <name>\n\nSource names may contain letters, numbers, hyphens, and underscores."
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
                println!("Usage: uc source add <name> <path> [--disabled]");
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
            "usage: uc source add <name> <path> [--disabled]".to_string(),
        ));
    }

    let name = positional[0];
    let path = positional[1];
    validate_source_name(name)?;
    if path.trim().is_empty() {
        return Err(UcError::Message("source path cannot be empty".to_string()));
    }

    let mut config = load_config()?;
    let old_source = config
        .sources
        .iter()
        .find(|source| source.agent == name)
        .cloned();
    let existed = upsert_source(&mut config, name, path, enabled)?;
    save_config(&config)?;
    let source = find_source(&config, name)?.clone();
    ensure_source_ignore_file(&source)?;
    let path_changed = old_source
        .as_ref()
        .map(|source| source.local_path != path)
        .unwrap_or(false);

    if existed {
        ui_success(format!("source {name}: updated"));
    } else {
        ui_success(format!("source {name}: added"));
    }
    if path_changed && let Some(old_source) = old_source.as_ref() {
        apply_source_sync_terminate(&config, old_source);
    }
    if enabled {
        apply_source_sync_start(&config, &source);
    } else if existed && !path_changed {
        apply_source_sync_pause(&config, &source);
    } else {
        ui_warn(format!(
            "source {name}: sync not started because source is disabled"
        ));
    }
    Ok(())
}

fn source_remove(args: &[String]) -> Result<()> {
    let Some(request) = parse_source_remove_args(args)? else {
        println!("Usage: uc source remove <name> [--yes]");
        return Ok(());
    };
    let name = request.name.as_str();
    let mut config = load_config()?;
    let source = find_source(&config, name)?.clone();

    confirm_source_remove(&config, &source, request.yes)?;
    source_remove_sync_terminate(&config, &source)?;
    delete_remote_source_dir(&config, &source)?;
    remove_source(&mut config, name)?;
    save_config(&config)?;

    ui_success(format!("source {name}: removed"));
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceRemoveRequest {
    name: String,
    yes: bool,
}

fn parse_source_remove_args(args: &[String]) -> Result<Option<SourceRemoveRequest>> {
    let mut yes = false;
    let mut positional = Vec::<&str>::new();

    for arg in args {
        match arg.as_str() {
            "--yes" | "-y" => yes = true,
            "-h" | "--help" => return Ok(None),
            value if value.starts_with('-') => {
                return Err(UcError::Message(format!(
                    "unknown source remove option: {value}"
                )));
            }
            value => positional.push(value),
        }
    }

    if positional.len() != 1 {
        return Err(UcError::Message(
            "usage: uc source remove <name> [--yes]".to_string(),
        ));
    }

    validate_source_name(positional[0])?;
    Ok(Some(SourceRemoveRequest {
        name: positional[0].to_string(),
        yes,
    }))
}

fn confirm_source_remove(config: &Config, source: &Source, yes: bool) -> Result<()> {
    if yes {
        return Ok(());
    }
    if !can_prompt() {
        return Err(UcError::Message(
            "source remove requires --yes when not interactive".to_string(),
        ));
    }

    ui_warn(format!("Remove source {}?", source.agent));
    ui_info("config entry will be removed");
    ui_info(format!(
        "sync session {} will be terminated",
        mutagen_session_name(config, source)
    ));
    ui_info(format!(
        "remote copy will be deleted: {}",
        remote_endpoint(config, source)
    ));
    ui_info(format!("local files will stay: {}", source.local_path));

    if confirm_default("Continue?", false)? {
        Ok(())
    } else {
        Err(UcError::Message("source remove cancelled".to_string()))
    }
}

fn source_set_enabled(args: &[String], enabled: bool) -> Result<()> {
    let action = if enabled { "enable" } else { "disable" };
    let name = single_source_name_arg(args, action)?;
    let mut config = load_config()?;
    set_source_enabled(&mut config, name, enabled)?;
    save_config(&config)?;
    let source = find_source(&config, name)?.clone();

    ui_success(format!("source {name}: {action}d"));
    if enabled {
        apply_source_sync_start(&config, &source);
    } else {
        apply_source_sync_pause(&config, &source);
    }
    Ok(())
}

fn single_source_name_arg<'a>(args: &'a [String], command: &str) -> Result<&'a str> {
    if args.len() != 1 || args[0] == "-h" || args[0] == "--help" {
        return Err(UcError::Message(format!(
            "usage: uc source {command} <name>"
        )));
    }
    validate_source_name(&args[0])?;
    Ok(&args[0])
}

#[derive(Debug)]
struct EventInput {
    event_id: Option<String>,
    kind: String,
    source: String,
    subject: String,
    occurred_at: Option<String>,
    actor: Option<String>,
    run_id: Option<String>,
    trace_id: Option<String>,
    parent_event_id: Option<String>,
    priority: i64,
    payload_ref: Option<String>,
    payload_hash: Option<String>,
    privacy: String,
    counts: Vec<(String, i64)>,
    labels: Vec<(String, String)>,
    ok: bool,
    error_class: Option<String>,
    error_message: Option<String>,
    error_retryable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DriverManifest {
    name: String,
    version: String,
    driver_type: Option<String>,
    runtime: Option<String>,
    commands: HashMap<String, String>,
    path: PathBuf,
}

fn cmd_driver(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help" | "help") => {
            println!("Usage:\n  uc driver list\n  uc driver run <driver> <command>");
            Ok(())
        }
        Some("list") => driver_list(),
        Some("run") => driver_run(&args[1..]),
        Some(command) => Err(UcError::Message(format!(
            "unknown driver command: {command}"
        ))),
    }
}

fn driver_list() -> Result<()> {
    let drivers = load_driver_manifests()?;
    if drivers.is_empty() {
        println!("No drivers installed in {}", drivers_dir()?.display());
        return Ok(());
    }
    for driver in drivers {
        let driver_type = driver.driver_type.as_deref().unwrap_or("driver");
        let runtime = driver.runtime.as_deref().unwrap_or("unknown-runtime");
        println!(
            "{}\t{}\t{}\t{}",
            driver.name, driver.version, driver_type, runtime
        );
    }
    Ok(())
}

fn driver_run(args: &[String]) -> Result<()> {
    if args.len() != 2 {
        return Err(UcError::Message(
            "usage: uc driver run <driver> <command>".to_string(),
        ));
    }
    let driver_name = &args[0];
    let command_name = &args[1];
    let driver = load_driver_manifest(driver_name)?;
    let command = driver.commands.get(command_name).ok_or_else(|| {
        UcError::Message(format!(
            "driver {} has no command {}",
            driver.name, command_name
        ))
    })?;
    let status = external_command("sh").arg("-c").arg(command).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(UcError::Message(format!(
            "driver {} command {} exited with {}",
            driver.name, command_name, status
        )))
    }
}

fn drivers_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("drivers"))
}

fn load_driver_manifests() -> Result<Vec<DriverManifest>> {
    let dir = drivers_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut drivers = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("driver.toml");
        if manifest_path.is_file() {
            drivers.push(parse_driver_manifest(&manifest_path)?);
        }
    }
    drivers.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(drivers)
}

fn load_driver_manifest(name: &str) -> Result<DriverManifest> {
    validate_driver_name(name)?;
    let manifest_path = drivers_dir()?.join(name).join("driver.toml");
    if !manifest_path.is_file() {
        return Err(UcError::Message(format!(
            "driver not found: {} ({})",
            name,
            manifest_path.display()
        )));
    }
    parse_driver_manifest(&manifest_path)
}

fn parse_driver_manifest(path: &Path) -> Result<DriverManifest> {
    let raw = fs::read_to_string(path)?;
    let mut section = "".to_string();
    let mut name = None;
    let mut version = None;
    let mut driver_type = None;
    let mut runtime = None;
    let mut commands = HashMap::new();

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if section == "commands" {
            let value = parse_toml_string(value.trim())?;
            commands.insert(key.to_string(), value);
        } else if section.is_empty() {
            let value = parse_toml_string(value.trim())?;
            match key {
                "name" => name = Some(value),
                "version" => version = Some(value),
                "type" => driver_type = Some(value),
                "runtime" => runtime = Some(value),
                _ => {}
            }
        }
    }

    let name = name.ok_or_else(|| {
        UcError::Message(format!("driver manifest missing name: {}", path.display()))
    })?;
    validate_driver_name(&name)?;
    Ok(DriverManifest {
        name,
        version: version.unwrap_or_else(|| "0.0.0".to_string()),
        driver_type,
        runtime,
        commands,
        path: path.to_path_buf(),
    })
}

fn parse_toml_string(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        return Ok(trimmed[1..trimmed.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\n", "\n")
            .replace("\\\\", "\\"));
    }
    Err(UcError::Message(format!(
        "expected quoted string in driver manifest: {value}"
    )))
}

fn validate_driver_name(name: &str) -> Result<()> {
    validate_source_name(name)
}

fn cmd_event(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("emit") => event_emit(&args[1..]),
        Some("commit") => event_commit(&args[1..]),
        Some("tail") => event_tail(&args[1..]),
        Some("flush") => event_flush(&args[1..]),
        Some("status") => event_status(&args[1..]),
        Some("-h" | "--help") | None => {
            print_event_help();
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!(
            "unknown event command: {command}"
        ))),
    }
}

fn print_event_help() {
    println!(
        "Usage:\n  uc event emit --kind <kind> --source <source> --subject <id> [--event-id <id>] [--occurred-at <ts>] [--actor <actor>] [--priority <n>] [--run-id <id>] [--trace-id <id>] [--parent-event-id <id>] [--payload-ref <ref>] [--payload-hash sha256:<hash>] [--privacy <level>] [--count key=value] [--label key=value] [--ok true|false] [--error-class <class>] [--error-message <message>] [--error-retryable true|false]\n  uc event commit --from-stdin\n  uc event tail [--limit <n>]\n  uc event flush\n  uc event status"
    );
}

fn event_emit(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!(
            "Usage: uc event emit --kind <kind> --source <source> --subject <id> [--event-id <id>] [--occurred-at <ts>] [--actor <actor>] [--priority <n>] [--run-id <id>] [--trace-id <id>] [--parent-event-id <id>] [--payload-ref <ref>] [--payload-hash sha256:<hash>] [--privacy <level>] [--count key=value] [--label key=value] [--ok true|false] [--error-class <class>] [--error-message <message>] [--error-retryable true|false]"
        );
        return Ok(());
    }

    let config = load_event_config()?;
    let input = parse_event_emit_args(args)?;
    let event = render_event_json(&input, &config.host_id)?;
    save_outbox_event(&event)?;
    match append_event(&config, &event) {
        Ok(()) => mark_event_sent(&event)?,
        Err(error) => {
            return Err(UcError::Message(format!(
                "event saved to local outbox but server append failed: {error}"
            )));
        }
    }
    println!(
        "event: {} {}",
        event_field(&event, "event_id").unwrap_or_default(),
        input.kind
    );
    Ok(())
}

fn parse_event_emit_args(args: &[String]) -> Result<EventInput> {
    let mut event_id: Option<String> = None;
    let mut kind: Option<String> = None;
    let mut source: Option<String> = None;
    let mut subject: Option<String> = None;
    let mut occurred_at: Option<String> = None;
    let mut actor: Option<String> = None;
    let mut run_id: Option<String> = None;
    let mut trace_id: Option<String> = None;
    let mut parent_event_id: Option<String> = None;
    let mut priority: i64 = 50;
    let mut payload_ref: Option<String> = None;
    let mut payload_hash: Option<String> = None;
    let mut privacy = "metadata_only".to_string();
    let mut counts: Vec<(String, i64)> = Vec::new();
    let mut labels: Vec<(String, String)> = Vec::new();
    let mut ok = true;
    let mut error_class: Option<String> = None;
    let mut error_message: Option<String> = None;
    let mut error_retryable: Option<bool> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--event-id" => {
                i += 1;
                event_id = Some(require_value(args, i, "--event-id")?.to_string());
            }
            "--kind" => {
                i += 1;
                kind = Some(require_value(args, i, "--kind")?.to_string());
            }
            "--source" => {
                i += 1;
                source = Some(require_value(args, i, "--source")?.to_string());
            }
            "--subject" | "--subject-id" => {
                i += 1;
                subject = Some(require_value(args, i, "--subject")?.to_string());
            }
            "--occurred-at" | "--at" => {
                i += 1;
                occurred_at = Some(require_value(args, i, "--occurred-at")?.to_string());
            }
            "--actor" => {
                i += 1;
                actor = Some(require_value(args, i, "--actor")?.to_string());
            }
            "--run-id" => {
                i += 1;
                run_id = Some(require_value(args, i, "--run-id")?.to_string());
            }
            "--trace-id" => {
                i += 1;
                trace_id = Some(require_value(args, i, "--trace-id")?.to_string());
            }
            "--parent-event-id" => {
                i += 1;
                parent_event_id = Some(require_value(args, i, "--parent-event-id")?.to_string());
            }
            "--priority" => {
                i += 1;
                let raw = require_value(args, i, "--priority")?;
                priority = raw
                    .parse::<i64>()
                    .map_err(|_| UcError::Message(format!("invalid --priority: {raw}")))?;
            }
            "--payload-ref" => {
                i += 1;
                payload_ref = Some(require_value(args, i, "--payload-ref")?.to_string());
            }
            "--payload-hash" => {
                i += 1;
                payload_hash = Some(require_value(args, i, "--payload-hash")?.to_string());
            }
            "--privacy" => {
                i += 1;
                privacy = require_value(args, i, "--privacy")?.to_string();
            }
            "--count" => {
                i += 1;
                counts.push(parse_count(require_value(args, i, "--count")?)?);
            }
            "--label" => {
                i += 1;
                labels.push(parse_label(require_value(args, i, "--label")?)?);
            }
            "--ok" => {
                i += 1;
                ok = parse_bool(require_value(args, i, "--ok")?)?;
            }
            "--error-class" => {
                i += 1;
                error_class = Some(require_value(args, i, "--error-class")?.to_string());
            }
            "--error-message" => {
                i += 1;
                error_message = Some(require_value(args, i, "--error-message")?.to_string());
            }
            "--error-retryable" => {
                i += 1;
                error_retryable = Some(parse_bool(require_value(args, i, "--error-retryable")?)?);
            }
            value if value.starts_with('-') => {
                return Err(UcError::Message(format!(
                    "unknown event emit option: {value}"
                )));
            }
            value => {
                if kind.is_none() {
                    kind = Some(value.to_string());
                } else {
                    return Err(UcError::Message(format!(
                        "unexpected event emit argument: {value}"
                    )));
                }
            }
        }
        i += 1;
    }

    let kind = kind.ok_or_else(|| UcError::Message("missing --kind".to_string()))?;
    let source = source.ok_or_else(|| UcError::Message("missing --source".to_string()))?;
    let subject = subject.ok_or_else(|| UcError::Message("missing --subject".to_string()))?;
    validate_event_token("event_id", event_id.as_deref().unwrap_or("evt_placeholder"))?;
    validate_event_token("kind", &kind)?;
    validate_event_token("source", &source)?;
    validate_event_token("subject", &subject)?;
    if !(0..=100).contains(&priority) {
        return Err(UcError::Message(format!(
            "invalid --priority: {priority}. Must be between 0 and 100."
        )));
    }
    validate_privacy(&privacy)?;
    if let Some(hash) = payload_hash.as_deref()
        && !hash.starts_with("sha256:")
    {
        return Err(UcError::Message(
            "invalid --payload-hash: expected sha256:<hash>".to_string(),
        ));
    }
    Ok(EventInput {
        event_id,
        kind,
        source,
        subject,
        occurred_at,
        actor,
        run_id,
        trace_id,
        parent_event_id,
        priority,
        payload_ref,
        payload_hash,
        privacy,
        counts,
        labels,
        ok,
        error_class,
        error_message,
        error_retryable,
    })
}

fn parse_count(raw: &str) -> Result<(String, i64)> {
    let (key, value) = raw
        .split_once('=')
        .ok_or_else(|| UcError::Message(format!("invalid --count, expected key=value: {raw}")))?;
    validate_event_token("count key", key)?;
    let value = value
        .parse::<i64>()
        .map_err(|_| UcError::Message(format!("invalid count value: {value}")))?;
    Ok((key.to_string(), value))
}

fn parse_label(raw: &str) -> Result<(String, String)> {
    let (key, value) = raw
        .split_once('=')
        .ok_or_else(|| UcError::Message(format!("invalid --label, expected key=value: {raw}")))?;
    validate_event_token("label key", key)?;
    if value.is_empty() || value.len() > 256 {
        return Err(UcError::Message(format!("invalid label value: {value}")));
    }
    Ok((key.to_string(), value.to_string()))
}

fn validate_privacy(value: &str) -> Result<()> {
    match value {
        "public" | "internal" | "metadata_only" | "sensitive_ref" => Ok(()),
        _ => Err(UcError::Message(format!(
            "invalid --privacy: {value}. Expected public, internal, metadata_only, or sensitive_ref."
        ))),
    }
}

fn parse_bool(raw: &str) -> Result<bool> {
    match raw {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        _ => Err(UcError::Message(format!("invalid boolean: {raw}"))),
    }
}

fn validate_event_token(label: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 128 {
        return Err(UcError::Message(format!("invalid {label}: {value}")));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':' | '/'))
    {
        return Err(UcError::Message(format!(
            "invalid {label}: {value}. Use letters, numbers, _, -, ., :, and /."
        )));
    }
    Ok(())
}

fn render_event_json(input: &EventInput, host: &str) -> Result<String> {
    let event_id = input.event_id.clone().unwrap_or(new_event_id()?);
    let now = iso_timestamp()?;
    let occurred_at = input.occurred_at.as_deref().unwrap_or(&now);
    let actor = json_optional_string(input.actor.as_deref());
    let run_id = json_optional_string(input.run_id.as_deref());
    let trace_id = json_optional_string(input.trace_id.as_deref());
    let parent_event_id = json_optional_string(input.parent_event_id.as_deref());
    let payload_ref = json_optional_string(input.payload_ref.as_deref());
    let payload_hash = json_optional_string(input.payload_hash.as_deref());
    let counts = input
        .counts
        .iter()
        .map(|(key, value)| format!("{}:{}", json_string(key), value))
        .collect::<Vec<_>>()
        .join(",");
    let labels = input
        .labels
        .iter()
        .map(|(key, value)| format!("{}:{}", json_string(key), json_string(value)))
        .collect::<Vec<_>>()
        .join(",");
    let error = render_event_error(input);
    Ok(format!(
        "{{\"schema_version\":\"uc.event.v1\",\"event_id\":{},\"kind\":{},\"source\":{},\"subject\":{},\"occurred_at\":{},\"host\":{},\"actor\":{},\"run_id\":{},\"trace_id\":{},\"parent_event_id\":{},\"priority\":{},\"ok\":{},\"payload_ref\":{},\"payload_hash\":{},\"privacy\":{},\"counts\":{{{}}},\"labels\":{{{}}},\"error\":{}}}",
        json_string(&event_id),
        json_string(&input.kind),
        json_string(&input.source),
        json_string(&input.subject),
        json_string(occurred_at),
        json_string(host),
        actor,
        run_id,
        trace_id,
        parent_event_id,
        input.priority,
        input.ok,
        payload_ref,
        payload_hash,
        json_string(&input.privacy),
        counts,
        labels,
        error
    ))
}

fn render_event_error(input: &EventInput) -> String {
    if input.error_class.is_none()
        && input.error_message.is_none()
        && input.error_retryable.is_none()
    {
        return "null".to_string();
    }
    let class = json_optional_string(input.error_class.as_deref());
    let message = json_optional_string(input.error_message.as_deref());
    let retryable = input
        .error_retryable
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_string());
    format!(
        "{{\"class\":{},\"message\":{},\"retryable\":{}}}",
        class, message, retryable
    )
}

fn event_commit(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: uc event commit --from-stdin");
        return Ok(());
    }
    if args != ["--from-stdin"] {
        return Err(UcError::Message(
            "usage: uc event commit --from-stdin".to_string(),
        ));
    }
    let config = load_event_config()?;
    let mut event = String::new();
    io::stdin().read_to_string(&mut event)?;
    let committed = commit_local_server_event(&config, event.trim())?;
    if committed {
        println!("committed: 1");
    } else {
        println!("committed: 0");
    }
    Ok(())
}

fn append_event(config: &Config, event_json: &str) -> Result<()> {
    if config.is_local() {
        commit_local_server_event(config, event_json).map(|_| ())
    } else {
        append_remote_server_event(config, event_json)
    }
}

fn commit_local_server_event(config: &Config, event_json: &str) -> Result<bool> {
    validate_event_envelope(event_json)?;
    let event_id = event_field(event_json, "event_id")
        .ok_or_else(|| UcError::Message("event missing event_id".to_string()))?;
    let path = event_log_path_for_config(config)?;
    let events_dir = path
        .parent()
        .ok_or_else(|| UcError::Message("event log path has no parent".to_string()))?;
    let seen_dir = events_dir.join("seen");
    let seen_path = seen_dir.join(&event_id);
    fs::create_dir_all(&seen_dir)?;
    if seen_path.exists() {
        return Ok(false);
    }
    if path.exists()
        && fs::read_to_string(&path)?
            .lines()
            .any(|line| line.contains(&format!("\"event_id\":\"{event_id}\"")))
    {
        fs::write(seen_path, "seen\n")?;
        return Ok(false);
    }
    let committed_event = with_server_received_at(event_json, &iso_timestamp()?)?;
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{committed_event}")?;
    fs::write(seen_path, "seen\n")?;
    Ok(true)
}

fn validate_event_envelope(event_json: &str) -> Result<()> {
    if event_json.trim().is_empty() {
        return Err(UcError::Message(
            "event commit requires JSON on stdin".to_string(),
        ));
    }
    let schema = event_field(event_json, "schema_version")
        .ok_or_else(|| UcError::Message("event missing schema_version".to_string()))?;
    if schema != "uc.event.v1" {
        return Err(UcError::Message(format!(
            "unsupported event schema_version: {schema}"
        )));
    }
    for field in [
        "event_id",
        "kind",
        "source",
        "subject",
        "occurred_at",
        "host",
        "privacy",
    ] {
        if event_field(event_json, field).is_none() {
            return Err(UcError::Message(format!("event missing {field}")));
        }
    }
    Ok(())
}

fn with_server_received_at(event_json: &str, received_at: &str) -> Result<String> {
    let without_received_at = remove_json_string_field(event_json.trim(), "received_at");
    insert_json_string_field_after(
        &without_received_at,
        "occurred_at",
        "received_at",
        received_at,
    )
}

fn remove_json_string_field(event_json: &str, field: &str) -> String {
    let needle = format!("\"{field}\":\"");
    let Some(value_start) = event_json.find(&needle) else {
        return event_json.to_string();
    };
    let mut value_end = value_start + needle.len();
    let bytes = event_json.as_bytes();
    while value_end < bytes.len() {
        if bytes[value_end] == b'\"' && bytes.get(value_end.wrapping_sub(1)) != Some(&b'\\') {
            value_end += 1;
            break;
        }
        value_end += 1;
    }
    let mut remove_start = value_start;
    let mut remove_end = value_end;
    if bytes.get(remove_end) == Some(&b',') {
        remove_end += 1;
    } else if value_start > 0 && bytes.get(value_start - 1) == Some(&b',') {
        remove_start -= 1;
    }
    format!(
        "{}{}",
        &event_json[..remove_start],
        &event_json[remove_end..]
    )
}

fn insert_json_string_field_after(
    event_json: &str,
    after_field: &str,
    field: &str,
    value: &str,
) -> Result<String> {
    let needle = format!("\"{after_field}\":\"");
    let value_start = event_json
        .find(&needle)
        .ok_or_else(|| UcError::Message(format!("event missing {after_field}")))?
        + needle.len();
    let bytes = event_json.as_bytes();
    let mut value_end = value_start;
    while value_end < bytes.len() {
        if bytes[value_end] == b'\"' && bytes.get(value_end.wrapping_sub(1)) != Some(&b'\\') {
            value_end += 1;
            break;
        }
        value_end += 1;
    }
    Ok(format!(
        "{},\"{field}\":{}{}",
        &event_json[..value_end],
        json_string(value),
        &event_json[value_end..]
    ))
}

fn append_remote_server_event(config: &Config, event_json: &str) -> Result<()> {
    let command = remote_event_commit_command(config);
    run_command_with_stdin(
        "ssh",
        [config.remote.as_str(), command.as_str()],
        event_json,
    )
}

fn remote_event_commit_command(config: &Config) -> String {
    let fallback = r#"import datetime,json,os,sys
root=os.path.expanduser(os.environ['UC_EVENT_ROOT'])
raw=sys.stdin.read().strip()
event=json.loads(raw)
required=['schema_version','event_id','kind','source','subject','occurred_at','host','privacy']
missing=[field for field in required if not event.get(field)]
if missing:
    raise SystemExit('event missing '+','.join(missing))
if event['schema_version']!='uc.event.v1':
    raise SystemExit('unsupported event schema_version: '+event['schema_version'])
events_dir=os.path.join(root,'events')
seen_dir=os.path.join(events_dir,'seen')
os.makedirs(seen_dir,exist_ok=True)
event_id=event['event_id']
seen_path=os.path.join(seen_dir,event_id)
log_path=os.path.join(events_dir,'events.jsonl')
if os.path.exists(seen_path):
    raise SystemExit(0)
if os.path.exists(log_path):
    with open(log_path,'r',encoding='utf-8') as file:
        for line in file:
            try:
                if json.loads(line).get('event_id')==event_id:
                    open(seen_path,'w',encoding='utf-8').write('seen\n')
                    raise SystemExit(0)
            except json.JSONDecodeError:
                pass
event['received_at']=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
with open(log_path,'a',encoding='utf-8') as file:
    file.write(json.dumps(event,separators=(',',':'))+'\n')
open(seen_path,'w',encoding='utf-8').write('seen\n')
"#;
    format!(
        "if command -v uc >/dev/null 2>&1; then uc event commit --from-stdin; else UC_EVENT_ROOT={} python3 -c {}; fi",
        sh_quote(config.remote_root.trim_end_matches('/')),
        sh_quote(fallback)
    )
}

fn event_tail(args: &[String]) -> Result<()> {
    let limit = parse_limit_args(args, "event tail")?.unwrap_or(20);
    let lines = read_event_lines()?;
    for line in tail_lines(&lines, limit) {
        println!("{line}");
    }
    Ok(())
}

fn parse_limit_args(args: &[String], command: &str) -> Result<Option<usize>> {
    let mut limit = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--limit" | "-n" => {
                i += 1;
                let raw = require_value(args, i, "--limit")?;
                limit = Some(
                    raw.parse::<usize>()
                        .map_err(|_| UcError::Message(format!("invalid --limit: {raw}")))?,
                );
            }
            "-h" | "--help" => {
                println!("Usage: uc {command} [--limit <n>]");
                return Ok(Some(0));
            }
            value => {
                return Err(UcError::Message(format!(
                    "unknown {command} option: {value}"
                )));
            }
        }
        i += 1;
    }
    Ok(limit)
}

fn tail_lines(lines: &[String], limit: usize) -> &[String] {
    let start = lines.len().saturating_sub(limit);
    &lines[start..]
}

fn read_event_lines() -> Result<Vec<String>> {
    let config = load_event_config()?;
    let raw = if config.is_local() {
        let path = event_log_path_for_config(&config)?;
        if !path.exists() {
            return Ok(Vec::new());
        }
        fs::read_to_string(path)?
    } else {
        read_remote_event_log(&config)?
    };
    Ok(raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect())
}

fn read_remote_event_log(config: &Config) -> Result<String> {
    let path = format!(
        "{}/events/events.jsonl",
        config.remote_root.trim_end_matches('/')
    );
    let path_arg = remote_path_arg(&path);
    let command = format!("if [ -f {path_arg} ]; then cat {path_arg}; fi");
    capture_command("ssh", [config.remote.as_str(), command.as_str()])
}

fn event_log_path_for_config(config: &Config) -> Result<PathBuf> {
    if config.is_local() {
        Ok(expand_home(&config.remote_root)?
            .join("events")
            .join("events.jsonl"))
    } else {
        Ok(config_dir()?.join("events").join("events.jsonl"))
    }
}

fn load_event_config() -> Result<Config> {
    load_config().or_else(|_| {
        Ok(Config {
            remote: "local".to_string(),
            remote_root: config_dir()?.to_string_lossy().to_string(),
            host_id: default_host_id(),
            sources: Vec::new(),
        })
    })
}

fn event_storage_dir(name: &str) -> Result<PathBuf> {
    Ok(config_dir()?.join("events").join(name))
}

fn save_outbox_event(event_json: &str) -> Result<PathBuf> {
    let event_id = event_field(event_json, "event_id")
        .ok_or_else(|| UcError::Message("event missing event_id".to_string()))?;
    let dir = event_storage_dir("outbox")?;
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{event_id}.json"));
    fs::write(&path, format!("{event_json}\n"))?;
    Ok(path)
}

fn mark_event_sent(event_json: &str) -> Result<()> {
    let event_id = event_field(event_json, "event_id")
        .ok_or_else(|| UcError::Message("event missing event_id".to_string()))?;
    let outbox_path = event_storage_dir("outbox")?.join(format!("{event_id}.json"));
    let sent_dir = event_storage_dir("sent")?;
    fs::create_dir_all(&sent_dir)?;
    let sent_path = sent_dir.join(format!("{event_id}.json"));
    fs::write(&sent_path, format!("{event_json}\n"))?;
    if outbox_path.exists() {
        fs::remove_file(outbox_path)?;
    }
    Ok(())
}

fn event_flush(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: uc event flush");
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message("usage: uc event flush".to_string()));
    }
    let config = load_event_config()?;
    let outbox_dir = event_storage_dir("outbox")?;
    if !outbox_dir.exists() {
        println!("flushed: 0");
        return Ok(());
    }
    let mut flushed = 0usize;
    let mut failed = 0usize;
    for entry in fs::read_dir(&outbox_dir)? {
        let path = entry?.path();
        if !path.is_file() {
            continue;
        }
        let event = fs::read_to_string(&path)?;
        let event = event.trim();
        if event.is_empty() {
            continue;
        }
        match append_event(&config, event) {
            Ok(()) => {
                mark_event_sent(event)?;
                flushed += 1;
            }
            Err(error) => {
                failed += 1;
                ui_warn(format!("pending {}: {error}", path.display()));
            }
        }
    }
    println!("flushed: {flushed}");
    if failed > 0 {
        return Err(UcError::Message(format!(
            "failed to flush {failed} event(s)"
        )));
    }
    Ok(())
}

fn event_status(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: uc event status");
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message("usage: uc event status".to_string()));
    }
    let config = load_event_config()?;
    let server = if config.is_local() {
        format!("local {}", expand_home(&config.remote_root)?.display())
    } else {
        format!("{}:{}", config.remote, config.remote_root)
    };
    println!("server: {server}");
    println!("host: {}", config.host_id);
    println!("pending: {}", count_files(&event_storage_dir("outbox")?)?);
    println!("sent: {}", count_files(&event_storage_dir("sent")?)?);
    Ok(())
}

fn count_files(path: &Path) -> Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    Ok(fs::read_dir(path)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.path().is_file())
        .count())
}

fn new_event_id() -> Result<String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| UcError::Message(format!("system clock before unix epoch: {error}")))?;
    Ok(format!(
        "evt_{}_{}_{}",
        std::process::id(),
        now.as_secs(),
        now.subsec_nanos()
    ))
}

fn iso_timestamp() -> Result<String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| UcError::Message(format!("system clock before unix epoch: {error}")))?;
    Ok(format_unix_millis(
        now.as_secs() as i64,
        now.subsec_millis(),
    ))
}

fn format_unix_millis(seconds: i64, millis: u32) -> String {
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

fn json_optional_string(value: Option<&str>) -> String {
    value.map(json_string).unwrap_or_else(|| "null".to_string())
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('\"');
    out
}

fn event_field(event_json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\":\"");
    let rest = event_json.split_once(&needle)?.1;
    Some(rest.split('"').next()?.to_string())
}

fn cmd_status(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: uc status");
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message("usage: uc status".to_string()));
    }

    let config = match load_config() {
        Ok(config) => config,
        Err(error) => {
            ui_warn(format!("config: missing ({error})"));
            ui_info("next: uc init");
            return Ok(());
        }
    };

    let mutagen_list = match require_command("mutagen") {
        Ok(()) => capture_command("mutagen", ["sync", "list"]).ok(),
        Err(_) => None,
    };

    let enabled = config
        .sources
        .iter()
        .filter(|source| source.enabled)
        .count();
    let active_syncs = mutagen_list
        .as_deref()
        .map(|list| {
            config
                .sources
                .iter()
                .filter(|source| source.enabled)
                .filter(|source| {
                    mutagen_session_status(list, &mutagen_session_name(&config, source)).is_some()
                })
                .count()
        })
        .unwrap_or(0);

    ui_info(format!(
        "workspace {} | host {} | sync {active_syncs}/{enabled}",
        workspace_display(&config)?,
        config.host_id
    ));

    if config.sources.is_empty() {
        ui_warn("no sources configured");
    };

    for source in &config.sources {
        status_source(&config, source, mutagen_list.as_deref());
    }

    Ok(())
}

fn workspace_display(config: &Config) -> Result<String> {
    let workspace = format!("{}/workspace", config.remote_root);
    if config.is_local() {
        return Ok(expand_home(&workspace)?.display().to_string());
    }
    Ok(format!("{}:{workspace}", config.remote))
}

fn status_source(config: &Config, source: &Source, mutagen_list: Option<&str>) {
    let local_ok = expand_home(&source.local_path)
        .map(|path| path.exists())
        .unwrap_or(false);
    let sync_state = if source.enabled {
        mutagen_list
            .and_then(|list| mutagen_session_status(list, &mutagen_session_name(config, source)))
            .unwrap_or_else(|| "idle".to_string())
    } else {
        "off".to_string()
    };
    let local_state = if local_ok { "ok" } else { "missing" };
    let line = format!("{} {} | local {}", source.agent, sync_state, local_state);

    if !source.enabled {
        ui_info(line);
    } else if local_ok && sync_state != "idle" {
        ui_success(line);
    } else {
        ui_warn(line);
    }
}

fn cmd_doctor() -> Result<()> {
    let config = load_config().ok();

    check_installation();

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
        ui_info(format!("config: {}", config_path()?.display()));
        ui_info(format!("remote: {}:{}", config.remote, config.remote_root));
        ui_info(format!("host: {}", config.host_id));

        if config.is_local() {
            check_local_workspace(&config);
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
        }
    } else {
        ui_warn(format!("config: missing ({})", config_path()?.display()));
    }

    Ok(())
}

fn cmd_update(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: uc update");
        return Ok(());
    }
    if !args.is_empty() {
        return Err(UcError::Message("usage: uc update".to_string()));
    }

    let manager = detect_install_manager();
    match manager {
        InstallManager::Standalone => {
            println!("Updating UltraContext with installer:");
            println!("  {INSTALL_URL}");
            let command = format!("curl -fsSL {INSTALL_URL} | sh");
            run_command("sh", ["-c", command.as_str()])?;
            refresh_runtime_assets_with_updated_binary()
        }
        InstallManager::Npm => {
            println!("UltraContext is managed by npm.");
            println!("Running: npm update -g ultracontext");
            run_command("npm", ["update", "-g", "ultracontext"])?;
            refresh_runtime_assets_with_updated_binary()
        }
        InstallManager::Cargo => {
            println!("UltraContext is managed by Cargo.");
            println!("Running: cargo install ultracontext --force");
            run_command("cargo", ["install", "ultracontext", "--force"])?;
            refresh_runtime_assets_with_updated_binary()
        }
        InstallManager::Homebrew => {
            println!("UltraContext appears to be managed by Homebrew.");
            println!("Running: brew upgrade ultracontext");
            run_command("brew", ["upgrade", "ultracontext"])?;
            refresh_runtime_assets_with_updated_binary()
        }
        InstallManager::Unknown => {
            println!("Could not determine how UltraContext was installed.");
            println!("Use one of:");
            println!("  curl -fsSL {INSTALL_URL} | sh");
            println!("  npm update -g ultracontext");
            println!("  cargo install ultracontext --force");
            refresh_runtime_assets()
        }
    }
}

fn refresh_runtime_assets_with_updated_binary() -> Result<()> {
    let current_exe = env::current_exe()?;
    let status = Command::new(&current_exe)
        .arg("__refresh-runtime-assets")
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(UcError::Message(format!(
            "{} __refresh-runtime-assets exited with {}",
            current_exe.display(),
            status
        )))
    }
}

fn refresh_runtime_assets() -> Result<()> {
    install_agent_skills()?;
    Ok(())
}

fn prepare_remote_workspace(config: &Config) -> Result<()> {
    let mut dirs = vec![workspace_root(config), host_workspace_dir(config)];
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
    run_command("ssh", [config.remote.as_str(), command.as_str()])
}

fn prepare_reconfigured_workspace(
    previous: &Config,
    remote: &RemoteSpec,
    host_id: &str,
) -> Result<()> {
    if previous.remote == remote.target
        && previous.remote_root == remote.root
        && previous.host_id == host_id
    {
        return Ok(());
    }

    terminate_owned_sync_sessions(previous)?;

    if previous.remote == remote.target
        && previous.remote_root == remote.root
        && previous.host_id != host_id
    {
        move_host_workspace(previous, host_id)?;
    }

    Ok(())
}

fn terminate_owned_sync_sessions(config: &Config) -> Result<()> {
    match require_command("mutagen") {
        Ok(()) => {}
        Err(error) => {
            ui_warn(format!("old sync sessions not terminated ({error})"));
            return Ok(());
        }
    }

    let existing = capture_command("mutagen", ["sync", "list"])?;
    for name in owned_mutagen_session_names(config, &existing) {
        sync_terminate_session(&name, &existing)?;
    }
    Ok(())
}

fn move_host_workspace(config: &Config, new_host_id: &str) -> Result<()> {
    let old_dir = host_workspace_dir(config);
    let new_dir = host_workspace_dir_for_id(config, new_host_id);

    if config.is_local() {
        let old_path = expand_home(&old_dir)?;
        let new_path = expand_home(&new_dir)?;
        move_local_workspace(&old_path, &new_path, &config.host_id, new_host_id)?;
        return Ok(());
    }

    let old_arg = remote_path_arg(&old_dir);
    let new_arg = remote_path_arg(&new_dir);
    let workspace_arg = remote_path_arg(&workspace_root(config));
    let command = format!(
        "mkdir -p {workspace_arg}; \
if [ -d {old_arg} ] && [ ! -e {new_arg} ]; then mv {old_arg} {new_arg}; \
elif [ -d {old_arg} ] && [ -e {new_arg} ]; then rm -rf {old_arg}; fi"
    );
    run_command("ssh", [config.remote.as_str(), command.as_str()])
}

fn move_local_workspace(
    old_path: &Path,
    new_path: &Path,
    old_host_id: &str,
    new_host_id: &str,
) -> Result<()> {
    if !old_path.exists() {
        return Ok(());
    }
    if new_path.exists() {
        ui_step(format!("remove old workspace {old_host_id}"));
        fs::remove_dir_all(old_path)?;
        return Ok(());
    }
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent)?;
    }
    ui_step(format!("move workspace {old_host_id} -> {new_host_id}"));
    fs::rename(old_path, new_path)?;
    Ok(())
}

fn default_sources() -> Vec<Source> {
    known_source_specs()
        .iter()
        .map(|source| Source {
            agent: source.agent.to_string(),
            local_path: source.path.to_string(),
            enabled: source_path_exists(source.path),
        })
        .collect()
}

fn noninteractive_init_sources(config: Option<&Config>) -> Vec<Source> {
    config
        .map(|config| config.sources.clone())
        .unwrap_or_else(default_sources)
}

fn setup_source_defaults(config: Option<&Config>) -> Vec<Source> {
    let Some(config) = config else {
        return default_sources();
    };

    let mut sources = config.sources.clone();
    let mut seen = sources
        .iter()
        .map(|source| source.agent.clone())
        .collect::<HashSet<_>>();
    for source in default_sources() {
        if seen.insert(source.agent.clone()) {
            sources.push(source);
        }
    }
    sources
}

fn configured_source_names(config: &Config) -> Vec<String> {
    config
        .sources
        .iter()
        .map(|source| source.agent.clone())
        .collect()
}

fn known_source_specs() -> &'static [KnownSource] {
    &[
        KnownSource {
            agent: "openclaw",
            label: "OpenClaw",
            path: "~/.openclaw",
        },
        KnownSource {
            agent: "claude",
            label: "Claude",
            path: "~/.claude",
        },
        KnownSource {
            agent: "hermes",
            label: "Hermes",
            path: "~/.hermes",
        },
        KnownSource {
            agent: "codex",
            label: "Codex",
            path: "~/.codex",
        },
    ]
}

fn known_source(agent: &str) -> Option<KnownSource> {
    known_source_specs()
        .iter()
        .copied()
        .find(|source| source.agent == agent)
}

fn source_path_exists(path: &str) -> bool {
    expand_home(path).map(|p| p.exists()).unwrap_or(false)
}

fn enabled_sources(config: &Config) -> impl Iterator<Item = &Source> {
    config.sources.iter().filter(|source| source.enabled)
}

fn find_source<'a>(config: &'a Config, name: &str) -> Result<&'a Source> {
    config
        .sources
        .iter()
        .find(|source| source.agent == name)
        .ok_or_else(|| UcError::Message(format!("source not found: {name}")))
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

fn remote_source_dir_name(source: &Source) -> String {
    known_source(&source.agent)
        .and_then(|known| known.path.rsplit('/').next())
        .unwrap_or(source.agent.as_str())
        .to_string()
}

fn workspace_root(config: &Config) -> String {
    format!("{}/workspace", config.remote_root)
}

fn host_workspace_dir_for_id(config: &Config, host_id: &str) -> String {
    format!("{}/workspace/{}", config.remote_root, host_id)
}

fn host_workspace_dir(config: &Config) -> String {
    host_workspace_dir_for_id(config, &config.host_id)
}

fn remote_dir_for_name(config: &Config, dir_name: &str) -> String {
    format!("{}/{}", host_workspace_dir(config), dir_name)
}

fn remote_dir(config: &Config, source: &Source) -> String {
    remote_dir_for_name(config, &remote_source_dir_name(source))
}

fn remote_dirs_to_delete(config: &Config, source: &Source) -> Vec<String> {
    let current = remote_source_dir_name(source);
    vec![remote_dir_for_name(config, &current)]
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

fn delete_remote_source_dir(config: &Config, source: &Source) -> Result<()> {
    if config.is_local() {
        for dir in remote_dirs_to_delete(config, source) {
            let path = expand_home(&dir)?;
            if path.exists() {
                ui_step(format!("delete remote {}", path.display()));
                fs::remove_dir_all(path)?;
            } else {
                ui_info(format!("remote copy {}: missing", path.display()));
            }
        }
        return Ok(());
    }

    for dir in remote_dirs_to_delete(config, source) {
        let endpoint = format!("{}:{dir}", config.remote);
        ui_step(format!("delete remote {endpoint}"));
        let dir_arg = remote_path_arg(&dir);
        let command = format!("if [ -e {dir_arg} ]; then rm -rf {dir_arg}; fi");
        run_command("ssh", [config.remote.as_str(), command.as_str()])?;
    }
    Ok(())
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

fn mutagen_session_status(mutagen_list: &str, name: &str) -> Option<String> {
    let mut in_session = false;

    for line in mutagen_list.lines().map(str::trim) {
        if let Some(session_name) = line.strip_prefix("Name: ") {
            in_session = session_name == name;
            continue;
        }
        if in_session && let Some(status) = line.strip_prefix("Status: ") {
            return Some(status.to_string());
        }
    }

    if in_session {
        Some("present".to_string())
    } else {
        None
    }
}

fn mutagen_session_exists(mutagen_list: &str, name: &str) -> bool {
    mutagen_list
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Name: "))
        .any(|session_name| session_name == name)
}

fn sync_start_source(config: &Config, source: &Source, existing: &str) -> Result<()> {
    let local_path = expand_home(&source.local_path)?;
    if !local_path.exists() {
        ui_warn(format!(
            "skip {}: local path does not exist ({})",
            source.agent,
            local_path.display()
        ));
        return Ok(());
    }

    let name = mutagen_session_name(config, source);
    if mutagen_session_exists(existing, &name) {
        ui_step(format!("resume {name}"));
        run_command("mutagen", ["sync", "resume", name.as_str()])?;
        run_command("mutagen", ["sync", "flush", name.as_str()])?;
        return Ok(());
    }

    prepare_remote_workspace(config)?;
    ensure_ignore_file()?;
    ensure_source_ignore_file(source)?;

    let remote_endpoint = remote_endpoint(config, source);
    ui_step(format!("create {name}"));
    let ignore_patterns = sync_ignore_patterns(source)?;
    let args = sync_create_args(&name, &local_path, remote_endpoint, &ignore_patterns);
    run_command("mutagen", args)
}

fn sync_pause_source(config: &Config, source: &Source) -> Result<()> {
    let name = mutagen_session_name(config, source);
    let existing = capture_command("mutagen", ["sync", "list"])?;
    sync_pause_session(&name, &existing)
}

fn sync_pause_session(name: &str, existing: &str) -> Result<()> {
    if !mutagen_session_exists(existing, name) {
        ui_info(format!("sync session {name}: missing"));
        return Ok(());
    }

    ui_step(format!("pause {name}"));
    run_command("mutagen", ["sync", "pause", name])
}

fn sync_terminate_source(config: &Config, source: &Source) -> Result<()> {
    let existing = capture_command("mutagen", ["sync", "list"])?;
    let name = mutagen_session_name(config, source);
    sync_terminate_session(&name, &existing)
}

fn sync_terminate_session(name: &str, existing: &str) -> Result<()> {
    if !mutagen_session_exists(existing, name) {
        ui_info(format!("sync session {name}: missing"));
        return Ok(());
    }

    ui_step(format!("terminate {name}"));
    run_command("mutagen", ["sync", "terminate", name])
}

fn apply_source_sync_start(config: &Config, source: &Source) {
    if let Err(error) = require_command("mutagen")
        .and_then(|()| capture_command("mutagen", ["sync", "list"]))
        .and_then(|existing| sync_start_source(config, source, &existing))
    {
        ui_warn(format!(
            "source {}: sync not started ({error})",
            source.agent
        ));
    }
}

fn apply_source_sync_pause(config: &Config, source: &Source) {
    if let Err(error) = require_command("mutagen").and_then(|()| sync_pause_source(config, source))
    {
        ui_warn(format!(
            "source {}: sync not paused ({error})",
            source.agent
        ));
    }
}

fn apply_source_sync_terminate(config: &Config, source: &Source) {
    if let Err(error) =
        require_command("mutagen").and_then(|()| sync_terminate_source(config, source))
    {
        ui_warn(format!(
            "source {}: sync not terminated ({error})",
            source.agent
        ));
    }
}

fn source_remove_sync_terminate(config: &Config, source: &Source) -> Result<()> {
    match require_command("mutagen") {
        Ok(()) => sync_terminate_source(config, source),
        Err(error) => {
            ui_warn(format!(
                "source {}: sync not terminated ({error})",
                source.agent
            ));
            Ok(())
        }
    }
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

fn sync_ignore_patterns(source: &Source) -> Result<Vec<String>> {
    collect_sync_ignore_patterns(&ignore_path()?, &source_ignore_path(source)?)
}

fn collect_sync_ignore_patterns(global_path: &Path, source_path: &Path) -> Result<Vec<String>> {
    let mut patterns = DEFAULT_SYNC_IGNORES
        .iter()
        .map(|pattern| pattern.to_string())
        .collect::<Vec<_>>();

    extend_ignore_patterns_from_file(&mut patterns, global_path)?;
    extend_ignore_patterns_from_file(&mut patterns, source_path)?;

    Ok(patterns)
}

fn extend_ignore_patterns_from_file(patterns: &mut Vec<String>, path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| UcError::Message(format!("failed to read {}: {error}", path.display())))?;
    patterns.extend(parse_ignore_patterns(&raw));
    Ok(())
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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, default_ignore_file())?;
    Ok(())
}

fn ensure_source_ignore_files(sources: &[Source]) -> Result<()> {
    for source in sources {
        ensure_source_ignore_file(source)?;
    }
    Ok(())
}

fn ensure_source_ignore_file(source: &Source) -> Result<()> {
    let path = source_ignore_path(source)?;
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, default_source_ignore_file(&source.agent))?;
    Ok(())
}

fn default_ignore_file() -> &'static str {
    "# UltraContext ignore file\n\
# Global patterns use Mutagen's default ignore syntax and apply to every synced source.\n\
# Source-specific rules live in ~/.ultracontext/ignores/<source>/.ultracontextignore.\n\
# Comment, edit, or extend any rule. Run `uc sync reset` after ignore edits.\n\
\n\
# Source control\n\
.git/\n\
\n\
# Build and dependency dirs\n\
node_modules/\n\
target/\n\
dist/\n\
build/\n\
.next/\n\
.cache/\n\
\n\
# Runtime logs\n\
logs/\n\
*.log\n\
*.log.*\n\
\n\
# Browser/electron caches (gstack, openclaw, codex web UI)\n\
Cache/\n\
Cache_Data/\n\
GPUCache/\n\
Code Cache/\n\
blob_storage/\n\
\n\
# Sqlite write-ahead and shared-memory sidecars (the .sqlite itself still syncs)\n\
*.sqlite-wal\n\
*.sqlite-shm\n\
\n\
# OS noise\n\
.DS_Store\n\
\n\
# Add extra ignore patterns below.\n"
}

fn default_source_ignore_file(source: &str) -> String {
    if source.eq_ignore_ascii_case("claude") {
        return "# Claude UltraContext ignore file\n\
# Claude has no source-specific default ignores. Add patterns here and run\n\
# `uc sync reset` if you want to exclude anything from Claude.\n"
            .to_string();
    }

    if source.eq_ignore_ascii_case("codex") {
        return "# Codex UltraContext ignore file\n\
# Codex has no source-specific default ignores. Add patterns here and run\n\
# `uc sync reset` if you want to exclude anything from Codex.\n"
            .to_string();
    }

    if source.eq_ignore_ascii_case("openclaw") {
        return "# OpenClaw UltraContext ignore file\n\
# Conversations and complete workspace directories by default. Edit this file and\n\
# run `uc sync reset` to change what UltraContext syncs for OpenClaw.\n\
\n\
# Ignore everything first.\n\
*\n\
\n\
# Allow agent session directories.\n\
!agents/\n\
!agents/*/\n\
!agents/*/sessions/\n\
\n\
# Keep every OpenClaw session artifact, including reset/deleted files and trajectory metadata.\n\
!agents/*/sessions/**\n\
\n\
# Keep complete OpenClaw workspace directories.\n\
!workspace/\n\
!workspace/**\n\
!workspace-*/\n\
!workspace-*/**\n\
\n\
# Keep dependency folders out even when workspace rules re-include their parent directories.\n\
node_modules/\n\
**/node_modules/\n"
            .to_string();
    }

    format!(
        "# UltraContext ignore file for {source}\n\
# Add source-specific patterns here. Run `uc sync reset` after edits.\n"
    )
}

fn config_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(APP_DIR))
}

fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

fn ignore_path() -> Result<PathBuf> {
    Ok(ignores_dir()?.join(IGNORE_FILE))
}

fn ignores_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join(IGNORES_DIR))
}

fn source_ignore_path(source: &Source) -> Result<PathBuf> {
    Ok(ignores_dir()?.join(&source.agent).join(IGNORE_FILE))
}

fn save_config(config: &Config) -> Result<()> {
    fs::create_dir_all(config_dir()?)?;
    fs::write(config_path()?, config.to_toml())?;
    Ok(())
}

fn install_agent_skills() -> Result<Vec<PathBuf>> {
    if env::var("ULTRACONTEXT_INSTALL_SKILL").ok().as_deref() == Some("0") {
        return Ok(Vec::new());
    }

    let targets = skill_targets()?;
    let mut installed = Vec::new();
    for base in targets {
        let dst = base.join("ultracontext");
        if dst.exists() {
            fs::remove_dir_all(&dst)?;
        }
        fs::create_dir_all(&dst)?;
        fs::write(dst.join("SKILL.md"), ULTRACONTEXT_SKILL)?;
        installed.push(dst);
    }
    Ok(installed)
}

fn skill_targets() -> Result<Vec<PathBuf>> {
    if let Ok(raw) = env::var("ULTRACONTEXT_SKILL_TARGETS") {
        return Ok(raw
            .split_whitespace()
            .filter(|target| !target.trim().is_empty())
            .map(PathBuf::from)
            .collect());
    }

    let home = home_dir()?;
    Ok(vec![
        home.join(".claude/skills"),
        home.join(".agents/skills"),
        home.join(".openclaw/skills"),
        home.join(".hermes/skills"),
    ])
}

fn check_local_workspace(config: &Config) {
    match expand_home(&format!("{}/workspace", config.remote_root)) {
        Ok(path) if path.is_dir() => ui_success("local workspace: ok"),
        Ok(path) => ui_warn(format!("local workspace: missing ({})", path.display())),
        Err(error) => ui_warn(format!("local workspace: failed ({error})")),
    }
}

fn check_installation() {
    match env::current_exe() {
        Ok(path) => ui_info(format!("binary: {}", path.display())),
        Err(error) => ui_warn(format!("binary: unknown ({error})")),
    }
    ui_info(format!(
        "install manager: {}",
        detect_install_manager().label()
    ));
    let install_manager = detect_install_manager();
    check_primary_command("ultracontext");
    check_alias_command("uc", install_manager);
}

fn check_primary_command(command: &str) {
    match find_path_commands(command) {
        Ok(paths) if paths.is_empty() => ui_warn(format!("command {command}: missing")),
        Ok(paths) if paths.len() == 1 => ui_success(format!("command {command}: {}", paths[0])),
        Ok(paths) => {
            ui_warn(format!("command {command}: multiple installs found"));
            for path in paths {
                ui_info(format!("  {path}"));
            }
        }
        Err(error) => ui_warn(format!("command {command}: failed ({error})")),
    }
}

fn check_alias_command(command: &str, install_manager: InstallManager) {
    match find_path_commands(command) {
        Ok(paths) => match alias_health(&paths, install_manager) {
            AliasHealth::Healthy => {}
            AliasHealth::Missing => ui_warn(format!("alias {command}: missing")),
            AliasHealth::Multiple => {
                ui_warn(format!("alias {command}: multiple installs found"));
                for path in paths {
                    ui_info(format!("  {path}"));
                }
            }
            AliasHealth::Conflict(manager) => {
                ui_warn(format!(
                    "alias {command}: points to {} install ({})",
                    manager.label(),
                    paths[0]
                ));
            }
        },
        Err(error) => ui_warn(format!("alias {command}: failed ({error})")),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AliasHealth {
    Healthy,
    Missing,
    Multiple,
    Conflict(InstallManager),
}

fn alias_health(paths: &[String], install_manager: InstallManager) -> AliasHealth {
    if paths.is_empty() {
        return AliasHealth::Missing;
    }
    if paths.len() > 1 {
        return AliasHealth::Multiple;
    }

    let alias_manager = infer_install_manager_from_command_path(&paths[0]);
    if install_manager != InstallManager::Unknown
        && alias_manager != InstallManager::Unknown
        && alias_manager != install_manager
    {
        return AliasHealth::Conflict(alias_manager);
    }

    AliasHealth::Healthy
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
        Ok(()) => ui_success(format!("local {name}: ok")),
        Err(_) => ui_warn(format!("local {name}: missing")),
    }
}

fn check_remote(config: &Config, label: &str, command: &str) {
    let status = external_command("ssh")
        .arg(&config.remote)
        .arg(command)
        .status();
    match status {
        Ok(status) if status.success() => ui_success(format!("remote {label}: ok")),
        _ => ui_warn(format!("remote {label}: failed")),
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

fn run_command_with_stdin<I, S>(program: &str, args: I, stdin_text: &str) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let mut child = external_command(program)
        .args(&args)
        .stdin(Stdio::piped())
        .spawn()?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(stdin_text.as_bytes())?;
        stdin.write_all(b"\n")?;
    }
    let status = child.wait()?;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallManager {
    Standalone,
    Npm,
    Cargo,
    Homebrew,
    Unknown,
}

impl InstallManager {
    fn label(self) -> &'static str {
        match self {
            InstallManager::Standalone => "standalone",
            InstallManager::Npm => "npm",
            InstallManager::Cargo => "cargo",
            InstallManager::Homebrew => "homebrew",
            InstallManager::Unknown => "unknown",
        }
    }
}

fn detect_install_manager() -> InstallManager {
    if let Ok(manager) = env::var("ULTRACONTEXT_INSTALLER") {
        return parse_install_manager(&manager);
    }

    if let Ok(path) = env::current_exe() {
        let path = path.to_string_lossy().to_string();
        if let Some(manager) = infer_install_manager_from_path(&path) {
            return manager;
        }
    }

    InstallManager::Unknown
}

fn parse_install_manager(value: &str) -> InstallManager {
    match value.trim().to_ascii_lowercase().as_str() {
        "standalone" | "script" | "install.sh" => InstallManager::Standalone,
        "npm" => InstallManager::Npm,
        "cargo" => InstallManager::Cargo,
        "homebrew" | "brew" => InstallManager::Homebrew,
        _ => InstallManager::Unknown,
    }
}

fn infer_install_manager_from_path(path: &str) -> Option<InstallManager> {
    let normalized = normalize_path_text(path);
    if normalized.contains("/node_modules/ultracontext/npm/native/")
        || normalized.contains("/npm/native/ultracontext")
    {
        return Some(InstallManager::Npm);
    }
    if normalized.contains("/.cargo/bin/") {
        return Some(InstallManager::Cargo);
    }
    if normalized.starts_with("/opt/homebrew/") || normalized.starts_with("/usr/local/cellar/") {
        return Some(InstallManager::Homebrew);
    }
    if normalized.contains("/.local/bin/ultracontext") || normalized.contains("/.local/bin/uc") {
        return Some(InstallManager::Standalone);
    }
    None
}

fn infer_install_manager_from_command_path(path: &str) -> InstallManager {
    let mut combined = path.to_string();
    if let Ok(resolved) = fs::canonicalize(path) {
        combined.push(' ');
        combined.push_str(&resolved.to_string_lossy());
    }
    infer_install_manager_from_path(&combined).unwrap_or(InstallManager::Unknown)
}

fn normalize_path_text(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

fn find_path_commands(command: &str) -> Result<Vec<String>> {
    let shell_command = format!("which -a {} 2>/dev/null || true", sh_quote(command));
    let output = capture_command("sh", ["-c", shell_command.as_str()])?;
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if seen.insert(line.to_string()) {
            paths.push(line.to_string());
        }
    }
    Ok(paths)
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
                if let Some(agent) = section_name.strip_prefix("sources.") {
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
                    _ => return Err(UcError::Message(format!("unknown config key: {key}"))),
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
            sources,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConfigSection {
    Root,
    Source,
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
            sources: vec![],
        };
        let source = Source {
            agent: "codex".to_string(),
            local_path: "~/.codex".to_string(),
            enabled: true,
        };

        assert_eq!(
            remote_dir(&cfg, &source),
            "~/.ultracontext/workspace/work-laptop/.codex"
        );

        let custom_source = Source {
            agent: "project_notes".to_string(),
            local_path: "~/notes".to_string(),
            enabled: true,
        };
        assert_eq!(
            remote_dir(&cfg, &custom_source),
            "~/.ultracontext/workspace/work-laptop/project_notes"
        );
    }

    #[test]
    fn local_remote_uses_plain_filesystem_endpoint() {
        let cfg = Config {
            remote: "local".to_string(),
            remote_root: "/tmp/uc".to_string(),
            host_id: "mini".to_string(),
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
            "/tmp/uc/workspace/mini/.codex"
        );
    }

    #[test]
    fn deletes_local_remote_source_copy() {
        let root = env::temp_dir().join(format!(
            "uc-delete-source-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg = Config {
            remote: "local".to_string(),
            remote_root: root.to_string_lossy().to_string(),
            host_id: "mini".to_string(),
            sources: vec![],
        };
        let source = Source {
            agent: "codex".to_string(),
            local_path: "~/.codex".to_string(),
            enabled: true,
        };
        let copy = PathBuf::from(remote_dir(&cfg, &source));
        fs::create_dir_all(copy.join("nested")).unwrap();
        fs::write(copy.join("nested").join("session.jsonl"), "{}").unwrap();

        delete_remote_source_dir(&cfg, &source).unwrap();

        assert!(!copy.exists());
        let _ = fs::remove_dir_all(root);
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
    fn reconfigure_source_defaults_keep_existing_sources_selected() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "/srv/ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            sources: vec![
                Source {
                    agent: "codex".to_string(),
                    local_path: "~/CustomCodex".to_string(),
                    enabled: true,
                },
                Source {
                    agent: "project_notes".to_string(),
                    local_path: "~/Notes".to_string(),
                    enabled: false,
                },
            ],
        };

        let sources = setup_source_defaults(Some(&cfg));
        let selected = configured_source_names(&cfg);

        assert_eq!(
            selected,
            vec!["codex".to_string(), "project_notes".to_string()]
        );
        assert_eq!(
            sources
                .iter()
                .map(|source| source.agent.as_str())
                .collect::<Vec<_>>(),
            vec!["codex", "project_notes", "openclaw", "claude", "hermes"]
        );
        assert_eq!(sources[0].local_path, "~/CustomCodex");
    }

    #[test]
    fn noninteractive_init_preserves_existing_sources() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "/srv/ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            sources: vec![Source {
                agent: "codex".to_string(),
                local_path: "~/CustomCodex".to_string(),
                enabled: true,
            }],
        };

        assert_eq!(noninteractive_init_sources(Some(&cfg)), cfg.sources);
    }

    #[test]
    fn keyboard_select_defaults_skip_disabled_options() {
        let options = vec![
            SelectOption {
                value: "cloud",
                label: "UltraContext Cloud".to_string(),
                hint: "coming soon".to_string(),
                disabled: true,
            },
            SelectOption {
                value: "self-hosted",
                label: "Self-hosted VPS".to_string(),
                hint: "use your own SSH server".to_string(),
                disabled: false,
            },
        ];

        assert_eq!(initial_select_cursor(&options, &"self-hosted"), 1);
        assert_eq!(move_select_cursor(&options, 1, -1), 1);
    }

    #[test]
    fn finds_all_owned_mutagen_sessions_for_reset() {
        let cfg = Config {
            remote: "local".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "mini".to_string(),
            sources: vec![],
        };
        let existing = "Name: uc-mini-claude\nName: uc-mini-oldsource\nName: uc-other-codex\n";

        assert_eq!(
            owned_mutagen_session_names(&cfg, existing),
            vec!["uc-mini-claude", "uc-mini-oldsource"]
        );
    }

    #[test]
    fn builds_sync_list_entries_for_configured_and_orphan_sessions() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "/srv/uc".to_string(),
            host_id: "work-laptop".to_string(),
            sources: vec![
                Source {
                    agent: "claude".to_string(),
                    local_path: "~/.claude".to_string(),
                    enabled: true,
                },
                Source {
                    agent: "codex".to_string(),
                    local_path: "~/.codex".to_string(),
                    enabled: false,
                },
            ],
        };
        let existing = r#"
Name: uc-work-laptop-claude
Status: Watching for changes

Name: uc-work-laptop-old
Status: Paused

Name: uc-other-codex
Status: Watching for changes
"#;

        let entries = sync_list_entries(&cfg, existing);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].source, "claude");
        assert_eq!(entries[0].source_state, "enabled");
        assert_eq!(entries[0].session, "uc-work-laptop-claude");
        assert_eq!(entries[0].sync_state, "Watching for changes");
        assert_eq!(entries[0].local_path.as_deref(), Some("~/.claude"));
        assert_eq!(
            entries[0].remote_endpoint.as_deref(),
            Some("user@vps:/srv/uc/workspace/work-laptop/.claude")
        );
        assert_eq!(entries[1].source, "codex");
        assert_eq!(entries[1].source_state, "disabled");
        assert_eq!(entries[1].sync_state, "missing");
        assert_eq!(entries[2].source, "old");
        assert_eq!(entries[2].source_state, "orphan");
        assert_eq!(entries[2].sync_state, "Paused");
        assert_eq!(entries[2].local_path, None);
    }

    #[test]
    fn parses_source_remove_confirmation_flag() {
        let args = vec!["codex".to_string(), "--yes".to_string()];
        let request = parse_source_remove_args(&args).unwrap().unwrap();

        assert_eq!(
            request,
            SourceRemoveRequest {
                name: "codex".to_string(),
                yes: true
            }
        );
    }

    #[test]
    fn source_remove_help_is_not_a_request() {
        let args = vec!["--help".to_string()];

        assert_eq!(parse_source_remove_args(&args).unwrap(), None);
    }

    #[test]
    fn sync_remove_points_to_source_remove() {
        let message = sync_remove_removed_message(Some("codex"));

        assert!(message.contains("`uc sync remove` was removed"));
        assert!(message.contains("uc source remove codex"));
        assert!(message.contains("uc sync stop"));
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
    fn combines_global_and_source_ignore_patterns_in_order() {
        let root = env::temp_dir().join(format!(
            "uc-source-ignore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let global = root.join("global.ignore");
        let source = root.join("source").join(IGNORE_FILE);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&global, "node_modules/\nlogs/\n").unwrap();
        fs::write(&source, "*\n!sessions/\n!sessions/**\n").unwrap();

        let patterns = collect_sync_ignore_patterns(&global, &source).unwrap();

        assert_eq!(
            patterns,
            vec![
                "node_modules/".to_string(),
                "logs/".to_string(),
                "*".to_string(),
                "!sessions/".to_string(),
                "!sessions/**".to_string(),
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_missing_source_ignore_file() {
        let root = env::temp_dir().join(format!(
            "uc-missing-source-ignore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let global = root.join("global.ignore");
        let missing_source = root.join("source").join(IGNORE_FILE);
        fs::write(&global, "node_modules/\n").unwrap();

        let patterns = collect_sync_ignore_patterns(&global, &missing_source).unwrap();

        assert_eq!(patterns, vec!["node_modules/".to_string()]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn openclaw_source_ignore_defaults_to_conversations_and_workspaces() {
        let patterns = parse_ignore_patterns(&default_source_ignore_file("openclaw"));

        assert_eq!(patterns[0], "*");
        assert!(patterns.contains(&"!agents/".to_string()));
        assert!(patterns.contains(&"!agents/*/sessions/".to_string()));
        assert!(patterns.contains(&"!agents/*/sessions/**".to_string()));
        assert!(patterns.contains(&"!workspace/".to_string()));
        assert!(patterns.contains(&"!workspace/**".to_string()));
        assert!(patterns.contains(&"!workspace-*/".to_string()));
        assert!(patterns.contains(&"!workspace-*/**".to_string()));
        assert!(patterns.contains(&"node_modules/".to_string()));
        assert!(patterns.contains(&"**/node_modules/".to_string()));
        assert!(
            patterns
                .iter()
                .position(|pattern| pattern == "node_modules/")
                > patterns
                    .iter()
                    .position(|pattern| pattern == "!workspace-*/**")
        );
        assert!(!patterns.contains(&"!workspace/AGENTS.md".to_string()));
        assert!(!patterns.contains(&"!workspace-*/AGENTS.md".to_string()));
        assert!(!patterns.contains(&"!workspace/memory/**".to_string()));
        assert!(!patterns.contains(&"!workspace-*/memory/**".to_string()));
        assert!(!patterns.contains(&"!agents/*/qmd/".to_string()));
    }

    #[test]
    fn claude_source_ignore_defaults_to_no_source_specific_rules() {
        let patterns = parse_ignore_patterns(&default_source_ignore_file("claude"));

        assert!(patterns.is_empty(), "{patterns:?}");
    }

    #[test]
    fn codex_source_ignore_defaults_to_no_source_specific_rules() {
        let patterns = parse_ignore_patterns(&default_source_ignore_file("codex"));

        assert!(patterns.is_empty(), "{patterns:?}");
    }

    #[test]
    fn custom_source_ignore_defaults_to_comments_only() {
        assert!(parse_ignore_patterns(&default_source_ignore_file("project_notes")).is_empty());
    }

    #[test]
    fn sync_create_args_use_user_ignore_template_without_secret_ignores() {
        let local_path = PathBuf::from("/tmp/source");
        let ignore_patterns = parse_ignore_patterns(default_ignore_file());

        let args = sync_create_args(
            "uc-test-codex",
            &local_path,
            "user@vps:~/.ultracontext/workspace/test/.codex".to_string(),
            &ignore_patterns,
        );

        assert!(args.contains(&"--ignore=.git/".to_string()));
        assert!(args.contains(&"--ignore=node_modules/".to_string()));
        assert!(args.contains(&"--ignore=logs/".to_string()));
        assert!(args.contains(&"--ignore=*.log".to_string()));
        assert!(args.contains(&"--ignore=Cache/".to_string()));
        assert!(args.contains(&"--ignore=*.sqlite-wal".to_string()));
        assert!(args.contains(&"--ignore=.DS_Store".to_string()));
        assert!(!args.contains(&"--ignore=.env".to_string()));
        assert!(!args.contains(&"--ignore=auth.json".to_string()));
        assert_eq!(args[args.len() - 2], "/tmp/source");
        assert!(DEFAULT_SYNC_IGNORES.is_empty());
    }

    #[test]
    fn infers_install_manager_from_binary_path() {
        assert_eq!(
            infer_install_manager_from_path(
                "/usr/local/lib/node_modules/ultracontext/npm/native/ultracontext"
            ),
            Some(InstallManager::Npm)
        );
        assert_eq!(
            infer_install_manager_from_path("/Users/fabio/.cargo/bin/ultracontext"),
            Some(InstallManager::Cargo)
        );
        assert_eq!(
            infer_install_manager_from_path("/Users/fabio/.local/bin/ultracontext"),
            Some(InstallManager::Standalone)
        );
        assert_eq!(
            infer_install_manager_from_path("/Users/fabio/.local/bin/uc"),
            Some(InstallManager::Standalone)
        );
        assert_eq!(
            infer_install_manager_from_path("/opt/homebrew/bin/ultracontext"),
            Some(InstallManager::Homebrew)
        );
    }

    #[test]
    fn treats_matching_uc_alias_as_healthy() {
        assert_eq!(
            alias_health(
                &["/Users/fabio/.cargo/bin/uc".to_string()],
                InstallManager::Cargo
            ),
            AliasHealth::Healthy
        );
        assert_eq!(
            alias_health(&[], InstallManager::Cargo),
            AliasHealth::Missing
        );
        assert_eq!(
            alias_health(
                &[
                    "/Users/fabio/.cargo/bin/uc".to_string(),
                    "/Users/fabio/.local/bin/uc".to_string()
                ],
                InstallManager::Cargo
            ),
            AliasHealth::Multiple
        );
        assert_eq!(
            alias_health(
                &["/Users/fabio/.local/bin/uc".to_string()],
                InstallManager::Cargo
            ),
            AliasHealth::Conflict(InstallManager::Standalone)
        );
    }

    #[test]
    fn parses_mutagen_session_status() {
        let list = r#"
Name: uc-host-claude
Identifier: abc
Status: Watching for changes

Name: uc-host-codex
Identifier: def
Status: Paused
"#;

        assert_eq!(
            mutagen_session_status(list, "uc-host-claude"),
            Some("Watching for changes".to_string())
        );
        assert_eq!(
            mutagen_session_status(list, "uc-host-codex"),
            Some("Paused".to_string())
        );
        assert_eq!(mutagen_session_status(list, "uc-host-openclaw"), None);
    }

    #[test]
    fn parses_status_lines_that_end_with_files() {
        let list = r#"
Name: uc-host-openclaw
Alpha:
	URL: /Users/fabioroma/.openclaw
	Connected: Yes
Beta:
	URL: uc:~/.ultracontext/workspace/host/.openclaw
	Connected: Yes
Status: Scanning files
"#;

        let sessions = parse_mutagen_sessions(list);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, "Scanning files");
        assert_eq!(sessions[0].beta_files, None);
    }

    #[test]
    fn parses_mutagen_transition_problems() {
        let list = r#"
Name: uc-host-openclaw
Alpha:
	URL: /Users/fabioroma/.openclaw
	Connected: Yes
Beta:
	URL: uc:~/.ultracontext/workspace/host/.openclaw
	Connected: Yes
	Transition problems:
		nodes/paired.json: unable to create file
Status: Scanning files
"#;

        let sessions = parse_mutagen_sessions(list);

        assert_eq!(
            sessions[0].transition_problems,
            vec!["nodes/paired.json: unable to create file".to_string()]
        );
        assert_eq!(sessions[0].status, "Scanning files");
    }

    #[test]
    fn derives_progress_from_mutagen_file_counts() {
        let session = SessionInfo {
            status: "Staging files on beta".to_string(),
            alpha_files: Some(100),
            beta_files: Some(25),
            ..Default::default()
        };

        assert_eq!(
            session_progress(&session),
            Some(SessionProgress {
                pct: 25,
                current_files: Some(25),
                total_files: Some(100)
            })
        );
    }

    #[test]
    fn hides_count_progress_for_stable_sessions() {
        let session = SessionInfo {
            status: "Watching for changes".to_string(),
            alpha_files: Some(100),
            beta_files: Some(100),
            ..Default::default()
        };

        assert_eq!(session_progress(&session), None);
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
