use serde_json::{Value, json};
use std::env;
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process;
use toml_edit::{Array, DocumentMut, value};
use ultracontext::{
    AppendInput, ContentStore, DeleteTarget, ErrorCode, FileWrite, ForkOptions, GetOptions,
    S3ContentStore, UcError, UltraContext, UltraContextOptions, UpdatePatch, UpdateTarget,
    artifact_data_json, artifact_meta_json, context_data_json, context_history_json,
    context_view_json, mutation_result_json, search_result_json,
};

mod mount_utils;
mod nfs_mount;
#[allow(
    dead_code,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_imports,
    unused_variables
)]
mod nfsserve;

use mount_utils::{MountScope, infer_kind, io_error};

const DEFAULT_INLINE_LIMIT: usize = 64 * 1024;
const PROJECT_CONFIG_FILE: &str = "ultracontext.json";

// Shared entry point for both binaries: parse argv, run, map errors to exit codes.
pub fn entry() {
    let color = io::stdout().is_terminal() && env::var_os("NO_COLOR").is_none();
    if let Err(error) = run(
        env::args().skip(1).collect(),
        &mut io::stdout(),
        &mut io::stderr(),
        color,
    ) {
        let _ = writeln!(io::stderr(), "{}: {}", error.code_str(), error.message);
        std::process::exit(exit_code(&error));
    }
}

fn run(
    args: Vec<String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
    color: bool,
) -> Result<(), UcError> {
    let invocation = Invocation::parse(args)?;
    let Invocation {
        db,
        content_dir,
        inline_limit,
        json,
        command,
    } = invocation;

    match command {
        Command::Help => {
            write_help(out, color)?;
            Ok(())
        }
        Command::InitHelp => {
            write_init_help(out)?;
            Ok(())
        }
        Command::MountHelp => {
            write_mount_help(out)?;
            Ok(())
        }
        Command::UnmountHelp => {
            write_unmount_help(out)?;
            Ok(())
        }
        Command::SessionHelp => {
            write_session_help(out)?;
            Ok(())
        }
        Command::ContextHelp => {
            write_context_help(out)?;
            Ok(())
        }
        Command::FsHelp => {
            write_fs_help(out)?;
            Ok(())
        }
        Command::SearchHelp => {
            write_search_help(out)?;
            Ok(())
        }
        Command::ConfigHelp => {
            write_config_help(out)?;
            Ok(())
        }
        Command::ConfigList => {
            let config = read_active_config()?;
            print_json(out, config.value)
        }
        Command::ConfigPath => {
            let config = read_active_config()?;
            print_json(out, json!({ "path": db_path_string(&config.path)? }))
        }
        Command::ConfigGet { key } => {
            let config = read_active_config()?;
            print_json(out, get_config_value(&config.value, &key)?)
        }
        Command::ConfigSet { key, value } => {
            let mut config = read_active_config()?;
            let normalized = set_config_value(&mut config.value, &key, &value)?;
            write_config_value(&config.path, &config.value)?;
            print_json(
                out,
                json!({
                    "updated": true,
                    "key": normalized,
                    "config": db_path_string(&config.path)?
                }),
            )
        }
        Command::Init {
            local,
            force,
            install_sdk,
        } => {
            let result = init_store(
                db.as_deref(),
                content_dir.as_ref(),
                inline_limit,
                local,
                force,
                install_sdk,
            )?;
            print_json(out, result)
        }
        Command::SessionCreate { metadata } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, false)?;
            let session = uc.create(metadata)?;
            print_json(out, context_view_json(&session))
        }
        Command::SessionList => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let data = uc
                .list_contexts()?
                .iter()
                .map(context_view_json)
                .collect::<Vec<_>>();
            print_json(out, json!({ "data": data }))
        }
        Command::SessionFork {
            session_id,
            version,
        } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let forked = uc.fork(
                &session_id,
                ForkOptions {
                    version,
                    metadata: json!({}),
                },
            )?;
            print_json(out, context_view_json(&forked))
        }
        Command::SessionDelete { session_id } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            uc.delete_context_permanently(&session_id)?;
            print_json(out, json!({ "deleted": true, "id": session_id }))
        }
        Command::ContextGet {
            session_id,
            version,
        } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let context = uc.get(&session_id, GetOptions { version })?;
            print_json(out, context_data_json(&context))
        }
        Command::ContextHistory { session_id } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let history = uc.context_history(&session_id)?;
            print_json(out, context_history_json(&history))
        }
        Command::ContextAppend {
            session_id,
            content,
        } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let result = uc.append(&session_id, vec![AppendInput::new(content)])?;
            print_json(out, mutation_result_json(&result))
        }
        Command::ContextUpdate {
            session_id,
            target,
            content,
        } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let result =
                uc.update_message(&session_id, UpdatePatch { target, content }, json!({}))?;
            print_json(out, mutation_result_json(&result))
        }
        Command::ContextDelete {
            session_id,
            targets,
        } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let result = uc.delete_messages(&session_id, targets, json!({}))?;
            print_json(out, mutation_result_json(&result))
        }
        Command::ContextClear { session_id } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let result = uc.clear_context(&session_id, json!({}))?;
            print_json(out, mutation_result_json(&result))
        }
        Command::ContextRestore {
            session_id,
            context_id,
        } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let result = uc.restore_context(&session_id, &context_id, json!({}))?;
            print_json(out, mutation_result_json(&result))
        }
        Command::Search { query } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let result = uc.search(&query)?;
            print_json(out, search_result_json(&result))
        }
        Command::FileList { ctx_id, prefix } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let data = uc
                .file_list(&ctx_id, prefix.as_deref())?
                .iter()
                .map(artifact_meta_json)
                .collect::<Vec<_>>();
            print_json(out, json!({ "data": data }))
        }
        Command::FileRead { ctx_id, path } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            if json {
                let artifact = uc.file_read(&ctx_id, &path)?;
                print_json(out, artifact_data_json(&artifact))
            } else {
                let artifact = uc.load_artifact_bytes(&ctx_id, &path, None)?;
                out.write_all(&artifact.data).map_err(io_error)?;
                Ok(())
            }
        }
        Command::FileWrite {
            ctx_id,
            path,
            source,
            kind,
        } => {
            let data = read_input(source.as_deref())?;
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let saved = uc.file_write(
                &ctx_id,
                FileWrite::new(path, data)
                    .with_kind(kind)
                    .with_metadata(json!({"source": "uc-cli"})),
            )?;
            print_json(out, artifact_meta_json(&saved))
        }
        Command::FileMove { ctx_id, from, to } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let moved = uc.file_move(&ctx_id, &from, &to, None)?;
            print_json(out, artifact_meta_json(&moved))
        }
        Command::FileRemove { ctx_id, path } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            uc.file_remove(&ctx_id, &path, None)?;
            print_json(out, json!({ "deleted": true, "path": path }))
        }
        Command::FileGlob { ctx_id, pattern } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let data = uc
                .file_glob(&ctx_id, &pattern)?
                .iter()
                .map(artifact_meta_json)
                .collect::<Vec<_>>();
            print_json(out, json!({ "data": data }))
        }
        Command::FileGrep {
            ctx_id,
            query,
            prefix,
        } => {
            let uc = open_store(db.as_deref(), content_dir.as_ref(), inline_limit, true)?;
            let result = uc.file_grep(&ctx_id, &query, prefix.as_deref())?;
            print_json(out, search_result_json(&result))
        }
        Command::Mount {
            scope,
            mountpoint,
            mode,
            state_file,
        } => {
            let resolved =
                resolve_store_config(db.as_deref(), content_dir.as_ref(), inline_limit, false)?;
            // No scope flag: honor mount.defaultScope / mount.defaultWorkspace from config.
            let scope = resolve_default_mount_scope(scope)?;
            mount_context(
                StoreConfig {
                    db: db_path_string(&resolved.db)?,
                    content_dir: resolved.content_dir,
                    inline_limit: resolved.inline_limit,
                    s3: resolved.s3,
                },
                scope,
                mountpoint,
                mode,
                state_file,
                err,
            )
        }
        Command::Unmount { mountpoint } => {
            nfs_mount::unmount(PathBuf::from(&mountpoint))?;
            print_json(out, json!({ "unmounted": true, "mountpoint": mountpoint }))
        }
    }
}

#[derive(Debug)]
struct Invocation {
    db: Option<String>,
    content_dir: Option<PathBuf>,
    inline_limit: Option<usize>,
    json: bool,
    command: Command,
}

