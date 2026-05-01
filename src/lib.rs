use console::{Key, Term, style};
use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, Once};

const APP_DIR: &str = ".ultracontext";
const IGNORE_FILE: &str = ".ultracontextignore";
const IGNORES_DIR: &str = "ignores";
const DEFAULT_REMOTE_ROOT: &str = "~/.ultracontext";
const DEFAULT_QUERY_COMMAND: &str = "claude";
const QUERY_PROMPT_PLACEHOLDER: &str = "{{prompt}}";
const DEFAULT_QUERY_ARGS: &str =
    "-p {{prompt}} --dangerously-skip-permissions --effort medium --model sonnet";
// Seed contents shipped with the binary; written to disk on `uc init` so users
// can edit it without rebuilding. At runtime we read from disk; if the file is
// missing we send the raw user query straight to the query agent.
const DEFAULT_QUERY_PROMPT: &str = include_str!("prompts/query.md");
const PROMPT_FILE: &str = "prompts/query.md";
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
struct QueryConfig {
    command: String,
    args: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    remote: String,
    remote_root: String,
    host_id: String,
    query: QueryConfig,
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
        Some("query") => cmd_query(&args[2..]),
        Some("status") => cmd_status(&args[2..]),
        Some("doctor") => cmd_doctor(),
        Some("update") => cmd_update(&args[2..]),
        Some("version" | "-V" | "--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(command) => Err(UcError::Message(format!("unknown command: {command}"))),
    }
}

