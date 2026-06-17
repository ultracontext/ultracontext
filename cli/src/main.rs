use serde_json::{Value, json};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use ultracontext::{
    ContentStore, ErrorCode, FileWrite, UcError, UltraContext, UltraContextOptions,
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

#[cfg(feature = "fuse")]
mod fuse_mount;

use mount_utils::{MountScope, infer_kind, io_error};

fn main() {
    if let Err(error) = run(
        env::args().skip(1).collect(),
        &mut io::stdout(),
        &mut io::stderr(),
    ) {
        let _ = writeln!(io::stderr(), "{}: {}", error.code_str(), error.message);
        std::process::exit(exit_code(&error));
    }
}

fn run(args: Vec<String>, out: &mut dyn Write, err: &mut dyn Write) -> Result<(), UcError> {
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
            write_help(out)?;
            Ok(())
        }
        Command::Create { metadata } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            let ctx = uc.create(metadata)?;
            print_json(
                out,
                json!({
                    "id": ctx.id,
                    "metadata": ctx.metadata,
                    "created_at": ctx.created_at
                }),
            )
        }
        Command::Contexts => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            let data = uc
                .list_contexts()?
                .into_iter()
                .map(|ctx| {
                    json!({
                        "id": ctx.id,
                        "metadata": ctx.metadata,
                        "created_at": ctx.created_at
                    })
                })
                .collect::<Vec<_>>();
            print_json(out, json!({ "data": data }))
        }
        Command::FileList { ctx_id, prefix } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            let data = uc
                .file_list(&ctx_id, prefix.as_deref())?
                .into_iter()
                .map(artifact_meta_json)
                .collect::<Vec<_>>();
            print_json(out, json!({ "data": data }))
        }
        Command::FileRead { ctx_id, path } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            if json {
                let artifact = uc.file_read(&ctx_id, &path)?;
                print_json(out, artifact_data_json(artifact))
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
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            let saved = uc.file_write(
                &ctx_id,
                FileWrite::new(path, data)
                    .with_kind(kind)
                    .with_metadata(json!({"source": "uc-cli"})),
            )?;
            print_json(out, artifact_meta_json(saved))
        }
        Command::FileMove { ctx_id, from, to } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            let moved = uc.file_move(&ctx_id, &from, &to, None)?;
            print_json(out, artifact_meta_json(moved))
        }
        Command::FileRemove { ctx_id, path } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            uc.file_remove(&ctx_id, &path, None)?;
            print_json(out, json!({ "deleted": true, "path": path }))
        }
        Command::FileGlob { ctx_id, pattern } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            let data = uc
                .file_glob(&ctx_id, &pattern)?
                .into_iter()
                .map(artifact_meta_json)
                .collect::<Vec<_>>();
            print_json(out, json!({ "data": data }))
        }
        Command::FileGrep {
            ctx_id,
            query,
            prefix,
        } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            let data = uc
                .file_grep(&ctx_id, &query, prefix.as_deref())?
                .data
                .into_iter()
                .map(|hit| {
                    json!({
                        "kind": "artifact",
                        "id": hit.id,
                        "context_id": hit.context_id,
                        "path": hit.path,
                        "snippet": hit.snippet,
                        "metadata": hit.metadata,
                        "created_at": hit.created_at
                    })
                })
                .collect::<Vec<_>>();
            print_json(out, json!({ "data": data }))
        }
        Command::Materialize { ctx_id, dir } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            materialize_context(&uc, &ctx_id, &dir)?;
            print_json(out, json!({ "materialized": true, "dir": dir }))
        }
        Command::SyncDir { ctx_id, dir } => {
            let uc = open_store(&db, content_dir.as_ref(), inline_limit)?;
            sync_dir_to_context(&uc, &ctx_id, &dir)?;
            print_json(out, json!({ "synced": true, "dir": dir }))
        }
        Command::Mount {
            scope,
            mountpoint,
            mode,
            backend,
            state_file,
        } => mount_context(
            StoreConfig {
                db,
                content_dir,
                inline_limit,
            },
            scope,
            mountpoint,
            mode,
            backend,
            state_file,
            err,
        ),
        Command::Unmount { mountpoint } => {
            nfs_mount::unmount(PathBuf::from(&mountpoint))?;
            print_json(out, json!({ "unmounted": true, "mountpoint": mountpoint }))
        }
    }
}