#[derive(Debug, PartialEq)]
enum Command {
    Help,
    InitHelp,
    MountHelp,
    UnmountHelp,
    SessionHelp,
    ContextHelp,
    FsHelp,
    SearchHelp,
    ConfigHelp,
    ConfigList,
    ConfigPath,
    ConfigGet {
        key: String,
    },
    ConfigSet {
        key: String,
        value: String,
    },
    Init {
        local: bool,
        force: bool,
        install_sdk: bool,
    },
    SessionCreate {
        metadata: Value,
    },
    SessionList,
    SessionFork {
        session_id: String,
        version: Option<usize>,
    },
    SessionDelete {
        session_id: String,
    },
    ContextGet {
        session_id: String,
        version: Option<usize>,
    },
    ContextHistory {
        session_id: String,
    },
    ContextAppend {
        session_id: String,
        content: Value,
    },
    ContextUpdate {
        session_id: String,
        target: UpdateTarget,
        content: Value,
    },
    ContextDelete {
        session_id: String,
        targets: Vec<DeleteTarget>,
    },
    ContextClear {
        session_id: String,
    },
    ContextRestore {
        session_id: String,
        context_id: String,
    },
    Search {
        query: String,
    },
    FileList {
        ctx_id: String,
        prefix: Option<String>,
    },
    FileRead {
        ctx_id: String,
        path: String,
    },
    FileWrite {
        ctx_id: String,
        path: String,
        source: Option<String>,
        kind: String,
    },
    FileMove {
        ctx_id: String,
        from: String,
        to: String,
    },
    FileRemove {
        ctx_id: String,
        path: String,
    },
    FileGlob {
        ctx_id: String,
        pattern: String,
    },
    FileGrep {
        ctx_id: String,
        query: String,
        prefix: Option<String>,
    },
    Mount {
        scope: MountScope,
        mountpoint: String,
        mode: MountMode,
        state_file: Option<PathBuf>,
    },
    Unmount {
        mountpoint: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MountMode {
    Default,
    Foreground,
    Background,
}

impl Invocation {
    fn parse(args: Vec<String>) -> Result<Self, UcError> {
        let mut parser = Args::new(args);
        let mut db = env::var("UC_DB").ok();
        let mut content_dir = env::var_os("UC_CONTENT_DIR").map(PathBuf::from);
        let mut inline_limit = env::var("UC_INLINE_LIMIT")
            .ok()
            .and_then(|value| value.parse().ok());
        let mut json_output = false;

        while let Some(flag) = parser.peek() {
            match flag {
                "--help" | "-h" => {
                    parser.next();
                    return Ok(Self {
                        db,
                        content_dir,
                        inline_limit,
                        json: json_output,
                        command: Command::Help,
                    });
                }
                "--db" => {
                    parser.next();
                    db = Some(parser.required("--db value")?);
                }
                "--content-dir" => {
                    parser.next();
                    content_dir = Some(PathBuf::from(parser.required("--content-dir value")?));
                }
                "--inline-limit" => {
                    parser.next();
                    inline_limit = Some(parser.required("--inline-limit value")?.parse().map_err(
                        |_| {
                            UcError::new(ErrorCode::InvalidInput, "--inline-limit must be a number")
                        },
                    )?);
                }
                "--json" => {
                    parser.next();
                    json_output = true;
                }
                _ => break,
            }
        }

        let command = parse_command(&mut parser)?;
        Ok(Self {
            db,
            content_dir,
            inline_limit,
            json: json_output,
            command,
        })
    }
}

// S3 is carried as its merged settings JSON; the engine's `from_json` is the one decoder,
// with `inline_limit` threaded in at the point of use.
struct StoreConfig {
    db: String,
    content_dir: Option<PathBuf>,
    inline_limit: usize,
    s3: Option<Value>,
}

#[derive(Debug)]
struct ResolvedStoreConfig {
    db: PathBuf,
    content_dir: Option<PathBuf>,
    inline_limit: usize,
    s3: Option<Value>,
}

#[derive(Debug)]
struct ConfigFile {
    path: PathBuf,
    value: Value,
    db: PathBuf,
    content_dir: Option<PathBuf>,
    inline_limit: Option<usize>,
    s3: Option<Value>,
}

fn open_store(
    db: Option<&str>,
    content_dir: Option<&PathBuf>,
    inline_limit: Option<usize>,
    require_existing: bool,
) -> Result<UltraContext, UcError> {
    let resolved = resolve_store_config(db, content_dir, inline_limit, require_existing)?;
    if require_existing && !resolved.db.exists() {
        return Err(UcError::new(
            ErrorCode::NotFound,
            format!("Database not found: {}", resolved.db.display()),
        ));
    }
    if !require_existing && let Some(parent) = resolved.db.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    if resolved.s3.is_none()
        && let Some(content_dir) = &resolved.content_dir
    {
        fs::create_dir_all(content_dir).map_err(io_error)?;
    }
    open_store_at(
        &resolved.db,
        resolved.content_dir.as_ref(),
        resolved.inline_limit,
        resolved.s3.as_ref(),
    )
}

fn open_store_at(
    db: &Path,
    content_dir: Option<&PathBuf>,
    inline_limit: usize,
    s3: Option<&Value>,
) -> Result<UltraContext, UcError> {
    let content_store = match s3 {
        Some(settings) => ContentStore::s3(build_s3_store(settings, inline_limit)?),
        None => content_dir
            .map(|root| ContentStore::local_dir(root, inline_limit))
            .unwrap_or_else(|| ContentStore::inline_with_limit(inline_limit)),
    };
    let db = db_path_string(db)?;
    UltraContext::open_with_options(&db, UltraContextOptions { content_store })
}

fn init_store(
    db: Option<&str>,
    content_dir: Option<&PathBuf>,
    inline_limit: Option<usize>,
    local: bool,
    force: bool,
    install_sdk: bool,
) -> Result<Value, UcError> {
    let cwd = env::current_dir().map_err(io_error)?;
    let config_path = if local {
        cwd.join(PROJECT_CONFIG_FILE)
    } else {
        global_config_path()?
    };
    let base_dir = config_path.parent().unwrap_or_else(|| Path::new("."));
    let db_config_value = db
        .map(str::to_string)
        .unwrap_or_else(|| default_db_config_value(local));
    let content_dir_config_value = content_dir
        .map(|path| path_to_config_string(path))
        .unwrap_or_else(|| default_content_dir_config_value(local));
    let inline_limit = inline_limit.unwrap_or(DEFAULT_INLINE_LIMIT);
    let db_path = resolve_config_relative_path(base_dir, &db_config_value);
    let content_dir_path = resolve_config_relative_path(base_dir, &content_dir_config_value);

    if config_path.exists() && !force {
        let existing = read_config(&config_path)?;
        if existing != db_path {
            return Err(UcError::new(
                ErrorCode::Conflict,
                format!(
                    "ultracontext is already initialized at {}. Pass --force to replace it.",
                    existing.display()
                ),
            ));
        }
    }

    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    fs::create_dir_all(&content_dir_path).map_err(io_error)?;
    if local {
        ensure_local_state_gitignore(&cwd)?;
    }

    let db_existed = db_path.exists();
    let config_existed = config_path.exists();
    let uc = open_store_at(&db_path, Some(&content_dir_path), inline_limit, None)?;
    let workspace = uc.ensure_default_workspace()?;
    let config = json!({
        "version": 1,
        "db": db_config_value,
        "storage": {
            "contentDir": content_dir_config_value,
            "inlineLimit": inline_limit
        },
        "mount": {
            "defaultScope": "auto"
        }
    });
    write_config_value(&config_path, &config)?;
    let sdk = maybe_install_project_sdks(&cwd, local && install_sdk)?;

    Ok(json!({
        "initialized": true,
        "created": !db_existed || !config_existed,
        "scope": if local { "local" } else { "global" },
        "config": db_path_string(&config_path)?,
        "db": db_path_string(&db_path)?,
        "content_dir": db_path_string(&content_dir_path)?,
        "sdk": sdk,
        "workspace_id": workspace.id
    }))
}

fn resolve_store_config(
    db: Option<&str>,
    content_dir: Option<&PathBuf>,
    inline_limit: Option<usize>,
    require_existing: bool,
) -> Result<ResolvedStoreConfig, UcError> {
    if let Some(db) = db {
        let s3 = s3_settings_from_env();
        return Ok(ResolvedStoreConfig {
            db: absolute_path(db)?,
            content_dir: if s3.is_some() {
                None
            } else {
                content_dir.cloned()
            },
            inline_limit: inline_limit.unwrap_or(DEFAULT_INLINE_LIMIT),
            s3,
        });
    }
    if let Some(config) = find_local_config() {
        return apply_config_overrides(read_config_file(&config)?, content_dir, inline_limit);
    }
    if require_existing && let Some(db) = find_current_dir_db() {
        let s3 = s3_settings_from_env();
        return Ok(ResolvedStoreConfig {
            db,
            content_dir: if s3.is_some() {
                None
            } else {
                content_dir.cloned()
            },
            inline_limit: inline_limit.unwrap_or(DEFAULT_INLINE_LIMIT),
            s3,
        });
    }
    let global = global_config_path()?;
    if global.exists() {
        return apply_config_overrides(read_config_file(&global)?, content_dir, inline_limit);
    }

    let message = if require_existing {
        "ultracontext is not initialized. Run `uc init`, set UC_DB, or pass --db <path>."
    } else {
        "ultracontext is not initialized. Run `uc init` first, or pass --db <path>."
    };
    Err(UcError::new(ErrorCode::InvalidInput, message))
}

fn find_current_dir_db() -> Option<PathBuf> {
    let candidate = env::current_dir().ok()?.join("ultracontext.db");
    candidate.exists().then_some(candidate)
}

fn apply_config_overrides(
    config: ConfigFile,
    content_dir: Option<&PathBuf>,
    inline_limit: Option<usize>,
) -> Result<ResolvedStoreConfig, UcError> {
    Ok(ResolvedStoreConfig {
        db: config.db,
        content_dir: if config.s3.is_some() && content_dir.is_none() {
            None
        } else {
            content_dir.cloned().or(config.content_dir)
        },
        inline_limit: inline_limit
            .or(config.inline_limit)
            .unwrap_or(DEFAULT_INLINE_LIMIT),
        s3: if content_dir.is_some() {
            None
        } else {
            config.s3
        },
    })
}

fn find_local_config() -> Option<PathBuf> {
    let mut dir = env::current_dir().ok()?;
    let home = env::var_os("HOME").map(PathBuf::from);
    loop {
        let candidate = dir.join(PROJECT_CONFIG_FILE);
        if candidate.exists() {
            return Some(candidate);
        }
        if home.as_ref() != Some(&dir) {
            let legacy = dir.join(".ultracontext").join("config.json");
            if legacy.exists() {
                return Some(legacy);
            }
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn read_config(config_path: &Path) -> Result<PathBuf, UcError> {
    Ok(read_config_file(config_path)?.db)
}

fn read_active_config() -> Result<ConfigFile, UcError> {
    let path = active_config_path()?;
    read_config_file(&path)
}

fn active_config_path() -> Result<PathBuf, UcError> {
    if let Some(config) = find_local_config() {
        return Ok(config);
    }
    let global = global_config_path()?;
    if global.exists() {
        return Ok(global);
    }
    Err(UcError::new(
        ErrorCode::InvalidInput,
        "ultracontext is not initialized. Run `uc init` first.",
    ))
}

fn read_config_file(config_path: &Path) -> Result<ConfigFile, UcError> {
    let data = fs::read_to_string(config_path).map_err(io_error)?;
    let value: Value = serde_json::from_str(&data)
        .map_err(|_| UcError::new(ErrorCode::InvalidInput, "Invalid ultracontext config JSON"))?;
    let db = config_string(&value, "db")
        .ok_or_else(|| {
            UcError::new(
                ErrorCode::InvalidInput,
                format!("ultracontext config missing db: {}", config_path.display()),
            )
        })?
        .to_string();
    let base_dir = config_path.parent().unwrap_or_else(|| Path::new("."));
    let storage_driver = env::var("UC_STORAGE_DRIVER")
        .ok()
        .or_else(|| config_string(&value, "storage.driver").map(ToOwned::to_owned));
    let content_dir = config_string(&value, "storage.contentDir")
        .or_else(|| config_string(&value, "storage.content_dir"))
        .map(|path| resolve_config_relative_path(base_dir, path));
    let inline_limit = config_usize(&value, "storage.inlineLimit")
        .or_else(|| config_usize(&value, "storage.inline_limit"));
    let s3 = s3_settings_from_value(&value);
    Ok(ConfigFile {
        path: config_path.to_path_buf(),
        value,
        db: resolve_config_relative_path(base_dir, &db),
        content_dir: if matches!(storage_driver.as_deref(), Some("inline") | Some("s3")) {
            None
        } else {
            content_dir
        },
        inline_limit,
        s3,
    })
}

// Each S3 setting: canonical JSON key + its env override. One list feeds the env overlay.
const S3_SETTINGS: &[(&str, &str)] = &[
    ("endpoint", "UC_S3_ENDPOINT"),
    ("bucket", "UC_S3_BUCKET"),
    ("region", "UC_S3_REGION"),
    ("accessKeyId", "UC_S3_ACCESS_KEY_ID"),
    ("secretAccessKey", "UC_S3_SECRET_ACCESS_KEY"),
    ("sessionToken", "UC_S3_SESSION_TOKEN"),
    ("prefix", "UC_S3_PREFIX"),
];

// Merge env overrides onto the config's `storage.s3` object; None when S3 is not selected.
fn s3_settings_from_value(value: &Value) -> Option<Value> {
    let storage = value.get("storage").and_then(Value::as_object);
    let driver = env::var("UC_STORAGE_DRIVER")
        .ok()
        .or_else(|| {
            storage?
                .get("driver")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let s3_value = storage.and_then(|storage| storage.get("s3"));
    if driver != "s3" && s3_value.is_none() && env::var_os("UC_S3_BUCKET").is_none() {
        return None;
    }
    Some(overlay_s3_env(s3_value))
}

// Env-only S3 settings, used when there is no config file (--db / current-dir db).
fn s3_settings_from_env() -> Option<Value> {
    if env::var("UC_STORAGE_DRIVER").ok().as_deref() != Some("s3")
        && env::var_os("UC_S3_BUCKET").is_none()
    {
        return None;
    }
    Some(overlay_s3_env(None))
}

// Start from the config object (camelCase keys preferred), then let env vars win.
fn overlay_s3_env(base: Option<&Value>) -> Value {
    let mut settings = base
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for &(key, env_var) in S3_SETTINGS {
        if let Some(value) = config_str_env(env_var) {
            settings.insert(key.to_string(), Value::String(value));
        }
    }
    Value::Object(settings)
}

// Decode via the engine (single source of truth), then reject blank required fields.
fn build_s3_store(settings: &Value, inline_limit: usize) -> Result<S3ContentStore, UcError> {
    let store = S3ContentStore::from_json(settings, inline_limit);
    require_s3_field(&store.endpoint, "storage.s3.endpoint")?;
    require_s3_field(&store.bucket, "storage.s3.bucket")?;
    require_s3_field(&store.access_key_id, "storage.s3.accessKeyId")?;
    require_s3_field(&store.secret_access_key, "storage.s3.secretAccessKey")?;
    Ok(store)
}

fn require_s3_field(value: &str, name: &str) -> Result<(), UcError> {
    if value.trim().is_empty() {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Missing config: {name}"),
        ));
    }
    Ok(())
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn config_str_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .and_then(|value| empty_to_none(Some(value)))
}

fn write_config_value(config_path: &Path, value: &Value) -> Result<(), UcError> {
    let config_text = serde_json::to_string_pretty(value)
        .map_err(|error| UcError::new(ErrorCode::Internal, error.to_string()))?;
    fs::write(config_path, format!("{config_text}\n")).map_err(io_error)
}

fn default_db_config_value(local: bool) -> String {
    if local {
        ".ultracontext/ultracontext.db".to_string()
    } else {
        "ultracontext.db".to_string()
    }
}

fn default_content_dir_config_value(local: bool) -> String {
    if local {
        ".ultracontext/blobs".to_string()
    } else {
        "blobs".to_string()
    }
}

fn path_to_config_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn resolve_config_relative_path(base_dir: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    }
}

fn ensure_local_state_gitignore(project_root: &Path) -> Result<(), UcError> {
    let state_dir = project_root.join(".ultracontext");
    fs::create_dir_all(&state_dir).map_err(io_error)?;
    let gitignore = state_dir.join(".gitignore");
    if !gitignore.exists() {
        fs::write(gitignore, "*\n!.gitignore\n").map_err(io_error)?;
    }
    Ok(())
}

fn maybe_install_project_sdks(project_root: &Path, enabled: bool) -> Result<Value, UcError> {
    Ok(json!({
        "javascript": maybe_install_js_sdk(project_root, enabled)?,
        "python": maybe_install_python_sdk(project_root, enabled)?,
    }))
}

fn maybe_install_js_sdk(project_root: &Path, enabled: bool) -> Result<Value, UcError> {
    if !enabled {
        return Ok(json!({ "installed": false, "reason": "disabled" }));
    }

    let package_json = project_root.join("package.json");
    if !package_json.exists() {
        return Ok(json!({ "installed": false, "reason": "no_package_json" }));
    }

    let package_name =
        env::var("UC_NPM_PACKAGE_NAME").unwrap_or_else(|_| "ultracontext".to_string());
    let package_spec = env::var("UC_NPM_SPEC").unwrap_or_else(|_| package_name.clone());

    if package_json_has_dependency(&package_json, &package_name)? {
        return Ok(json!({
            "installed": false,
            "reason": "already_present",
            "package": package_name
        }));
    }

    let package_manager = detect_package_manager(project_root);
    let status = package_manager
        .install_command(&package_spec)
        .current_dir(project_root)
        .status()
        .map_err(|error| {
            UcError::new(
                ErrorCode::InvalidInput,
                format!(
                    "Failed to run {} while installing {package_spec}: {error}",
                    package_manager.bin
                ),
            )
        })?;

    if !status.success() {
        return Err(UcError::new(
            ErrorCode::Internal,
            format!(
                "{} failed while installing {package_spec}. Install the SDK dependency manually and rerun `uc init`.",
                package_manager.bin
            ),
        ));
    }

    Ok(json!({
        "installed": true,
        "package": package_spec,
        "package_manager": package_manager.name
    }))
}

struct PackageManager {
    name: &'static str,
    bin: &'static str,
    command: &'static [&'static str],
}

impl PackageManager {
    fn install_command(&self, package: &str) -> process::Command {
        let mut command = process::Command::new(self.bin);
        command.args(self.command).arg(package);
        command
    }
}

fn detect_package_manager(project_root: &Path) -> PackageManager {
    if project_root.join("pnpm-lock.yaml").exists() {
        return PackageManager {
            name: "pnpm",
            bin: "pnpm",
            command: &["add"],
        };
    }
    if project_root.join("bun.lock").exists() || project_root.join("bun.lockb").exists() {
        return PackageManager {
            name: "bun",
            bin: "bun",
            command: &["add"],
        };
    }
    if project_root.join("yarn.lock").exists() {
        return PackageManager {
            name: "yarn",
            bin: "yarn",
            command: &["add"],
        };
    }
    PackageManager {
        name: "npm",
        bin: "npm",
        command: &["install"],
    }
}

fn package_json_has_dependency(path: &Path, package_name: &str) -> Result<bool, UcError> {
    let data = fs::read_to_string(path).map_err(io_error)?;
    let value: Value = serde_json::from_str(&data).map_err(|_| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Invalid package.json: {}", path.display()),
        )
    })?;
    let sections = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ];
    Ok(sections.iter().any(|section| {
        value
            .get(section)
            .and_then(Value::as_object)
            .is_some_and(|deps| deps.contains_key(package_name))
    }))
}