fn print_help() {
    println!(
        "UltraContext {}\n\nUsage:\n  uc init [local|user@host]\n  uc status\n  uc sync <start|list|status|stop|reset>\n  uc source <list|add|remove|enable|disable>\n  uc query <query>\n  uc doctor\n  uc update\n",
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
                Key::ArrowDown | Key::ArrowRight | Key::Char('j') => {
                    if cursor + 1 < options.len() {
                        cursor += 1;
                    }
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
        } else if option.disabled {
            format!(" {}", style(format!("({})", option.hint)).dim())
        } else if selected && !submitted {
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
        query: QueryConfig {
            command: DEFAULT_QUERY_COMMAND.to_string(),
            args: DEFAULT_QUERY_ARGS.to_string(),
        },
        sources,
    };

    fs::create_dir_all(config_dir()?)?;
    if config.is_local() {
        fs::create_dir_all(expand_home(&config.remote_root)?)?;
    }
    fs::write(config_path()?, config.to_toml())?;
    ensure_ignore_file()?;
    ensure_source_ignore_files(&config.sources)?;
    ensure_prompt_file()?;
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
    if owned_mutagen_session_names(&config, &existing).is_empty() {
        migrate_legacy_host_workspace(&config)?;
    }
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
    if path_changed {
        if let Some(old_source) = old_source.as_ref() {
            apply_source_sync_terminate(&config, old_source);
        }
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

fn cmd_query(args: &[String]) -> Result<()> {
    if args.is_empty() || args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("Usage: uc query <query>");
        return Ok(());
    }

    let config = load_config()?;
    let user_query = args.join(" ");
    let workspace_path = format!("{}/workspace", config.remote_root);
    let prompt = query_prompt(&workspace_path, &user_query);

    if config.is_local() {
        run_local_query(&config, &workspace_path, &prompt)
    } else {
        let remote_command = query_remote_command(&config, &workspace_path, &prompt)?;
        run_command("ssh", [config.remote.as_str(), remote_command.as_str()])
    }
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

fn query_remote_command(config: &Config, workspace_path: &str, prompt: &str) -> Result<String> {
    let command_setup = query_command_setup(config);
    let args = query_command_shell_args(&config.query, prompt)?;
    Ok(format!(
        "{}; \
cd {} && \"$QUERY_BIN\" {} < /dev/null",
        command_setup,
        remote_path_arg(&workspace_path),
        args
    ))
}

fn run_local_query(config: &Config, workspace_path: &str, prompt: &str) -> Result<()> {
    let workspace_dir = expand_home(workspace_path)?;
    if !workspace_dir.exists() {
        return Err(UcError::Message(format!(
            "local workspace directory does not exist: {}",
            workspace_dir.display()
        )));
    }

    let command = resolve_local_query_command(&config.query.command)?;
    let args = query_command_args(&config.query, prompt)?;
    let mut child = external_command(&command)
        .args(&args)
        .current_dir(workspace_dir)
        .stdin(Stdio::null())
        .spawn()?;
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(UcError::Message(format!(
            "{} exited with {}",
            command_display(&command, &query_command_display_args(&config.query)),
            status
        )))
    }
}

fn query_command_args(config: &QueryConfig, prompt: &str) -> Result<Vec<String>> {
    let args = shell_words(&config.args);
    if !args
        .iter()
        .any(|arg| arg.contains(QUERY_PROMPT_PLACEHOLDER))
    {
        return Err(UcError::Message(format!(
            "[query].args must include {QUERY_PROMPT_PLACEHOLDER}; for Claude use: args = \"{DEFAULT_QUERY_ARGS}\""
        )));
    }

    Ok(args
        .into_iter()
        .map(|arg| arg.replace(QUERY_PROMPT_PLACEHOLDER, prompt))
        .collect())
}

fn query_command_display_args(config: &QueryConfig) -> Vec<String> {
    shell_words(&config.args)
        .into_iter()
        .map(|arg| arg.replace(QUERY_PROMPT_PLACEHOLDER, "<prompt>"))
        .collect()
}

fn query_command_shell_args(config: &QueryConfig, prompt: &str) -> Result<String> {
    Ok(query_command_args(config, prompt)?
        .iter()
        .map(|arg| sh_quote(arg))
        .collect::<Vec<_>>()
        .join(" "))
}

fn resolve_local_query_command(command: &str) -> Result<String> {
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

fn query_command_setup(config: &Config) -> String {
    let command_setup = if config.query.command == "claude" {
        "QUERY_BIN=$(command -v claude || true); \
if [ -z \"$QUERY_BIN\" ] && [ -x \"$HOME/.local/bin/claude\" ]; then QUERY_BIN=\"$HOME/.local/bin/claude\"; fi; \
if [ -z \"$QUERY_BIN\" ]; then echo 'claude not found on remote PATH or ~/.local/bin/claude' >&2; exit 127; fi"
            .to_string()
    } else {
        format!(
            "QUERY_BIN=$(command -v {} || true); \
if [ -z \"$QUERY_BIN\" ]; then echo {} >&2; exit 127; fi",
            sh_quote(&config.query.command),
            sh_quote(&format!(
                "{} not found on remote PATH",
                config.query.command
            ))
        )
    };
    command_setup
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
            check_local_query_command(&config.query.command);
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
                &config.query.command,
                &format!("command -v {} >/dev/null", sh_quote(&config.query.command)),
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

    match detect_install_manager() {
        InstallManager::Standalone => {
            println!("Updating UltraContext with installer:");
            println!("  {INSTALL_URL}");
            let command = format!("curl -fsSL {INSTALL_URL} | sh");
            run_command("sh", ["-c", command.as_str()])
        }
        InstallManager::Npm => {
            println!("UltraContext is managed by npm.");
            println!("Update with: npm update -g ultracontext");
            Ok(())
        }
        InstallManager::Cargo => {
            println!("UltraContext is managed by Cargo.");
            println!("Update with: cargo install ultracontext --force");
            Ok(())
        }
        InstallManager::Homebrew => {
            println!("UltraContext appears to be managed by Homebrew.");
            println!("Update with: brew upgrade ultracontext");
            Ok(())
        }
        InstallManager::Unknown => {
            println!("Could not determine how UltraContext was installed.");
            println!("Use one of:");
            println!("  curl -fsSL {INSTALL_URL} | sh");
            println!("  npm update -g ultracontext");
            println!("  cargo install ultracontext --force");
            Ok(())
        }
    }
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
    let legacy_old_dir = legacy_host_workspace_dir(config);
    let new_dir = host_workspace_dir_for_id(config, new_host_id);

    if config.is_local() {
        let old_path = expand_home(&old_dir)?;
        let legacy_old_path = expand_home(&legacy_old_dir)?;
        let new_path = expand_home(&new_dir)?;
        move_or_delete_local_workspace(&old_path, &new_path, &config.host_id, new_host_id)?;
        move_or_delete_local_workspace(&legacy_old_path, &new_path, &config.host_id, new_host_id)?;
        return Ok(());
    }

    let old_arg = remote_path_arg(&old_dir);
    let legacy_old_arg = remote_path_arg(&legacy_old_dir);
    let new_arg = remote_path_arg(&new_dir);
    let workspace_arg = remote_path_arg(&workspace_root(config));
    let command = format!(
        "mkdir -p {workspace_arg}; \
if [ -d {old_arg} ] && [ ! -e {new_arg} ]; then mv {old_arg} {new_arg}; \
elif [ -d {old_arg} ] && [ -d {new_arg} ] && [ -z \"$(ls -A {new_arg} 2>/dev/null)\" ]; then rm -rf {new_arg}; mv {old_arg} {new_arg}; \
elif [ -d {old_arg} ] && [ -e {new_arg} ]; then rm -rf {old_arg}; fi; \
if [ -d {legacy_old_arg} ] && [ ! -e {new_arg} ]; then mv {legacy_old_arg} {new_arg}; \
elif [ -d {legacy_old_arg} ] && [ -d {new_arg} ] && [ -z \"$(ls -A {new_arg} 2>/dev/null)\" ]; then rm -rf {new_arg}; mv {legacy_old_arg} {new_arg}; \
elif [ -d {legacy_old_arg} ] && [ -e {new_arg} ]; then rm -rf {legacy_old_arg}; fi"
    );
    run_command("ssh", [config.remote.as_str(), command.as_str()])
}

fn migrate_legacy_host_workspace(config: &Config) -> Result<()> {
    let old_dir = legacy_host_workspace_dir(config);
    let new_dir = host_workspace_dir(config);

    if config.is_local() {
        let old_path = expand_home(&old_dir)?;
        let new_path = expand_home(&new_dir)?;
        move_or_delete_local_workspace(&old_path, &new_path, &config.host_id, &config.host_id)?;
        return Ok(());
    }

    let old_arg = remote_path_arg(&old_dir);
    let new_arg = remote_path_arg(&new_dir);
    let workspace_arg = remote_path_arg(&workspace_root(config));
    let command = format!(
        "mkdir -p {workspace_arg}; \
if [ -d {old_arg} ] && [ ! -e {new_arg} ]; then mv {old_arg} {new_arg}; \
elif [ -d {old_arg} ] && [ -d {new_arg} ] && [ -z \"$(ls -A {new_arg} 2>/dev/null)\" ]; then rm -rf {new_arg}; mv {old_arg} {new_arg}; \
elif [ -d {old_arg} ] && [ -e {new_arg} ]; then rm -rf {old_arg}; fi"
    );
    run_command("ssh", [config.remote.as_str(), command.as_str()])
}

fn move_or_delete_local_workspace(
    old_path: &Path,
    new_path: &Path,
    old_host_id: &str,
    new_host_id: &str,
) -> Result<()> {
    if !old_path.exists() {
        return Ok(());
    }
    if new_path.exists() {
        if new_path.is_dir() && directory_is_empty(new_path)? {
            fs::remove_dir_all(new_path)?;
        } else {
            ui_step(format!("remove old workspace {old_host_id}"));
            fs::remove_dir_all(old_path)?;
            return Ok(());
        }
    }
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent)?;
    }
    ui_step(format!("move workspace {old_host_id} -> {new_host_id}"));
    fs::rename(old_path, new_path)?;
    Ok(())
}

fn directory_is_empty(path: &Path) -> Result<bool> {
    Ok(fs::read_dir(path)?.next().is_none())
}

// Render the prompt the query agent will receive.
// If the user has a prompt file at ~/.ultracontext/prompts/query.md,
// substitute {{workspace_path}} and {{query}} into it. If not, return the bare
// user query so the agent sees only that.
fn query_prompt(workspace_path: &str, user_query: &str) -> String {
    match read_prompt_file() {
        Some(template) => render_prompt(&template, workspace_path, user_query),
        None => user_query.to_string(),
    }
}

// Pure substitution, separated for testability.
fn render_prompt(template: &str, workspace_path: &str, user_query: &str) -> String {
    template
        .replace("{{workspace_path}}", workspace_path)
        .replace("{{query}}", user_query)
}

fn prompt_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(PROMPT_FILE))
}

