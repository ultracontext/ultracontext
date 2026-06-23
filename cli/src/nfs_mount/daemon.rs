//! Mount lifecycle: foreground/background launch, state-file bookkeeping, and the
//! conservative shutdown/cleanup rules that avoid dup-mounting or killing a live daemon.

use serde_json::Value;
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs::{self, OpenOptions};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use ultracontext::{
    ContentStore, ErrorCode, S3ContentStore, UcError, UltraContext, UltraContextOptions,
};

use super::super::mount_utils::{MountScope, io_error};
use super::super::nfsserve::tcp::{NFSTcp, NFSTcpListener};
use super::os;
use super::vfs::{UcNfs, resolve_mount_scope};

const DEFAULT_NFS_PORT: u16 = 11111;
const STATE_DIR_ENV: &str = "UC_MOUNT_STATE_DIR";

// Everything the mount command needs: store wiring, scope, mountpoint, and run mode.
pub struct MountConfig {
    pub db: String,
    pub content_dir: Option<PathBuf>,
    pub inline_limit: usize,
    pub s3: Option<S3ContentStore>,
    pub scope: MountScope,
    pub mountpoint: PathBuf,
    pub foreground: bool,
    pub state_file: Option<PathBuf>,
}

// Entry point: background by default, otherwise run the async server in the foreground.
pub fn mount(config: MountConfig) -> Result<(), UcError> {
    if !config.foreground {
        return spawn_background(config);
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(io_error)?;
    runtime.block_on(mount_async(config))
}

// Unmount the kernel mount, then delete state/log files only when no live daemon remains (NEW#3).
pub fn unmount(mountpoint: PathBuf) -> Result<(), UcError> {
    let mountpoint = canonical_mountpoint(&mountpoint);
    let state_files = state_files_for_mountpoint(&mountpoint);

    // Try to unmount unless we are certain nothing is mounted; surface a still-mounted failure.
    if mountpoint_is_mounted(&mountpoint) != Some(false)
        && let Err(error) = os::unmount_nfs(&mountpoint)
        && mountpoint_is_mounted(&mountpoint) != Some(false)
    {
        return Err(error);
    }

    for state_file in state_files {
        let state = read_mount_state(&state_file);
        cleanup_mount_state(
            &state_file,
            &log_file_for_state(&state_file),
            state.as_ref(),
            &mountpoint,
        );
    }
    Ok(())
}

// Launch a detached foreground daemon, refusing if an active one already owns the mountpoint.
fn spawn_background(config: MountConfig) -> Result<(), UcError> {
    let mountpoint = canonical_mountpoint(&config.mountpoint);
    fs::create_dir_all(&mountpoint).map_err(io_error)?;

    let state_file = state_file_for_mountpoint(&mountpoint)?;
    let log_file = log_file_for_state(&state_file);
    fs::create_dir_all(state_file.parent().unwrap_or_else(|| Path::new("."))).map_err(io_error)?;

    // Refuse to start when another daemon still looks active for this mountpoint.
    let states = state_files_for_mountpoint(&mountpoint)
        .into_iter()
        .map(|state_file| {
            let state = read_mount_state(&state_file);
            (state_file, state)
        })
        .collect::<Vec<_>>();
    if states.iter().any(|(_, state)| {
        state
            .as_ref()
            .is_some_and(|state| mount_state_is_active(state, &mountpoint))
    }) {
        return Err(UcError::new(
            ErrorCode::Busy,
            format!(
                "Mount already appears to be running at {}",
                mountpoint.display()
            ),
        ));
    }
    for (candidate_state_file, state) in &states {
        cleanup_mount_state(
            candidate_state_file,
            &log_file_for_state(candidate_state_file),
            state.as_ref(),
            &mountpoint,
        );
    }

    // Clear any stale kernel mount left behind by a dead daemon before remounting (NEW#6).
    if mountpoint_is_mounted(&mountpoint) == Some(true) {
        let _ = os::unmount_nfs(&mountpoint);
    }

    let exe = env::current_exe().map_err(io_error)?;
    let mut command = Command::new(exe);
    command
        .arg("--db")
        .arg(&config.db)
        .arg("--inline-limit")
        .arg(config.inline_limit.to_string());
    if let Some(content_dir) = &config.content_dir {
        command.arg("--content-dir").arg(content_dir);
    }
    if let Some(s3) = &config.s3 {
        command.env("UC_STORAGE_DRIVER", "s3");
        command.env("UC_S3_ENDPOINT", &s3.endpoint);
        command.env("UC_S3_BUCKET", &s3.bucket);
        command.env("UC_S3_REGION", &s3.region);
        command.env("UC_S3_ACCESS_KEY_ID", &s3.access_key_id);
        command.env("UC_S3_SECRET_ACCESS_KEY", &s3.secret_access_key);
        if let Some(token) = &s3.session_token {
            command.env("UC_S3_SESSION_TOKEN", token);
        }
        if let Some(prefix) = &s3.prefix {
            command.env("UC_S3_PREFIX", prefix);
        }
    }
    command.arg("mount");
    match &config.scope {
        MountScope::Auto => {}
        MountScope::Context(ctx_id) => {
            command.arg("--context").arg(ctx_id);
        }
        MountScope::Workspace(workspace_id) => {
            command.arg("--workspace").arg(workspace_id);
        }
        MountScope::Database => {
            command.arg("--all-workspaces");
        }
    }
    command
        .arg(&mountpoint)
        .arg("--foreground")
        .arg("--mount-state-file")
        .arg(&state_file);

    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map_err(io_error)?;
    let log_err = log.try_clone().map_err(io_error)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    os::detach_command(&mut command);

    let mut child = command.spawn().map_err(io_error)?;
    let child_pid = child.id();
    for _ in 0..50 {
        if read_mount_state(&state_file)
            .and_then(|state| state.pid)
            .is_some_and(|pid| pid == child_pid)
        {
            std::thread::sleep(Duration::from_millis(200));
            if os::process_running(child_pid) {
                return Ok(());
            }
            let _ = fs::remove_file(&state_file);
            return Err(UcError::new(
                ErrorCode::Internal,
                format!(
                    "Background mount process exited after mounting. See log: {}",
                    log_file.display()
                ),
            ));
        }
        if let Some(status) = child.try_wait().map_err(io_error)? {
            let _ = fs::remove_file(&state_file);
            return Err(UcError::new(
                ErrorCode::Internal,
                format!(
                    "Background mount exited with status {status}. See log: {}",
                    log_file.display()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Err(UcError::new(
        ErrorCode::Busy,
        format!(
            "Timed out waiting for background mount. See log: {}",
            log_file.display()
        ),
    ))
}

// Build the engine, bind the in-process NFS server, mount it, then wait for shutdown.
async fn mount_async(config: MountConfig) -> Result<(), UcError> {
    fs::create_dir_all(&config.mountpoint).map_err(io_error)?;
    let content_store = config
        .s3
        .map(ContentStore::s3)
        .or_else(|| {
            config
                .content_dir
                .as_ref()
                .map(|root| ContentStore::local_dir(root, config.inline_limit))
        })
        .unwrap_or_else(|| ContentStore::inline_with_limit(config.inline_limit));
    let uc = UltraContext::open_with_options(&config.db, UltraContextOptions { content_store })?;
    let scope = resolve_mount_scope(&uc, config.scope)?;
    let fs = UcNfs::new(uc, scope, &config.db);
    let port = find_available_port(DEFAULT_NFS_PORT)?;
    let bind_addr = format!("127.0.0.1:{port}");
    let listener = NFSTcpListener::bind(&bind_addr, fs)
        .await
        .map_err(io_error)?;

    let server = tokio::spawn(async move {
        let _ = listener.handle_forever().await;
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    os::mount_nfs(port, &config.mountpoint)?;
    write_mount_state(config.state_file.as_deref(), &config.mountpoint, port)?;

    if config.state_file.is_some() {
        wait_for_daemon_shutdown().await;
    } else {
        wait_for_foreground_shutdown().await;
        let _ = os::unmount_nfs(&config.mountpoint);
        remove_current_mount_state(config.state_file.as_deref(), &config.mountpoint);
        server.abort();
    }
    Ok(())
}

// First free TCP port at or above `start` for the loopback NFS server.
fn find_available_port(start: u16) -> Result<u16, UcError> {
    let mut last_error = None;
    for port in start..=u16::MAX {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(_) => return Ok(port),
            Err(error) => last_error = Some(error),
        }
    }
    Err(UcError::new(
        ErrorCode::Busy,
        format!(
            "No available NFS port from {start}: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown bind error".to_string())
        ),
    ))
}

// Persisted daemon state used to detect live mounts across processes.
#[derive(Debug, Clone)]
pub struct MountState {
    pub pid: Option<u32>,
    pub mountpoint: Option<PathBuf>,
}

// Write the running daemon's pid/mountpoint/port into its state file.
fn write_mount_state(
    state_file: Option<&Path>,
    mountpoint: &Path,
    port: u16,
) -> Result<(), UcError> {
    let Some(state_file) = state_file else {
        return Ok(());
    };
    fs::create_dir_all(state_file.parent().unwrap_or_else(|| Path::new("."))).map_err(io_error)?;
    let mountpoint = canonical_mountpoint(mountpoint);
    let state = json!({
        "pid": std::process::id(),
        "mountpoint": mountpoint,
        "port": port,
    });
    fs::write(state_file, state.to_string()).map_err(io_error)
}

// Remove this daemon's own state file on clean foreground shutdown.
fn remove_current_mount_state(state_file: Option<&Path>, mountpoint: &Path) {
    if let Some(state_file) = state_file {
        let _ = fs::remove_file(state_file);
    } else if let Ok(state_file) = state_file_for_mountpoint(&canonical_mountpoint(mountpoint)) {
        let _ = fs::remove_file(state_file);
    }
}

// Parse a state file into pid + mountpoint, tolerating malformed/absent files.
pub fn read_mount_state(path: &Path) -> Option<MountState> {
    let data = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&data).ok()?;
    Some(MountState {
        pid: value
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok()),
        mountpoint: value
            .get("mountpoint")
            .and_then(Value::as_str)
            .map(PathBuf::from),
    })
}

// Active = pid alive AND the mount is not *definitely* gone; unknown probes stay active (NEW#5).
fn mount_state_is_active(state: &MountState, mountpoint: &Path) -> bool {
    let Some(pid) = state.pid else {
        return false;
    };

    os::process_running(pid) && mountpoint_is_mounted(mountpoint) != Some(false)
}

// Terminate only a confirmed-orphan daemon, and only then delete its state/log files (NEW#3).
fn cleanup_mount_state(
    state_file: &Path,
    log_file: &Path,
    state: Option<&MountState>,
    mountpoint: &Path,
) {
    // Decide whether the daemon recorded in this state file is gone or safe to terminate.
    let daemon_cleared = match state.and_then(|state| state.pid.map(|pid| (state, pid))) {
        // No pid recorded: nothing to keep alive for.
        None => true,
        Some((state, pid)) => {
            if !os::process_running(pid) {
                // Process is gone; its files are stale.
                true
            } else if mountpoint_is_mounted(mountpoint) == Some(false)
                && os::process_matches_mount_state(pid, state, state_file, mountpoint) == Some(true)
            {
                // Confirmed orphan (live pid, definitely unmounted, and it is our mount): reap it.
                os::terminate_process(pid);
                true
            } else {
                // Live daemon or inconclusive probe: leave it and its files intact.
                false
            }
        }
    };

    if daemon_cleared {
        let _ = fs::remove_file(state_file);
        let _ = fs::remove_file(log_file);
    }
}

// Canonicalize a mountpoint, falling back to an absolute path when it does not yet exist.
pub fn canonical_mountpoint(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    })
}

// Root directory holding per-mount state files.
fn state_dir() -> PathBuf {
    env::var_os(STATE_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("ultracontext-mounts"))
}

fn state_file_for_mountpoint(mountpoint: &Path) -> Result<PathBuf, UcError> {
    Ok(state_file_for_mountpoint_in_dir(mountpoint, &state_dir()))
}

// Deterministic state-file name derived from the mountpoint hash.
fn state_file_for_mountpoint_in_dir(mountpoint: &Path, state_dir: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    mountpoint.to_string_lossy().hash(&mut hasher);
    state_dir.join(format!("{:016x}.json", hasher.finish()))
}

fn state_files_for_mountpoint(mountpoint: &Path) -> Vec<PathBuf> {
    state_files_for_mountpoint_in_dir(mountpoint, &state_dir())
}

// Primary state file plus any legacy-hashed files that point at the same mountpoint.
fn state_files_for_mountpoint_in_dir(mountpoint: &Path, state_dir: &Path) -> Vec<PathBuf> {
    let primary = state_file_for_mountpoint_in_dir(mountpoint, state_dir);
    let mut files = vec![primary.clone()];

    let Ok(entries) = fs::read_dir(state_dir) else {
        return files;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path == primary
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }
        if state_file_matches_mountpoint(&path, mountpoint) {
            files.push(path);
        }
    }

    files
}

// True when a state file's recorded mountpoint canonicalizes to the target mountpoint.
fn state_file_matches_mountpoint(state_file: &Path, mountpoint: &Path) -> bool {
    let Some(state) = read_mount_state(state_file) else {
        return false;
    };
    let Some(state_mountpoint) = state.mountpoint.as_deref() else {
        return false;
    };

    canonical_mountpoint(state_mountpoint) == canonical_mountpoint(mountpoint)
}

// Sibling log file for a given state file.
fn log_file_for_state(state_file: &Path) -> PathBuf {
    state_file.with_extension("log")
}

// Re-export the OS probe under the daemon's local name for readability.
fn mountpoint_is_mounted(mountpoint: &Path) -> Option<bool> {
    os::mountpoint_is_mounted(mountpoint)
}

// Foreground daemons exit on Ctrl-C; non-unix has no signal so it parks forever.
#[cfg(unix)]
async fn wait_for_foreground_shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(not(unix))]
async fn wait_for_foreground_shutdown() {
    std::future::pending::<()>().await;
}