fn maybe_install_python_sdk(project_root: &Path, enabled: bool) -> Result<Value, UcError> {
    if !enabled {
        return Ok(json!({ "installed": false, "reason": "disabled" }));
    }

    let package_name =
        env::var("UC_PYTHON_PACKAGE_NAME").unwrap_or_else(|_| "ultracontext".to_string());
    let package_spec = env::var("UC_PYTHON_SPEC").unwrap_or_else(|_| package_name.clone());
    let pyproject = project_root.join("pyproject.toml");
    let requirements = project_root.join("requirements.txt");

    if pyproject.exists() {
        return add_pyproject_dependency(&pyproject, &package_name, &package_spec);
    }
    if requirements.exists() {
        return add_requirements_dependency(&requirements, &package_name, &package_spec);
    }

    Ok(json!({ "installed": false, "reason": "no_python_project" }))
}

fn add_pyproject_dependency(
    path: &Path,
    package_name: &str,
    package_spec: &str,
) -> Result<Value, UcError> {
    let data = fs::read_to_string(path).map_err(io_error)?;
    let mut document = data.parse::<DocumentMut>().map_err(|error| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Invalid pyproject.toml: {}: {error}", path.display()),
        )
    })?;

    if !document["project"].is_table() {
        document["project"] = toml_edit::table();
    }
    if document["project"]["dependencies"].is_none() {
        document["project"]["dependencies"] = value(Array::new());
    }

    let dependencies = document["project"]["dependencies"]
        .as_array_mut()
        .ok_or_else(|| {
            UcError::new(
                ErrorCode::InvalidInput,
                format!(
                    "pyproject.toml dependencies must be an array: {}",
                    path.display()
                ),
            )
        })?;

    if dependencies
        .iter()
        .filter_map(|dependency| dependency.as_str())
        .any(|dependency| python_requirement_matches(dependency, package_name))
    {
        return Ok(json!({
            "installed": false,
            "reason": "already_present",
            "package": package_name,
            "file": db_path_string(path)?
        }));
    }

    dependencies.push(package_spec);
    fs::write(path, document.to_string()).map_err(io_error)?;
    Ok(json!({
        "installed": false,
        "dependency_added": true,
        "package": package_spec,
        "file": db_path_string(path)?
    }))
}