fn read_prompt_file() -> Option<String> {
    let path = prompt_path().ok()?;
    fs::read_to_string(&path)
        .ok()
        .filter(|s| !s.trim().is_empty())
}

// Seed the default prompt on disk if missing; non-fatal on error.
fn ensure_prompt_file() -> Result<()> {
    let path = prompt_path()?;
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, DEFAULT_QUERY_PROMPT)?;
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

fn legacy_host_workspace_dir(config: &Config) -> String {
    format!(
        "{}/workspace/sessions/{}",
        config.remote_root, config.host_id
    )
}

fn remote_dir_for_name(config: &Config, dir_name: &str) -> String {
    format!("{}/{}", host_workspace_dir(config), dir_name)
}

fn legacy_remote_dir_for_name(config: &Config, dir_name: &str) -> String {
    format!("{}/{}", legacy_host_workspace_dir(config), dir_name)
}

fn remote_dir(config: &Config, source: &Source) -> String {
    remote_dir_for_name(config, &remote_source_dir_name(source))
}

fn remote_dirs_to_delete(config: &Config, source: &Source) -> Vec<String> {
    let current = remote_source_dir_name(source);
    let mut dirs = vec![
        remote_dir_for_name(config, &current),
        legacy_remote_dir_for_name(config, &current),
    ];
    if current != source.agent {
        dirs.push(remote_dir_for_name(config, &source.agent));
        dirs.push(legacy_remote_dir_for_name(config, &source.agent));
    }
    dirs.dedup();
    dirs
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
        if in_session {
            if let Some(status) = line.strip_prefix("Status: ") {
                return Some(status.to_string());
            }
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
    ])
}