// Background daemons stay alive until SIGTERM/SIGKILL terminates the process.
async fn wait_for_daemon_shutdown() {
    std::future::pending::<()>().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // A live pid whose mountpoint is definitely not mounted is inactive.
    #[test]
    fn live_pid_without_mountpoint_is_not_active() {
        let mountpoint = env::temp_dir().join(format!(
            "uc-inactive-mount-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&mountpoint).unwrap();

        let state = MountState {
            pid: Some(std::process::id()),
            mountpoint: Some(mountpoint.clone()),
        };

        // The probe definitively reports not-mounted for a plain temp dir.
        if mountpoint_is_mounted(&mountpoint) == Some(false) {
            assert!(!mount_state_is_active(&state, &mountpoint));
        }

        let _ = fs::remove_dir_all(mountpoint);
    }

    #[test]
    fn state_file_lookup_includes_legacy_hash_with_matching_mountpoint() {
        let root = env::temp_dir().join(format!(
            "uc-state-lookup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state_dir = root.join("state");
        let mountpoint = root.join("ctx");
        fs::create_dir_all(&state_dir).unwrap();
        fs::create_dir_all(&mountpoint).unwrap();

        let legacy_state = state_dir.join("legacy.json");
        let unrelated_state = state_dir.join("unrelated.json");
        fs::write(
            &legacy_state,
            json!({
                "pid": 123,
                "mountpoint": &mountpoint,
                "port": 11111,
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            &unrelated_state,
            json!({
                "pid": 456,
                "mountpoint": root.join("other"),
                "port": 11112,
            })
            .to_string(),
        )
        .unwrap();

        let files = state_files_for_mountpoint_in_dir(&mountpoint, &state_dir);

        assert!(files.contains(&state_file_for_mountpoint_in_dir(&mountpoint, &state_dir)));
        assert!(files.contains(&legacy_state));
        assert!(!files.contains(&unrelated_state));

        let _ = fs::remove_dir_all(root);
    }

    // NEW#3: a live, matching daemon must keep its state/log files after cleanup.
    #[test]
    fn cleanup_keeps_files_for_live_matching_daemon() {
        let root = env::temp_dir().join(format!(
            "uc-cleanup-live-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mountpoint = root.join("ctx");
        fs::create_dir_all(&mountpoint).unwrap();
        let state_file = root.join("state.json");
        let log_file = root.join("state.log");
        fs::write(&state_file, "{}").unwrap();
        fs::write(&log_file, "log").unwrap();

        // Our own pid is alive; the temp mountpoint is not mounted, but the command will
        // not match our process, so the daemon is inconclusive and files must survive.
        let state = MountState {
            pid: Some(std::process::id()),
            mountpoint: Some(mountpoint.clone()),
        };
        cleanup_mount_state(&state_file, &log_file, Some(&state), &mountpoint);

        if mountpoint_is_mounted(&mountpoint) == Some(false) {
            assert!(state_file.exists());
            assert!(log_file.exists());
        }

        let _ = fs::remove_dir_all(root);
    }

    // A dead pid's files are always stale and get removed.
    #[test]
    fn cleanup_removes_files_for_dead_daemon() {
        let root = env::temp_dir().join(format!(
            "uc-cleanup-dead-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let state_file = root.join("state.json");
        let log_file = root.join("state.log");
        fs::write(&state_file, "{}").unwrap();
        fs::write(&log_file, "log").unwrap();

        // A large positive pid that is almost certainly not a live process; our probe
        // must report it dead (and stay positive as i32 so it is not the "all procs" group).
        let dead_pid = 0x7FFF_FFF0;
        let state = MountState {
            pid: Some(dead_pid),
            mountpoint: Some(root.join("ctx")),
        };
        // Only assert removal when the probe confirms the pid really is gone.
        if !os::process_running(dead_pid) {
            cleanup_mount_state(&state_file, &log_file, Some(&state), &root.join("ctx"));
            assert!(!state_file.exists());
            assert!(!log_file.exists());
        }

        let _ = fs::remove_dir_all(root);
    }
}