fn add_requirements_dependency(
    path: &Path,
    package_name: &str,
    package_spec: &str,
) -> Result<Value, UcError> {
    let data = fs::read_to_string(path).map_err(io_error)?;
    if data
        .lines()
        .any(|line| python_requirement_matches(line, package_name))
    {
        return Ok(json!({
            "installed": false,
            "reason": "already_present",
            "package": package_name,
            "file": db_path_string(path)?
        }));
    }

    let mut next = data;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(package_spec);
    next.push('\n');
    fs::write(path, next).map_err(io_error)?;
    Ok(json!({
        "installed": false,
        "dependency_added": true,
        "package": package_spec,
        "file": db_path_string(path)?
    }))
}

fn python_requirement_matches(requirement: &str, package_name: &str) -> bool {
    let candidate = requirement
        .split('#')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    if candidate.is_empty() || candidate.starts_with('-') {
        return false;
    }
    let name_end = candidate
        .find(|ch: char| {
            ch.is_whitespace() || matches!(ch, '[' | '<' | '>' | '=' | '!' | '~' | ';' | '@')
        })
        .unwrap_or(candidate.len());
    normalize_python_package_name(&candidate[..name_end])
        == normalize_python_package_name(package_name)
}

fn normalize_python_package_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if matches!(ch, '_' | '.' | '-') {
                '-'
            } else {
                ch.to_ascii_lowercase()
            }
        })
        .collect()
}

// The one config-key schema: canonical key -> {aliases, JSON path, read fallbacks, type}.
// Everything (read/write/normalize/help) is driven off this single table.
enum ConfigType {
    String,
    Usize,
}

struct ConfigKey {
    canonical: &'static str,
    aliases: &'static [&'static str],
    path: &'static [&'static str],
    read_aliases: &'static [&'static [&'static str]],
    ty: ConfigType,
}

const CONFIG_KEYS: &[ConfigKey] = &[
    ConfigKey {
        canonical: "db",
        aliases: &["db", "db.path"],
        path: &["db"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.contentDir",
        aliases: &["storage.contentDir", "storage.content_dir"],
        path: &["storage", "contentDir"],
        read_aliases: &[&["storage", "content_dir"]],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.inlineLimit",
        aliases: &["storage.inlineLimit", "storage.inline_limit"],
        path: &["storage", "inlineLimit"],
        read_aliases: &[&["storage", "inline_limit"]],
        ty: ConfigType::Usize,
    },
    ConfigKey {
        canonical: "storage.driver",
        aliases: &["storage.driver"],
        path: &["storage", "driver"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.s3.endpoint",
        aliases: &["storage.s3.endpoint"],
        path: &["storage", "s3", "endpoint"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.s3.bucket",
        aliases: &["storage.s3.bucket"],
        path: &["storage", "s3", "bucket"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.s3.region",
        aliases: &["storage.s3.region"],
        path: &["storage", "s3", "region"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.s3.accessKeyId",
        aliases: &["storage.s3.accessKeyId", "storage.s3.access_key_id"],
        path: &["storage", "s3", "accessKeyId"],
        read_aliases: &[&["storage", "s3", "access_key_id"]],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.s3.secretAccessKey",
        aliases: &["storage.s3.secretAccessKey", "storage.s3.secret_access_key"],
        path: &["storage", "s3", "secretAccessKey"],
        read_aliases: &[&["storage", "s3", "secret_access_key"]],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.s3.sessionToken",
        aliases: &["storage.s3.sessionToken", "storage.s3.session_token"],
        path: &["storage", "s3", "sessionToken"],
        read_aliases: &[&["storage", "s3", "session_token"]],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "storage.s3.prefix",
        aliases: &["storage.s3.prefix"],
        path: &["storage", "s3", "prefix"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "mount.defaultScope",
        aliases: &["mount.defaultScope", "mount.default_scope"],
        path: &["mount", "defaultScope"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
    ConfigKey {
        canonical: "mount.defaultWorkspace",
        aliases: &["mount.defaultWorkspace", "mount.default_workspace"],
        path: &["mount", "defaultWorkspace"],
        read_aliases: &[],
        ty: ConfigType::String,
    },
];

// Resolve an input key (canonical or alias) to its schema entry.
fn lookup_config_key(key: &str) -> Option<&'static ConfigKey> {
    CONFIG_KEYS
        .iter()
        .find(|entry| entry.aliases.contains(&key))
}

// Walk the canonical path, then any read-fallback paths, returning the first hit.
fn read_config_node<'a>(value: &'a Value, entry: &ConfigKey) -> Option<&'a Value> {
    std::iter::once(entry.path)
        .chain(entry.read_aliases.iter().copied())
        .find_map(|path| nested_config_node(value, path))
}

fn config_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    read_config_node(value, lookup_config_key(key)?)?.as_str()
}

fn config_usize(value: &Value, key: &str) -> Option<usize> {
    let entry = lookup_config_key(key)?;
    read_config_node(value, entry)?
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
}

fn get_config_value(value: &Value, key: &str) -> Result<Value, UcError> {
    let entry = lookup_config_key(key).ok_or_else(|| unknown_config_key(key))?;
    read_config_node(value, entry).cloned().ok_or_else(|| {
        UcError::new(
            ErrorCode::NotFound,
            format!("Config key not found: {}", entry.canonical),
        )
    })
}

fn set_config_value(config: &mut Value, key: &str, raw: &str) -> Result<&'static str, UcError> {
    let entry = lookup_config_key(key).ok_or_else(|| unknown_config_key(key))?;
    let value = match entry.ty {
        ConfigType::String => Value::String(raw.to_string()),
        ConfigType::Usize => {
            let parsed = raw.parse::<usize>().map_err(|_| {
                UcError::new(
                    ErrorCode::InvalidInput,
                    format!("{} must be a number", entry.canonical),
                )
            })?;
            json!(parsed)
        }
    };
    let root = config.as_object_mut().ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            "ultracontext config must be a JSON object",
        )
    })?;
    set_nested_config_value(root, entry.path, value)?;
    Ok(entry.canonical)
}

fn ensure_config_section<'a>(
    root: &'a mut serde_json::Map<String, Value>,
    name: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, UcError> {
    let section = root.entry(name.to_string()).or_insert_with(|| json!({}));
    section.as_object_mut().ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("ultracontext config section must be an object: {name}"),
        )
    })
}