fn check_local_workspace(config: &Config) {
    match expand_home(&format!("{}/workspace", config.remote_root)) {
        Ok(path) if path.is_dir() => ui_success("local workspace: ok"),
        Ok(path) => ui_warn(format!("local workspace: missing ({})", path.display())),
        Err(error) => ui_warn(format!("local workspace: failed ({error})")),
    }
}

fn check_local_query_command(name: &str) {
    match resolve_local_query_command(name) {
        Ok(command) if command.contains('/') && Path::new(&command).is_file() => {
            ui_success(format!("local {name}: ok ({command})"))
        }
        Ok(command) if command.contains('/') => {
            ui_warn(format!("local {name}: missing ({command})"))
        }
        Ok(command) => check_local_command(&command),
        Err(_) => ui_warn(format!("local {name}: missing")),
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
        out.push_str("[query]\n");
        out.push_str(&format!(
            "command = \"{}\"\n",
            escape_toml(&self.query.command)
        ));
        out.push_str(&format!("args = \"{}\"\n", escape_toml(&self.query.args)));
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
        let mut query = QueryConfig {
            command: DEFAULT_QUERY_COMMAND.to_string(),
            args: DEFAULT_QUERY_ARGS.to_string(),
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
                if section_name == "query" {
                    section = ConfigSection::Query;
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
                    _ => return Err(UcError::Message(format!("unknown config key: {key}"))),
                },
                ConfigSection::Query => match key {
                    "command" => query.command = parse_string_value(value)?,
                    "args" => query.args = parse_string_value(value)?,
                    _ => return Err(UcError::Message(format!("unknown query key: {key}"))),
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
            query,
            sources,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConfigSection {
    Root,
    Query,
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
            query: QueryConfig {
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
            query: QueryConfig {
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
            query: QueryConfig {
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
            query: QueryConfig {
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
        let copy = PathBuf::from(remote_dir(&cfg, &source));
        let old_canonical_copy = root.join("workspace").join("mini").join("codex");
        let legacy_dot_copy = root
            .join("workspace")
            .join("sessions")
            .join("mini")
            .join(".codex");
        let legacy_copy = root
            .join("workspace")
            .join("sessions")
            .join("mini")
            .join("codex");
        fs::create_dir_all(copy.join("nested")).unwrap();
        fs::write(copy.join("nested").join("session.jsonl"), "{}").unwrap();
        fs::create_dir_all(old_canonical_copy.join("nested")).unwrap();
        fs::write(
            old_canonical_copy.join("nested").join("session.jsonl"),
            "{}",
        )
        .unwrap();
        fs::create_dir_all(legacy_dot_copy.join("nested")).unwrap();
        fs::write(legacy_dot_copy.join("nested").join("session.jsonl"), "{}").unwrap();
        fs::create_dir_all(legacy_copy.join("nested")).unwrap();
        fs::write(legacy_copy.join("nested").join("session.jsonl"), "{}").unwrap();

        delete_remote_source_dir(&cfg, &source).unwrap();

        assert!(!copy.exists());
        assert!(!old_canonical_copy.exists());
        assert!(!legacy_dot_copy.exists());
        assert!(!legacy_copy.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reconfigured_host_moves_legacy_workspace_to_canonical_path() {
        let root = env::temp_dir().join(format!(
            "uc-move-workspace-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg = Config {
            remote: "local".to_string(),
            remote_root: root.to_string_lossy().to_string(),
            host_id: "old-host".to_string(),
            query: QueryConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
            sources: vec![],
        };
        let legacy_file = root
            .join("workspace")
            .join("sessions")
            .join("old-host")
            .join(".codex")
            .join("history.jsonl");
        fs::create_dir_all(legacy_file.parent().unwrap()).unwrap();
        fs::write(&legacy_file, "{}").unwrap();

        move_host_workspace(&cfg, "new-host").unwrap();

        assert!(
            root.join("workspace")
                .join("new-host")
                .join(".codex")
                .join("history.jsonl")
                .is_file()
        );
        assert!(
            !root
                .join("workspace")
                .join("sessions")
                .join("old-host")
                .exists()
        );
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
            query: QueryConfig {
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
    fn reconfigure_source_defaults_keep_existing_sources_selected() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "/srv/ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            query: QueryConfig {
                command: "claude".to_string(),
                args: "--dangerously-skip-permissions".to_string(),
            },
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
            query: QueryConfig {
                command: "claude".to_string(),
                args: DEFAULT_QUERY_ARGS.to_string(),
            },
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
            query: QueryConfig {
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
    fn builds_sync_list_entries_for_configured_and_orphan_sessions() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "/srv/uc".to_string(),
            host_id: "work-laptop".to_string(),
            query: QueryConfig {
                command: "claude".to_string(),
                args: DEFAULT_QUERY_ARGS.to_string(),
            },
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
    fn renders_default_query_prompt_from_template() {
        let prompt = render_prompt(DEFAULT_QUERY_PROMPT, "/remote/workspace", "what changed?");

        assert!(prompt.contains("/remote/workspace"));
        assert!(prompt.contains("what changed?"));
        assert!(prompt.contains("subagents"));
        assert!(!prompt.contains("{{workspace_path}}"));
        assert!(!prompt.contains("{{query}}"));
    }

    #[test]
    fn render_prompt_returns_template_with_substitutions() {
        let template = "ctx={{workspace_path}} q={{query}}";
        assert_eq!(
            render_prompt(template, "/tmp/workspace", "find X"),
            "ctx=/tmp/workspace q=find X"
        );
    }

    #[test]
    fn uses_configured_query_command_and_args() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            query: QueryConfig {
                command: "custom-query".to_string(),
                args: "-p {{prompt}} --dangerously-skip-permissions --effort low --model sonnet"
                    .to_string(),
            },
            sources: vec![],
        };

        let command = query_remote_command(&cfg, "~/.ultracontext/workspace", "prompt").unwrap();

        assert!(command.contains("command -v 'custom-query'"), "{command}");
        assert!(command.contains("'-p' 'prompt'"), "{command}");
        assert!(
            command.contains("'--dangerously-skip-permissions'"),
            "{command}"
        );
        assert!(command.contains("'--effort' 'low'"), "{command}");
        assert!(command.contains("'--model' 'sonnet'"), "{command}");
    }

    #[test]
    fn splits_query_args_for_local_execution() {
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
    fn query_args_require_prompt_placeholder() {
        let query = QueryConfig {
            command: "custom-query".to_string(),
            args: "--mode local".to_string(),
        };

        let error = query_command_args(&query, "find context").unwrap_err();

        assert!(
            error.to_string().contains("must include {{prompt}}"),
            "{error}"
        );
    }

    #[test]
    fn query_args_can_place_prompt_with_template() {
        let query = QueryConfig {
            command: "pi".to_string(),
            args: "--thinking high -p {{prompt}}".to_string(),
        };

        assert_eq!(
            query_command_args(&query, "find context").unwrap(),
            vec!["--thinking", "high", "-p", "find context"]
        );
    }

    #[test]
    fn query_args_template_can_embed_prompt_in_arg() {
        let query = QueryConfig {
            command: "custom-query".to_string(),
            args: "--prompt={{prompt}}".to_string(),
        };

        assert_eq!(
            query_command_args(&query, "find context").unwrap(),
            vec!["--prompt=find context"]
        );
    }

    #[test]
    fn defaults_query_config_when_missing() {
        let raw = r#"
remote = "user@vps"
remote_root = "~/.ultracontext"
host_id = "work-laptop"
"#;

        let cfg = Config::from_toml(raw).unwrap();

        assert_eq!(cfg.query.command, "claude");
        assert_eq!(cfg.query.args, DEFAULT_QUERY_ARGS);
    }

    #[test]
    fn parses_query_section() {
        let raw = r#"
remote = "user@vps"
remote_root = "~/.ultracontext"
host_id = "work-laptop"

[query]
command = "custom-query"
args = "--fast"
"#;

        let cfg = Config::from_toml(raw).unwrap();

        assert_eq!(cfg.query.command, "custom-query");
        assert_eq!(cfg.query.args, "--fast");
        assert_eq!(
            cfg.to_toml(),
            "remote = \"user@vps\"\nremote_root = \"~/.ultracontext\"\nhost_id = \"work-laptop\"\n\n[query]\ncommand = \"custom-query\"\nargs = \"--fast\"\n\n"
        );
    }

    #[test]
    fn keeps_claude_path_fallback_for_default_query_command() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            query: QueryConfig {
                command: "claude".to_string(),
                args: DEFAULT_QUERY_ARGS.to_string(),
            },
            sources: vec![],
        };

        let command = query_remote_command(&cfg, "~/.ultracontext/workspace", "prompt").unwrap();

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
    fn query_command_does_not_read_stdin() {
        let cfg = Config {
            remote: "user@vps".to_string(),
            remote_root: "~/.ultracontext".to_string(),
            host_id: "work-laptop".to_string(),
            query: QueryConfig {
                command: "claude".to_string(),
                args: DEFAULT_QUERY_ARGS.to_string(),
            },
            sources: vec![],
        };

        let command = query_remote_command(&cfg, "~/.ultracontext/workspace", "prompt").unwrap();

        assert!(command.ends_with("< /dev/null"), "{command}");
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