#[derive(Debug)]
struct Invocation {
    db: String,
    content_dir: Option<PathBuf>,
    inline_limit: usize,
    json: bool,
    command: Command,
}

#[derive(Debug, PartialEq)]
enum Command {
    Help,
    Create {
        metadata: Value,
    },
    Contexts,
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
    Materialize {
        ctx_id: String,
        dir: String,
    },
    SyncDir {
        ctx_id: String,
        dir: String,
    },
    Mount {
        scope: MountScope,
        mountpoint: String,
        mode: MountMode,
        backend: MountBackend,
        state_file: Option<PathBuf>,
    },
    Unmount {
        mountpoint: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MountBackend {
    Nfs,
    Fuse,
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
        let mut db = env::var("UC_DB").unwrap_or_else(|_| "ultracontext.db".to_string());
        let mut content_dir = env::var_os("UC_CONTENT_DIR").map(PathBuf::from);
        let mut inline_limit = env::var("UC_INLINE_LIMIT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(64 * 1024);
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
                    db = parser.required("--db value")?;
                }
                "--content-dir" => {
                    parser.next();
                    content_dir = Some(PathBuf::from(parser.required("--content-dir value")?));
                }
                "--inline-limit" => {
                    parser.next();
                    inline_limit =
                        parser
                            .required("--inline-limit value")?
                            .parse()
                            .map_err(|_| {
                                UcError::new(
                                    ErrorCode::InvalidInput,
                                    "--inline-limit must be a number",
                                )
                            })?;
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

#[cfg_attr(not(feature = "fuse"), allow(dead_code))]
struct StoreConfig {
    db: String,
    content_dir: Option<PathBuf>,
    inline_limit: usize,
}

fn open_store(
    db: &str,
    content_dir: Option<&PathBuf>,
    inline_limit: usize,
) -> Result<UltraContext, UcError> {
    let content_store = content_dir
        .map(|root| ContentStore::local_dir(root, inline_limit))
        .unwrap_or_else(|| ContentStore::inline_with_limit(inline_limit));
    UltraContext::open_with_options(db, UltraContextOptions { content_store })
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

    fn optional(&mut self) -> Option<String> {
        self.next()
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
        "create" => {
            let metadata = parse_metadata_arg(args.optional())?;
            args.finish()?;
            Ok(Command::Create { metadata })
        }
        "contexts" | "ls-contexts" => {
            args.finish()?;
            Ok(Command::Contexts)
        }
        "file" => parse_file_command(args),
        "materialize" => {
            let ctx_id = args.required("context id")?;
            let dir = args.required("directory")?;
            args.finish()?;
            Ok(Command::Materialize { ctx_id, dir })
        }
        "sync-dir" => {
            let ctx_id = args.required("context id")?;
            let dir = args.required("directory")?;
            args.finish()?;
            Ok(Command::SyncDir { ctx_id, dir })
        }
        "unmount" | "umount" => {
            let mountpoint = args.required("mountpoint")?;
            args.finish()?;
            Ok(Command::Unmount { mountpoint })
        }
        "mount" => {
            let mut positionals = Vec::new();
            let mut scope = None;
            let mut mode = MountMode::Default;
            let mut backend = MountBackend::Nfs;
            let mut state_file = None;
            while let Some(arg) = args.optional() {
                match arg.as_str() {
                    "--foreground" => mode = MountMode::Foreground,
                    "--background" => mode = MountMode::Background,
                    "--context" | "--ctx" => {
                        scope = Some(MountScope::Context(args.required("--context value")?));
                    }
                    "--backend" => {
                        backend = match args.required("--backend value")?.as_str() {
                            "nfs" => MountBackend::Nfs,
                            "fuse" => MountBackend::Fuse,
                            other => {
                                return Err(UcError::new(
                                    ErrorCode::InvalidInput,
                                    format!("Unknown mount backend: {other}"),
                                ));
                            }
                        };
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
            let (scope, mountpoint) = parse_mount_positionals(scope, positionals)?;
            Ok(Command::Mount {
                scope,
                mountpoint,
                mode,
                backend,
                state_file,
            })
        }
        _ => Err(UcError::new(
            ErrorCode::InvalidInput,
            format!("Unknown command: {command}"),
        )),
    }
}

fn parse_file_command(args: &mut Args) -> Result<Command, UcError> {
    let command = args.required("file command")?;
    match command.as_str() {
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
            format!("Unknown file command: {command}"),
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
            "Pass only one mountpoint when using --context",
        )),
        (None, [mountpoint]) => Ok((MountScope::Database, mountpoint.clone())),
        (None, [ctx_id, mountpoint]) => {
            Ok((MountScope::Context(ctx_id.clone()), mountpoint.clone()))
        }
        (None, []) => Err(UcError::new(ErrorCode::InvalidInput, "Missing mountpoint")),
        (None, _) => Err(UcError::new(
            ErrorCode::InvalidInput,
            "Usage: uc mount [--context ctx_id] <mountpoint>",
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

fn materialize_context(uc: &UltraContext, ctx_id: &str, dir: &str) -> Result<(), UcError> {
    let root = Path::new(dir);
    fs::create_dir_all(root).map_err(io_error)?;
    for artifact in uc.file_list(ctx_id, None)? {
        let data = uc.load_artifact_bytes(ctx_id, &artifact.path, None)?;
        let path = root.join(&artifact.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::write(path, data.data).map_err(io_error)?;
    }
    Ok(())
}

fn sync_dir_to_context(uc: &UltraContext, ctx_id: &str, dir: &str) -> Result<(), UcError> {
    let root = Path::new(dir);
    for path in walk_files(root)? {
        let relative = path
            .strip_prefix(root)
            .map_err(|error| UcError::new(ErrorCode::InvalidInput, error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        let data = fs::read(&path).map_err(io_error)?;
        uc.file_write(
            ctx_id,
            FileWrite::new(&relative, data)
                .with_kind(infer_kind(&relative))
                .with_metadata(json!({"source": "uc-cli-sync-dir"})),
        )?;
    }
    Ok(())
}

fn walk_files(root: &Path) -> Result<Vec<PathBuf>, UcError> {
    let mut out = Vec::new();
    if !root.exists() {
        return Err(UcError::new(
            ErrorCode::NotFound,
            format!("Directory not found: {}", root.display()),
        ));
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

fn mount_context(
    store: StoreConfig,
    scope: MountScope,
    mountpoint: String,
    mode: MountMode,
    backend: MountBackend,
    state_file: Option<PathBuf>,
    _err: &mut dyn Write,
) -> Result<(), UcError> {
    let foreground = match (backend, mode) {
        (_, MountMode::Foreground) => true,
        (_, MountMode::Background) => false,
        (MountBackend::Nfs, MountMode::Default) => false,
        (MountBackend::Fuse, MountMode::Default) => true,
    };

    match backend {
        MountBackend::Nfs => {
            let options = nfs_mount::MountConfig {
                db: store.db,
                content_dir: store.content_dir,
                inline_limit: store.inline_limit,
                scope,
                mountpoint: PathBuf::from(mountpoint),
                foreground,
                state_file,
            };
            nfs_mount::mount(options)
        }
        MountBackend::Fuse => {
            #[cfg(feature = "fuse")]
            {
                let MountScope::Context(ctx_id) = scope else {
                    return Err(UcError::new(
                        ErrorCode::InvalidInput,
                        "FUSE backend currently requires `--context ctx_...`; DB-wide mounts use the default NFS backend",
                    ));
                };
                let options = fuse_mount::MountConfig {
                    db: store.db,
                    content_dir: store.content_dir,
                    inline_limit: store.inline_limit,
                    ctx_id,
                    mountpoint: PathBuf::from(mountpoint),
                    foreground,
                };
                fuse_mount::mount(options)
            }

            #[cfg(not(feature = "fuse"))]
            {
                let _ = (store, scope, mountpoint, foreground);
                Err(UcError::new(
                    ErrorCode::InvalidInput,
                    "FUSE backend requires building the CLI with `--features fuse` and system FUSE installed",
                ))
            }
        }
    }
}

fn artifact_meta_json(meta: ultracontext::ArtifactMeta) -> Value {
    json!({
        "id": meta.id,
        "path": meta.path,
        "kind": meta.kind,
        "size": meta.size,
        "version": meta.version,
        "created_at": meta.created_at
    })
}

fn artifact_data_json(data: ultracontext::ArtifactData) -> Value {
    json!({
        "id": data.id,
        "path": data.path,
        "kind": data.kind,
        "size": data.size,
        "version": data.version,
        "metadata": data.metadata,
        "storage": data.storage,
        "data": data.data,
        "created_at": data.created_at
    })
}

fn print_json(out: &mut dyn Write, value: Value) -> Result<(), UcError> {
    serde_json::to_writer_pretty(&mut *out, &value)
        .map_err(|error| UcError::new(ErrorCode::Internal, error.to_string()))?;
    out.write_all(b"\n").map_err(io_error)
}

fn write_help(out: &mut dyn Write) -> Result<(), UcError> {
    out.write_all(
        br#"Usage: uc [options] <command>

Options:
  --db <path>                  SQLite node store path (default: ultracontext.db)
  --content-dir <path>         Store large artifact bytes in a local directory
  --inline-limit <bytes>       Inline content limit (default: 65536)
  --json                       Keep read output as JSON instead of raw bytes
  -h, --help                   Show help

Commands:
  create [metadata-json]       Create a context
  contexts                     List contexts
  file list <ctx> [--prefix p] List artifact files
  file read <ctx> <path>       Print a file
  file write <ctx> <path> [source|-] [--kind mime]
  file mv <ctx> <from> <to>
  file rm <ctx> <path>
  file glob <ctx> <pattern>
  file grep <ctx> <query> [--prefix p]
  materialize <ctx> <dir>      Write context artifacts to a directory
  sync-dir <ctx> <dir>         Import directory files as artifacts
  mount <mountpoint>           Mount the full DB at contexts/<ctx_id>/...
  mount --context <ctx> <mnt>  Mount one context directly
  mount <ctx> <mountpoint>     Legacy shorthand for --context
  unmount <mountpoint>         Unmount and stop the local mount server
    [--backend nfs|fuse]       Select mount backend (default: nfs)
    [--foreground|--background]

Mount:
  NFS is the default backend, runs in background by default, and does not require macFUSE.
  Use `uc unmount <mountpoint>` to stop it. Pass --foreground for logs/debug.
  FUSE is optional and foreground-only.
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
            "file".into(),
            "list".into(),
            "ctx_1".into(),
            "--prefix".into(),
            "drafts".into(),
        ])
        .unwrap();

        assert_eq!(parsed.db, "test.db");
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
    fn infers_common_mime_types() {
        assert_eq!(infer_kind("draft.md"), "text/markdown");
        assert_eq!(infer_kind("screenshot.png"), "image/png");
        assert_eq!(infer_kind("archive.unknown"), "text/plain");
    }

    #[test]
    fn parses_mount_backend() {
        let parsed = Invocation::parse(vec![
            "mount".into(),
            "ctx_1".into(),
            "/tmp/uc".into(),
            "--backend".into(),
            "fuse".into(),
        ])
        .unwrap();

        assert_eq!(
            parsed.command,
            Command::Mount {
                scope: MountScope::Context("ctx_1".into()),
                mountpoint: "/tmp/uc".into(),
                mode: MountMode::Default,
                backend: MountBackend::Fuse,
                state_file: None,
            }
        );
    }

    #[test]
    fn parses_database_mount_by_default() {
        let parsed = Invocation::parse(vec!["mount".into(), "/tmp/uc".into()]).unwrap();

        assert_eq!(
            parsed.command,
            Command::Mount {
                scope: MountScope::Database,
                mountpoint: "/tmp/uc".into(),
                mode: MountMode::Default,
                backend: MountBackend::Nfs,
                state_file: None,
            }
        );
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
                backend: MountBackend::Nfs,
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