fn set_nested_config_value(
    root: &mut serde_json::Map<String, Value>,
    path: &[&str],
    value: Value,
) -> Result<(), UcError> {
    let mut cursor = root;
    for section in &path[..path.len() - 1] {
        cursor = ensure_config_section(cursor, section)?;
    }
    cursor.insert(path[path.len() - 1].to_string(), value);
    Ok(())
}

fn nested_config_node<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cursor = value;
    for part in path {
        cursor = cursor.get(*part)?;
    }
    Some(cursor)
}

fn unknown_config_key(key: &str) -> UcError {
    UcError::new(
        ErrorCode::InvalidInput,
        format!("Unknown config key: {key}"),
    )
}

fn global_config_path() -> Result<PathBuf, UcError> {
    Ok(home_dir()?.join(".ultracontext").join("config.json"))
}

fn home_dir() -> Result<PathBuf, UcError> {
    env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            "Cannot resolve home directory; pass --db <path>",
        )
    })
}

fn absolute_path(path: &str) -> Result<PathBuf, UcError> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir().map_err(io_error)?.join(path))
    }
}

fn db_path_string(path: &Path) -> Result<String, UcError> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| UcError::new(ErrorCode::InvalidInput, "Path must be valid UTF-8"))
}

struct Args {
    args: Vec<String>,
    index: usize,
}

impl Args {
    fn new(args: Vec<String>) -> Self {
        Self { args, index: 0 }
    }

    fn next(&mut self) -> Option<String> {
        let value = self.args.get(self.index).cloned();
        if value.is_some() {
            self.index += 1;
        }
        value
    }

    fn peek(&self) -> Option<&str> {
        self.args.get(self.index).map(String::as_str)
    }

    fn required(&mut self, name: &str) -> Result<String, UcError> {
        self.next()
            .ok_or_else(|| UcError::new(ErrorCode::InvalidInput, format!("Missing {name}")))
    }

    // Like `required`, but a leading-`--` token means the positional was omitted (a flag came first).
    fn required_value(&mut self, name: &str) -> Result<String, UcError> {
        match self.peek() {
            Some(value) if !value.starts_with("--") => Ok(self.next().unwrap()),
            _ => Err(UcError::new(
                ErrorCode::InvalidInput,
                format!("Missing {name}"),
            )),
        }
    }

    fn optional(&mut self) -> Option<String> {
        self.next()
    }

    fn rest(&mut self) -> Vec<String> {
        let rest = self.args[self.index..].to_vec();
        self.index = self.args.len();
        rest
    }

    fn finish(&self) -> Result<(), UcError> {
        if self.index == self.args.len() {
            Ok(())
        } else {
            Err(UcError::new(
                ErrorCode::InvalidInput,
                format!("Unexpected argument: {}", self.args[self.index]),
            ))
        }
    }
}

fn parse_command(args: &mut Args) -> Result<Command, UcError> {
    let command = args.optional().unwrap_or_else(|| "help".to_string());
    match command.as_str() {
        "help" => Ok(Command::Help),
        "init" => {
            let mut local = true;
            let mut force = false;
            let mut install_sdk = true;
            while let Some(arg) = args.optional() {
                match arg.as_str() {
                    "--help" | "-h" | "help" => return Ok(Command::InitHelp),
                    "--local" => local = true,
                    "--global" => local = false,
                    "--force" => force = true,
                    "--no-install" => install_sdk = false,
                    _ => {
                        return Err(UcError::new(
                            ErrorCode::InvalidInput,
                            format!("Unexpected argument: {arg}"),
                        ));
                    }
                }
            }
            Ok(Command::Init {
                local,
                force,
                install_sdk,
            })
        }
        "session" | "ses" => parse_session_command(args),
        "context" | "ctx" => parse_context_command(args),
        "config" => parse_config_command(args),
        "search" => {
            if matches!(args.peek(), None | Some("--help" | "-h" | "help")) {
                if args.peek().is_some() {
                    args.next();
                    args.finish()?;
                }
                return Ok(Command::SearchHelp);
            }
            let query = args.rest().join(" ");
            Ok(Command::Search { query })
        }
        "fs" => parse_fs_command(args),
        "unmount" | "umount" => {
            if matches!(args.peek(), Some("--help" | "-h" | "help")) {
                args.next();
                args.finish()?;
                return Ok(Command::UnmountHelp);
            }
            let mountpoint = args.required("mountpoint")?;
            args.finish()?;
            Ok(Command::Unmount { mountpoint })
        }
        "mount" => {
            let mut positionals = Vec::new();
            let mut scope = None;
            let mut mode = MountMode::Default;
            let mut state_file = None;
            while let Some(arg) = args.optional() {
                match arg.as_str() {
                    "--help" | "-h" | "help" => return Ok(Command::MountHelp),
                    "--foreground" => mode = MountMode::Foreground,
                    "--background" => mode = MountMode::Background,
                    "--context" | "--ctx" => {
                        scope = Some(MountScope::Context(args.required("--context value")?));
                    }
                    "--workspace" | "--ws" => {
                        scope = Some(MountScope::Workspace(args.required("--workspace value")?));
                    }
                    "--all-workspaces" | "--database" => {
                        scope = Some(MountScope::Database);
                    }
                    "--backend" => {
                        return Err(UcError::new(
                            ErrorCode::InvalidInput,
                            "Mount backend selection was removed; `uc mount` uses NFS",
                        ));
                    }
                    "--mount-state-file" => {
                        state_file =
                            Some(PathBuf::from(args.required("--mount-state-file value")?));
                    }
                    _ => {
                        positionals.push(arg);
                    }
                }
            }
            if positionals.is_empty() {
                return Ok(Command::MountHelp);
            }
            let (scope, mountpoint) = parse_mount_positionals(scope, positionals)?;
            Ok(Command::Mount {
                scope,
                mountpoint,
                mode,
                state_file,
            })
        }
        _ => Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Unknown command: {command}"),
        )),
    }
}

fn parse_config_command(args: &mut Args) -> Result<Command, UcError> {
    let Some(command) = args.optional() else {
        return Ok(Command::ConfigHelp);
    };

    match command.as_str() {
        "help" | "--help" | "-h" => {
            args.finish()?;
            Ok(Command::ConfigHelp)
        }
        "list" | "ls" => {
            args.finish()?;
            Ok(Command::ConfigList)
        }
        "path" => {
            args.finish()?;
            Ok(Command::ConfigPath)
        }
        "get" => {
            let key = args.required("config key")?;
            args.finish()?;
            Ok(Command::ConfigGet { key })
        }
        "set" => {
            let key = args.required("config key")?;
            let value = args.required("config value")?;
            args.finish()?;
            Ok(Command::ConfigSet { key, value })
        }
        _ => Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Unknown config command: {command}"),
        )),
    }
}

fn parse_session_command(args: &mut Args) -> Result<Command, UcError> {
    let Some(command) = args.optional() else {
        return Ok(Command::SessionHelp);
    };

    match command.as_str() {
        // help
        "help" | "--help" | "-h" => {
            args.finish()?;
            Ok(Command::SessionHelp)
        }

        // create a session (optional metadata JSON)
        "create" => {
            let metadata = parse_metadata_arg(args.optional())?;
            args.finish()?;
            Ok(Command::SessionCreate { metadata })
        }

        // list every session in the workspace
        "list" | "ls" => {
            args.finish()?;
            Ok(Command::SessionList)
        }

        // fork a session, optionally from a specific version
        "fork" => {
            let session_id = args.required_value("session id")?;
            let version = parse_version_flag(args)?;
            args.finish()?;
            Ok(Command::SessionFork {
                session_id,
                version,
            })
        }

        // delete a session permanently
        "delete" | "rm" => {
            let session_id = args.required("session id")?;
            args.finish()?;
            Ok(Command::SessionDelete { session_id })
        }

        _ => Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Unknown session command: {command}"),
        )),
    }
}

fn parse_context_command(args: &mut Args) -> Result<Command, UcError> {
    let Some(command) = args.optional() else {
        return Ok(Command::ContextHelp);
    };

    match command.as_str() {
        // help
        "help" | "--help" | "-h" => {
            args.finish()?;
            Ok(Command::ContextHelp)
        }

        // read one context version for a session
        "get" => {
            let session_id = args.required_value("session id")?;
            let version = parse_version_flag(args)?;
            args.finish()?;
            Ok(Command::ContextGet {
                session_id,
                version,
            })
        }

        // list a session's context versions
        "history" => {
            let session_id = args.required("session id")?;
            args.finish()?;
            Ok(Command::ContextHistory { session_id })
        }

        // append a message to a session's context
        "append" => {
            let session_id = args.required("session id")?;
            let content = parse_content_arg(args.required("content")?)?;
            args.finish()?;
            Ok(Command::ContextAppend {
                session_id,
                content,
            })
        }

        // update a message by index or id
        "update" => {
            let session_id = args.required("session id")?;
            let target = parse_update_target(&args.required("target")?);
            let content = parse_content_arg(args.required("content")?)?;
            args.finish()?;
            Ok(Command::ContextUpdate {
                session_id,
                target,
                content,
            })
        }

        // delete one or more messages by index or id
        "delete" | "rm" => {
            let session_id = args.required("session id")?;
            let targets = args
                .rest()
                .into_iter()
                .map(|raw| parse_delete_target(&raw))
                .collect::<Vec<_>>();
            if targets.is_empty() {
                return Err(UcError::new(
                    ErrorCode::InvalidInput,
                    "Pass at least one message id or index",
                ));
            }
            Ok(Command::ContextDelete {
                session_id,
                targets,
            })
        }

        // clear all messages in a session's context
        "clear" => {
            let session_id = args.required("session id")?;
            args.finish()?;
            Ok(Command::ContextClear { session_id })
        }

        // restore an older context snapshot by id
        "restore" => {
            let session_id = args.required("session id")?;
            let context_id = args.required("context id")?;
            args.finish()?;
            Ok(Command::ContextRestore {
                session_id,
                context_id,
            })
        }

        _ => Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Unknown context command: {command}"),
        )),
    }
}

fn parse_version_flag(args: &mut Args) -> Result<Option<usize>, UcError> {
    let mut version = None;
    while let Some(flag) = args.optional() {
        match flag.as_str() {
            "--version" => {
                // Repeated --version is an explicit error, not silent last-wins.
                if version.is_some() {
                    return Err(UcError::new(
                        ErrorCode::InvalidInput,
                        "--version was passed more than once",
                    ));
                }
                version = Some(args.required("--version value")?.parse().map_err(|_| {
                    UcError::new(ErrorCode::InvalidInput, "--version must be a number")
                })?);
            }
            _ => {
                return Err(UcError::new(
                    ErrorCode::InvalidInput,
                    format!("Unexpected argument: {flag}"),
                ));
            }
        }
    }
    Ok(version)
}

// Strict like metadata: malformed JSON is rejected, never coerced to a raw string.
fn parse_content_arg(input: String) -> Result<Value, UcError> {
    serde_json::from_str(&input)
        .map_err(|_| UcError::new(ErrorCode::InvalidInput, "content must be JSON"))
}

fn parse_update_target(raw: &str) -> UpdateTarget {
    raw.parse::<isize>()
        .map(UpdateTarget::Index)
        .unwrap_or_else(|_| UpdateTarget::Id(raw.to_string()))
}

fn parse_delete_target(raw: &str) -> DeleteTarget {
    raw.parse::<isize>()
        .map(DeleteTarget::Index)
        .unwrap_or_else(|_| DeleteTarget::Id(raw.to_string()))
}

fn parse_fs_command(args: &mut Args) -> Result<Command, UcError> {
    let Some(command) = args.optional() else {
        return Ok(Command::FsHelp);
    };
    match command.as_str() {
        "help" | "--help" | "-h" => {
            args.finish()?;
            Ok(Command::FsHelp)
        }
        "list" | "ls" => {
            let ctx_id = args.required("context id")?;
            let mut prefix = None;
            while let Some(flag) = args.optional() {
                match flag.as_str() {
                    "--prefix" => prefix = Some(args.required("--prefix value")?),
                    _ => {
                        return Err(UcError::new(
                            ErrorCode::InvalidInput,
                            format!("Unexpected argument: {flag}"),
                        ));
                    }
                }
            }
            Ok(Command::FileList { ctx_id, prefix })
        }
        "read" | "cat" => {
            let ctx_id = args.required("context id")?;
            let path = args.required("path")?;
            args.finish()?;
            Ok(Command::FileRead { ctx_id, path })
        }
        "write" => {
            let ctx_id = args.required("context id")?;
            let path = args.required("path")?;
            let mut source = None;
            let mut kind = infer_kind(&path);
            while let Some(arg) = args.optional() {
                match arg.as_str() {
                    "--kind" => kind = args.required("--kind value")?,
                    _ if source.is_none() => source = Some(arg),
                    _ => {
                        return Err(UcError::new(
                            ErrorCode::InvalidInput,
                            format!("Unexpected argument: {arg}"),
                        ));
                    }
                }
            }
            Ok(Command::FileWrite {
                ctx_id,
                path,
                source,
                kind,
            })
        }
        "mv" | "move" => {
            let ctx_id = args.required("context id")?;
            let from = args.required("from path")?;
            let to = args.required("to path")?;
            args.finish()?;
            Ok(Command::FileMove { ctx_id, from, to })
        }
        "rm" | "remove" => {
            let ctx_id = args.required("context id")?;
            let path = args.required("path")?;
            args.finish()?;
            Ok(Command::FileRemove { ctx_id, path })
        }
        "glob" => {
            let ctx_id = args.required("context id")?;
            let pattern = args.required("pattern")?;
            args.finish()?;
            Ok(Command::FileGlob { ctx_id, pattern })
        }
        "grep" => {
            let ctx_id = args.required("context id")?;
            let query = args.required("query")?;
            let mut prefix = None;
            while let Some(flag) = args.optional() {
                match flag.as_str() {
                    "--prefix" => prefix = Some(args.required("--prefix value")?),
                    _ => {
                        return Err(UcError::new(
                            ErrorCode::InvalidInput,
                            format!("Unexpected argument: {flag}"),
                        ));
                    }
                }
            }
            Ok(Command::FileGrep {
                ctx_id,
                query,
                prefix,
            })
        }
        _ => Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Unknown fs command: {command}"),
        )),
    }
}

fn parse_mount_positionals(
    scope: Option<MountScope>,
    positionals: Vec<String>,
) -> Result<(MountScope, String), UcError> {
    match (scope, positionals.as_slice()) {
        (Some(scope), [mountpoint]) => Ok((scope, mountpoint.clone())),
        (Some(_), []) => Err(UcError::new(ErrorCode::InvalidInput, "Missing mountpoint")),
        (Some(_), _) => Err(UcError::new(
            ErrorCode::InvalidInput,
            "Pass only one mountpoint when using --context, --workspace, or --all-workspaces",
        )),
        (None, [mountpoint]) => Ok((MountScope::Auto, mountpoint.clone())),
        (None, [ctx_id, mountpoint]) => {
            Ok((MountScope::Context(ctx_id.clone()), mountpoint.clone()))
        }
        (None, []) => Err(UcError::new(ErrorCode::InvalidInput, "Missing mountpoint")),
        (None, _) => Err(UcError::new(
            ErrorCode::InvalidInput,
            "Usage: uc mount [--context handle|--workspace ws_id|--all-workspaces] <mountpoint>",
        )),
    }
}

fn parse_metadata_arg(input: Option<String>) -> Result<Value, UcError> {
    match input {
        Some(value) => serde_json::from_str(&value)
            .map_err(|_| UcError::new(ErrorCode::InvalidInput, "metadata must be JSON")),
        None => Ok(json!({})),
    }
}

fn read_input(path: Option<&str>) -> Result<Vec<u8>, UcError> {
    match path {
        Some("-") | None => {
            let mut data = Vec::new();
            io::stdin().read_to_end(&mut data).map_err(io_error)?;
            Ok(data)
        }
        Some(path) => fs::read(path).map_err(io_error),
    }
}

fn mount_context(
    store: StoreConfig,
    scope: MountScope,
    mountpoint: String,
    mode: MountMode,
    state_file: Option<PathBuf>,
    _err: &mut dyn Write,
) -> Result<(), UcError> {
    let foreground = match mode {
        MountMode::Foreground => true,
        MountMode::Background | MountMode::Default => false,
    };

    // Decode S3 settings into the engine store, threading the resolved inline limit.
    let s3 = store
        .s3
        .map(|settings| build_s3_store(&settings, store.inline_limit))
        .transpose()?;

    let options = nfs_mount::MountConfig {
        db: store.db,
        content_dir: store.content_dir,
        inline_limit: store.inline_limit,
        s3,
        scope,
        mountpoint: PathBuf::from(mountpoint),
        foreground,
        state_file,
    };
    nfs_mount::mount(options)
}

// A mount with no scope flag falls back to config's mount.defaultScope/defaultWorkspace.
fn resolve_default_mount_scope(scope: MountScope) -> Result<MountScope, UcError> {
    if scope != MountScope::Auto {
        return Ok(scope);
    }
    let Some(config) = active_config_value() else {
        return Ok(MountScope::Auto);
    };
    let workspace = config_string(&config, "mount.defaultWorkspace").map(str::to_string);
    match config_string(&config, "mount.defaultScope") {
        None | Some("auto") => Ok(MountScope::Auto),
        Some("database") | Some("all-workspaces") | Some("all") => Ok(MountScope::Database),
        Some("workspace") => workspace.map(MountScope::Workspace).ok_or_else(|| {
            UcError::new(
                ErrorCode::InvalidInput,
                "mount.defaultScope is \"workspace\" but mount.defaultWorkspace is not set",
            )
        }),
        Some(other) => Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Unknown mount.defaultScope: {other}"),
        )),
    }
}

// Lenient active-config read: returns the parsed JSON when a config file exists, else None.
fn active_config_value() -> Option<Value> {
    let path = active_config_path().ok()?;
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn print_json(out: &mut dyn Write, value: Value) -> Result<(), UcError> {
    serde_json::to_writer_pretty(&mut *out, &value)
        .map_err(|error| UcError::new(ErrorCode::Internal, error.to_string()))?;
    out.write_all(b"\n").map_err(io_error)
}

fn write_help(out: &mut dyn Write, color: bool) -> Result<(), UcError> {
    if color {
        write_colored_title(out)?;
    } else {
        out.write_all(b"ultracontext\ncontrol what agents see.\n\n")
            .map_err(io_error)?;
    }

    out.write_all(
        br#"Usage: uc [options] <command>

Basics:
  uc init                                      Create a local project DB/config
  uc mount <dir>                              Mount directly when one workspace exists; otherwise workspaces/<ws_id>/...
  uc unmount <dir>                            Stop a mounted workspace
  uc session <command>                        Manage sessions
  uc context <command>                        Operate on a session's context window
  uc search <query>                           Search contexts and files
  uc fs <command>                             Use the virtual filesystem API
  uc config <command>                         Manage project config

Options:
  --db <path>                  Use a specific DB
  --json                       Keep read output as JSON instead of raw bytes
  -h, --help                   Show help
"#,
    )
    .map_err(io_error)
}

fn write_colored_title(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        b"\x1b[38;2;235;95;87mu\
\x1b[38;2;245;139;87ml\
\x1b[38;2;250;195;95mt\
\x1b[38;2;145;200;130mr\
\x1b[38;2;130;170;220ma\
\x1b[38;2;155;130;200mc\
\x1b[38;2;200;130;180mo\
\x1b[38;2;235;95;87mn\
\x1b[38;2;245;139;87mt\
\x1b[38;2;250;195;95me\
\x1b[38;2;145;200;130mx\
\x1b[38;2;130;170;220mt\
\x1b[0m\ncontrol what agents see.\n\n",
    )
    .map_err(io_error)
}

fn write_init_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage:
  uc init [--global] [--force]

Creates ultracontext.json in this project and local state in .ultracontext/.
If a JS or Python project is detected, also adds the ultracontext SDK dependency.

Options:
  --global      Create ~/.ultracontext/config.json instead
  --force       Replace existing config
"#,
    )
    .map_err(io_error)
}

fn write_config_help(out: &mut dyn Write) -> Result<(), UcError> {
    // Static header.
    out.write_all(
        br#"Usage:
  uc config <command>

Commands:
  list             Print the active config
  path             Print the active config path
  get <key>        Print one config value
  set <key> <val>  Update one config value

Common keys:
"#,
    )
    .map_err(io_error)?;

    // Keys generated from the one config-key schema, so help can never drift.
    for entry in CONFIG_KEYS {
        writeln!(out, "  {}", entry.canonical).map_err(io_error)?;
    }
    Ok(())
}

fn write_mount_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage:
  uc mount <dir>

Mounts directly when one workspace exists; otherwise uses workspaces/<ws_id>/...

Options:
  --workspace <ws>      Mount one workspace directly
  --all-workspaces      Mount all workspaces at workspaces/<ws_id>/...
  --foreground          Keep the mount server attached for logs
"#,
    )
    .map_err(io_error)
}

fn write_unmount_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage:
  uc unmount <dir>

Stops a mounted workspace.
"#,
    )
    .map_err(io_error)
}

fn write_session_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage:
  uc session <command>

Commands:
  create [json]              Create a session
  list                       List sessions
  fork <session> [--version N]
                              Fork a session
  delete <session>           Delete a session
"#,
    )
    .map_err(io_error)
}

fn write_context_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage:
  uc context <command>

Commands:
  get <session> [--version N]   Read a context version
  history <session>             List a session's context versions
  append <session> <content>    Append a message
  update <session> <target> <content>
                                Update a message by index or id
  delete <session> <target>...  Delete messages by index or id
  clear <session>               Clear all messages
  restore <session> <context>   Restore an older context snapshot
"#,
    )
    .map_err(io_error)
}

fn write_search_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage:
  uc search <query>

Searches current context entries and current text file versions.
"#,
    )
    .map_err(io_error)
}

fn write_fs_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage:
  uc fs <command>

Commands:
  list <ctx> [--prefix p]   List files
  read <ctx> <path>         Print a file
  write <ctx> <path> [file|-]
                              Write a file
  move <ctx> <from> <to>    Move a file
  remove <ctx> <path>       Remove a file
  glob <ctx> <pattern>      Match files by glob
  grep <ctx> <query>        Search text files
"#,
    )
    .map_err(io_error)
}

fn exit_code(error: &UcError) -> i32 {
    match error.code {
        ErrorCode::InvalidInput => 2,
        ErrorCode::NotFound => 3,
        ErrorCode::Conflict => 4,
        ErrorCode::Busy => 5,
        ErrorCode::IncompatibleDb => 6,
        ErrorCode::Internal => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_global_options_before_command() {
        let parsed = Invocation::parse(vec![
            "--db".into(),
            "test.db".into(),
            "--json".into(),
            "fs".into(),
            "list".into(),
            "ctx_1".into(),
            "--prefix".into(),
            "drafts".into(),
        ])
        .unwrap();

        assert_eq!(parsed.db.as_deref(), Some("test.db"));
        assert!(parsed.json);
        assert_eq!(
            parsed.command,
            Command::FileList {
                ctx_id: "ctx_1".into(),
                prefix: Some("drafts".into())
            }
        );
    }

    #[test]
    fn parses_init_options() {
        let parsed =
            Invocation::parse(vec!["init".into(), "--local".into(), "--force".into()]).unwrap();

        assert_eq!(
            parsed.command,
            Command::Init {
                local: true,
                force: true,
                install_sdk: true,
            }
        );
    }

    #[test]
    fn parses_init_as_local_by_default() {
        let parsed = Invocation::parse(vec!["init".into()]).unwrap();
        let no_install = Invocation::parse(vec!["init".into(), "--no-install".into()]).unwrap();

        assert_eq!(
            parsed.command,
            Command::Init {
                local: true,
                force: false,
                install_sdk: true,
            }
        );
        assert_eq!(
            no_install.command,
            Command::Init {
                local: true,
                force: false,
                install_sdk: false,
            }
        );
    }

    #[test]
    fn parses_global_init_option() {
        let parsed = Invocation::parse(vec!["init".into(), "--global".into()]).unwrap();

        assert_eq!(
            parsed.command,
            Command::Init {
                local: false,
                force: false,
                install_sdk: true,
            }
        );
    }

    #[test]
    fn parses_session_namespace_commands() {
        let created = Invocation::parse(vec![
            "session".into(),
            "create".into(),
            "{\"name\":\"demo\"}".into(),
        ])
        .unwrap();
        let listed = Invocation::parse(vec!["session".into(), "list".into()]).unwrap();
        let forked = Invocation::parse(vec![
            "session".into(),
            "fork".into(),
            "ses_1".into(),
            "--version".into(),
            "2".into(),
        ])
        .unwrap();
        let deleted =
            Invocation::parse(vec!["session".into(), "delete".into(), "ses_1".into()]).unwrap();

        assert_eq!(
            created.command,
            Command::SessionCreate {
                metadata: json!({"name": "demo"}),
            }
        );
        assert_eq!(listed.command, Command::SessionList);
        assert_eq!(
            forked.command,
            Command::SessionFork {
                session_id: "ses_1".into(),
                version: Some(2),
            }
        );
        assert_eq!(
            deleted.command,
            Command::SessionDelete {
                session_id: "ses_1".into(),
            }
        );
    }

    #[test]
    fn parses_context_namespace_commands() {
        let got = Invocation::parse(vec![
            "context".into(),
            "get".into(),
            "ses_1".into(),
            "--version".into(),
            "0".into(),
        ])
        .unwrap();
        let history =
            Invocation::parse(vec!["context".into(), "history".into(), "ses_1".into()]).unwrap();
        let appended = Invocation::parse(vec![
            "context".into(),
            "append".into(),
            "ses_1".into(),
            "{\"role\":\"user\",\"content\":\"hi\"}".into(),
        ])
        .unwrap();
        let updated = Invocation::parse(vec![
            "context".into(),
            "update".into(),
            "ses_1".into(),
            "0".into(),
            "{\"content\":\"edit\"}".into(),
        ])
        .unwrap();
        let deleted = Invocation::parse(vec![
            "context".into(),
            "delete".into(),
            "ses_1".into(),
            "0".into(),
            "msg_2".into(),
        ])
        .unwrap();
        let cleared =
            Invocation::parse(vec!["context".into(), "clear".into(), "ses_1".into()]).unwrap();
        let restored = Invocation::parse(vec![
            "context".into(),
            "restore".into(),
            "ses_1".into(),
            "ctx_3".into(),
        ])
        .unwrap();

        assert_eq!(
            got.command,
            Command::ContextGet {
                session_id: "ses_1".into(),
                version: Some(0),
            }
        );
        assert_eq!(
            history.command,
            Command::ContextHistory {
                session_id: "ses_1".into(),
            }
        );
        assert_eq!(
            appended.command,
            Command::ContextAppend {
                session_id: "ses_1".into(),
                content: json!({"role": "user", "content": "hi"}),
            }
        );
        assert_eq!(
            updated.command,
            Command::ContextUpdate {
                session_id: "ses_1".into(),
                target: UpdateTarget::Index(0),
                content: json!({"content": "edit"}),
            }
        );
        assert_eq!(
            deleted.command,
            Command::ContextDelete {
                session_id: "ses_1".into(),
                targets: vec![DeleteTarget::Index(0), DeleteTarget::Id("msg_2".into())],
            }
        );
        assert_eq!(
            cleared.command,
            Command::ContextClear {
                session_id: "ses_1".into(),
            }
        );
        assert_eq!(
            restored.command,
            Command::ContextRestore {
                session_id: "ses_1".into(),
                context_id: "ctx_3".into(),
            }
        );
    }

    #[test]
    fn rejects_removed_legacy_commands() {
        for argv in [
            vec!["create".to_string()],
            vec!["contexts".to_string()],
            vec!["ls-contexts".to_string()],
            vec!["context".to_string(), "list".to_string()],
            vec!["context".to_string(), "create".to_string()],
            vec![
                "context".to_string(),
                "fork".to_string(),
                "ses_1".to_string(),
            ],
        ] {
            let err = Invocation::parse(argv.clone()).unwrap_err();
            assert_eq!(err.code_str(), "invalid_input", "argv: {argv:?}");
        }
    }

    #[test]
    fn parses_search_command() {
        let parsed =
            Invocation::parse(vec!["search".into(), "launch".into(), "notes".into()]).unwrap();

        assert_eq!(
            parsed.command,
            Command::Search {
                query: "launch notes".into(),
            }
        );
    }

    #[test]
    fn parses_config_namespace_commands() {
        let listed = Invocation::parse(vec!["config".into(), "list".into()]).unwrap();
        let path = Invocation::parse(vec!["config".into(), "path".into()]).unwrap();
        let get = Invocation::parse(vec![
            "config".into(),
            "get".into(),
            "storage.inlineLimit".into(),
        ])
        .unwrap();
        let set = Invocation::parse(vec![
            "config".into(),
            "set".into(),
            "storage.inline_limit".into(),
            "131072".into(),
        ])
        .unwrap();

        assert_eq!(listed.command, Command::ConfigList);
        assert_eq!(path.command, Command::ConfigPath);
        assert_eq!(
            get.command,
            Command::ConfigGet {
                key: "storage.inlineLimit".into(),
            }
        );
        assert_eq!(
            set.command,
            Command::ConfigSet {
                key: "storage.inline_limit".into(),
                value: "131072".into(),
            }
        );
    }

    #[test]
    fn shows_namespace_help_without_subcommand() {
        let session = Invocation::parse(vec!["session".into()]).unwrap();
        let context = Invocation::parse(vec!["context".into()]).unwrap();
        let fs = Invocation::parse(vec!["fs".into()]).unwrap();
        let config = Invocation::parse(vec!["config".into()]).unwrap();

        assert_eq!(session.command, Command::SessionHelp);
        assert_eq!(context.command, Command::ContextHelp);
        assert_eq!(fs.command, Command::FsHelp);
        assert_eq!(config.command, Command::ConfigHelp);
    }

    #[test]
    fn parses_subcommand_help_flags() {
        let init = Invocation::parse(vec!["init".into(), "--help".into()]).unwrap();
        let mount = Invocation::parse(vec!["mount".into(), "--help".into()]).unwrap();
        let mount_without_args = Invocation::parse(vec!["mount".into()]).unwrap();
        let unmount = Invocation::parse(vec!["unmount".into(), "--help".into()]).unwrap();
        let session = Invocation::parse(vec!["session".into(), "--help".into()]).unwrap();
        let context = Invocation::parse(vec!["context".into(), "--help".into()]).unwrap();
        let fs = Invocation::parse(vec!["fs".into(), "--help".into()]).unwrap();
        let search = Invocation::parse(vec!["search".into(), "--help".into()]).unwrap();
        let config = Invocation::parse(vec!["config".into(), "--help".into()]).unwrap();

        assert_eq!(init.command, Command::InitHelp);
        assert_eq!(mount.command, Command::MountHelp);
        assert_eq!(mount_without_args.command, Command::MountHelp);
        assert_eq!(unmount.command, Command::UnmountHelp);
        assert_eq!(session.command, Command::SessionHelp);
        assert_eq!(context.command, Command::ContextHelp);
        assert_eq!(fs.command, Command::FsHelp);
        assert_eq!(search.command, Command::SearchHelp);
        assert_eq!(config.command, Command::ConfigHelp);
    }

    #[test]
    fn rejects_legacy_file_namespace() {
        let err = Invocation::parse(vec!["file".into(), "--help".into()]).unwrap_err();

        assert_eq!(err.code_str(), "invalid_input");
        assert!(err.message.contains("Unknown command: file"));
    }

    #[test]
    fn infers_common_mime_types() {
        assert_eq!(infer_kind("draft.md"), "text/markdown");
        assert_eq!(infer_kind("screenshot.png"), "image/png");
        assert_eq!(infer_kind("archive.unknown"), "text/plain");
    }

    #[test]
    fn matches_python_requirements_by_package_name() {
        assert!(python_requirement_matches(
            "ultracontext==2.0.0a0",
            "ultracontext"
        ));
        assert!(python_requirement_matches(
            "Ultra_Context[cli] >= 2",
            "ultra-context"
        ));
        assert!(!python_requirement_matches(
            "other-ultracontext==1",
            "ultracontext"
        ));
        assert!(!python_requirement_matches(
            "-r requirements-dev.txt",
            "ultracontext"
        ));
    }

    #[test]
    fn adds_python_dependency_to_pyproject() {
        let dir = unique_test_dir("pyproject");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pyproject.toml");
        fs::write(
            &path,
            "[project]\nname = \"demo\"\ndependencies = [\"requests\"]\n",
        )
        .unwrap();

        let added =
            add_pyproject_dependency(&path, "ultracontext", "ultracontext==2.0.0a0").unwrap();
        assert_eq!(added["dependency_added"], true);

        let data = fs::read_to_string(&path).unwrap();
        assert!(data.contains("\"requests\""));
        assert!(data.contains("\"ultracontext==2.0.0a0\""));

        let existing =
            add_pyproject_dependency(&path, "ultracontext", "ultracontext==2.0.0a0").unwrap();
        assert_eq!(existing["reason"], "already_present");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn adds_python_dependency_to_requirements() {
        let dir = unique_test_dir("requirements");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("requirements.txt");
        fs::write(&path, "requests==2\n").unwrap();

        let added =
            add_requirements_dependency(&path, "ultracontext", "ultracontext==2.0.0a0").unwrap();
        assert_eq!(added["dependency_added"], true);
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("ultracontext==2.0.0a0\n")
        );

        let existing =
            add_requirements_dependency(&path, "ultracontext", "ultracontext==2.0.0a0").unwrap();
        assert_eq!(existing["reason"], "already_present");
        fs::remove_dir_all(dir).unwrap();
    }

    fn unique_test_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("uc-cli-{label}-{}-{nanos}", process::id()))
    }

    #[test]
    fn parses_auto_mount_by_default() {
        let parsed = Invocation::parse(vec!["mount".into(), "/tmp/uc".into()]).unwrap();

        assert_eq!(
            parsed.command,
            Command::Mount {
                scope: MountScope::Auto,
                mountpoint: "/tmp/uc".into(),
                mode: MountMode::Default,
                state_file: None,
            }
        );
    }

    #[test]
    fn parses_all_workspaces_mount_flag() {
        let parsed = Invocation::parse(vec![
            "mount".into(),
            "--all-workspaces".into(),
            "/tmp/uc".into(),
        ])
        .unwrap();

        assert_eq!(
            parsed.command,
            Command::Mount {
                scope: MountScope::Database,
                mountpoint: "/tmp/uc".into(),
                mode: MountMode::Default,
                state_file: None,
            }
        );
    }

    #[test]
    fn rejects_mount_backend_option() {
        let err = Invocation::parse(vec![
            "mount".into(),
            "/tmp/uc".into(),
            "--backend".into(),
            "nfs".into(),
        ])
        .unwrap_err();

        assert_eq!(err.code_str(), "invalid_input");
        assert!(err.message.contains("uses NFS"));
    }

    #[test]
    fn parses_context_mount_flag() {
        let parsed = Invocation::parse(vec![
            "mount".into(),
            "--context".into(),
            "ctx_1".into(),
            "/tmp/uc".into(),
        ])
        .unwrap();

        assert_eq!(
            parsed.command,
            Command::Mount {
                scope: MountScope::Context("ctx_1".into()),
                mountpoint: "/tmp/uc".into(),
                mode: MountMode::Default,
                state_file: None,
            }
        );
    }

    #[test]
    fn parses_workspace_mount_flag() {
        let parsed = Invocation::parse(vec![
            "mount".into(),
            "--workspace".into(),
            "ws_project".into(),
            "/tmp/uc".into(),
        ])
        .unwrap();

        assert_eq!(
            parsed.command,
            Command::Mount {
                scope: MountScope::Workspace("ws_project".into()),
                mountpoint: "/tmp/uc".into(),
                mode: MountMode::Default,
                state_file: None,
            }
        );
    }

    #[test]
    fn parses_unmount() {
        let parsed = Invocation::parse(vec!["unmount".into(), "/tmp/uc".into()]).unwrap();

        assert_eq!(
            parsed.command,
            Command::Unmount {
                mountpoint: "/tmp/uc".into(),
            }
        );
    }
}
