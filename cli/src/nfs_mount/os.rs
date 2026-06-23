//! Per-OS mount/unmount shellouts and process/mount-table probes.
//!
//! Probes return `Option<bool>`: `Some(_)` is a definitive answer, `None` means
//! the probe itself failed and the caller must stay conservative (NEW#5/6/7).

use std::path::Path;
use std::process::Command;
use ultracontext::{ErrorCode, UcError};

use super::super::mount_utils::io_error;
use super::daemon::MountState;

// Detach a spawned child into its own session so it survives the parent.
#[cfg(unix)]
pub fn detach_command(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
pub fn detach_command(_command: &mut Command) {}

// Liveness probe: ESRCH means dead; EPERM means alive but not ours (treat as running).
#[cfg(unix)]
pub fn process_running(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn process_running(_pid: u32) -> bool {
    false
}

// Mount-table probe (Linux): None when /proc is unreadable so callers stay conservative.
#[cfg(target_os = "linux")]
pub fn mountpoint_is_mounted(mountpoint: &Path) -> Option<bool> {
    let mountpoint = super::daemon::canonical_mountpoint(mountpoint);
    let data = std::fs::read_to_string("/proc/self/mountinfo").ok()?;

    Some(data.lines().any(|line| {
        let fields: Vec<&str> = line.split(' ').collect();
        fields
            .get(4)
            .map(|field| decode_mountinfo_path(field) == mountpoint.to_string_lossy())
            .unwrap_or(false)
    }))
}

#[cfg(target_os = "linux")]
fn decode_mountinfo_path(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

// Mount-table probe (macOS): None when `mount` cannot be run.
#[cfg(target_os = "macos")]
pub fn mountpoint_is_mounted(mountpoint: &Path) -> Option<bool> {
    let mountpoint = super::daemon::canonical_mountpoint(mountpoint);
    let output = Command::new("/sbin/mount")
        .output()
        .or_else(|_| Command::new("mount").output())
        .ok()?;

    Some(mount_output_has_mountpoint(
        &String::from_utf8_lossy(&output.stdout),
        &mountpoint,
    ))
}

// Exact mountpoint match against `<src> on <mountpoint> (<opts>)` lines (NEW#8).
#[cfg(target_os = "macos")]
pub fn mount_output_has_mountpoint(output: &str, mountpoint: &Path) -> bool {
    let needle = format!(" on {} ", mountpoint.display());
    output.lines().any(|line| line.contains(&needle))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn mountpoint_is_mounted(_mountpoint: &Path) -> Option<bool> {
    None
}

// Command-line probe (Linux): None when the process cmdline cannot be read.
#[cfg(target_os = "linux")]
pub fn process_matches_mount_state(
    pid: u32,
    state: &MountState,
    state_file: &Path,
    mountpoint: &Path,
) -> Option<bool> {
    let path = std::path::PathBuf::from(format!("/proc/{pid}/cmdline"));
    let data = std::fs::read(path).ok()?;
    let command = data
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part))
        .collect::<Vec<_>>()
        .join(" ");
    Some(mount_command_matches_state(
        &command, state, state_file, mountpoint,
    ))
}

// Command-line probe (macOS): None when `ps` cannot be run.
#[cfg(target_os = "macos")]
pub fn process_matches_mount_state(
    pid: u32,
    state: &MountState,
    state_file: &Path,
    mountpoint: &Path,
) -> Option<bool> {
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;

    Some(mount_command_matches_state(
        &String::from_utf8_lossy(&output.stdout),
        state,
        state_file,
        mountpoint,
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_matches_mount_state(
    _pid: u32,
    _state: &MountState,
    _state_file: &Path,
    _mountpoint: &Path,
) -> Option<bool> {
    None
}

// Match a process command against our own mount invocation for this state/mountpoint.
pub fn mount_command_matches_state(
    command: &str,
    state: &MountState,
    state_file: &Path,
    mountpoint: &Path,
) -> bool {
    if command.trim().is_empty() {
        return false;
    }

    let command = command.replace('\\', "/");
    let state_file = state_file.to_string_lossy().replace('\\', "/");
    let mountpoint = state
        .mountpoint
        .as_deref()
        .unwrap_or(mountpoint)
        .to_string_lossy()
        .replace('\\', "/");

    // Require the binary, the mount subcommand, foreground, and an exact state/mountpoint arg.
    (command.starts_with("uc ")
        || command.contains("/uc ")
        || command.contains(" uc ")
        || command.starts_with("ultracontext ")
        || command.contains("/ultracontext ")
        || command.contains(" ultracontext "))
        && command.contains(" mount ")
        && command.contains("--foreground")
        && (command_has_arg(&command, &state_file) || command_has_arg(&command, &mountpoint))
}

// Whole-argument match: the path must appear delimited by spaces or string ends (NEW#8).
fn command_has_arg(command: &str, arg: &str) -> bool {
    if arg.is_empty() {
        return false;
    }
    command.split(' ').any(|token| token == arg)
}

// Best-effort termination of a background daemon.
#[cfg(unix)]
pub fn terminate_process(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
pub fn terminate_process(_pid: u32) {}

// Caller uid/gid for fattr ownership.
pub fn current_uid() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

pub fn current_gid() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getgid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

// Mount the in-process NFS export at `mountpoint` (macOS).
#[cfg(target_os = "macos")]
pub fn mount_nfs(port: u16, mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("/sbin/mount_nfs")
        .args([
            "-o",
            &format!("locallocks,vers=3,tcp,port={port},mountport={port},soft,timeo=10,retrans=2"),
            "127.0.0.1:/",
            &mountpoint.to_string_lossy(),
        ])
        .output()
        .map_err(io_error)?;

    if output.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::InvalidInput,
            format!(
                "Failed to mount NFS: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ))
    }
}

// Mount the in-process NFS export at `mountpoint` (Linux).
#[cfg(target_os = "linux")]
pub fn mount_nfs(port: u16, mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("mount")
        .args([
            "-t",
            "nfs",
            "-o",
            &format!("vers=3,tcp,port={port},mountport={port},nolock,soft,timeo=10,retrans=2"),
            "127.0.0.1:/",
            &mountpoint.to_string_lossy(),
        ])
        .output()
        .map_err(io_error)?;

    if output.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::InvalidInput,
            format!(
                "Failed to mount NFS: {}. Make sure NFS client tools are installed.",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn mount_nfs(_port: u16, _mountpoint: &Path) -> Result<(), UcError> {
    Err(UcError::new(
        ErrorCode::InvalidInput,
        "NFS mount is currently implemented for macOS and Linux",
    ))
}

// Unmount the export at `mountpoint`, forcing if a clean unmount fails (macOS).
#[cfg(target_os = "macos")]
pub fn unmount_nfs(mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("/sbin/umount")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if output.status.success() {
        return Ok(());
    }

    let forced = Command::new("/sbin/umount")
        .arg("-f")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if forced.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::Internal,
            format!(
                "Failed to unmount NFS: {}",
                String::from_utf8_lossy(&forced.stderr).trim()
            ),
        ))
    }
}

// Unmount the export at `mountpoint`, falling back to a lazy unmount (Linux).
#[cfg(target_os = "linux")]
pub fn unmount_nfs(mountpoint: &Path) -> Result<(), UcError> {
    let output = Command::new("umount")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if output.status.success() {
        return Ok(());
    }

    let lazy = Command::new("umount")
        .arg("-l")
        .arg(mountpoint)
        .output()
        .map_err(io_error)?;
    if lazy.status.success() {
        Ok(())
    } else {
        Err(UcError::new(
            ErrorCode::Internal,
            format!(
                "Failed to unmount NFS: {}",
                String::from_utf8_lossy(&lazy.stderr).trim()
            ),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn unmount_nfs(_mountpoint: &Path) -> Result<(), UcError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_command_must_match_state_file_or_mountpoint() {
        let state_file = Path::new("/tmp/ultracontext-mounts/state.json");
        let mountpoint = Path::new("/tmp/uctx/ctx");
        let state = MountState {
            pid: Some(123),
            mountpoint: Some(mountpoint.to_path_buf()),
        };

        assert!(mount_command_matches_state(
            "uc --db /tmp/db mount /tmp/uctx/ctx --foreground --mount-state-file /tmp/ultracontext-mounts/state.json",
            &state,
            state_file,
            mountpoint,
        ));
        assert!(mount_command_matches_state(
            "/Users/me/.cargo/bin/uc --db /tmp/db mount /tmp/uctx/ctx --foreground --mount-state-file /tmp/other.json",
            &state,
            state_file,
            mountpoint,
        ));
        assert!(!mount_command_matches_state(
            "uc --db /tmp/db mount /tmp/other --foreground --mount-state-file /tmp/other.json",
            &state,
            state_file,
            mountpoint,
        ));
    }

    // NEW#8: a mountpoint that is only a substring of the real arg must not match.
    #[test]
    fn mount_command_rejects_substring_mountpoint() {
        let state_file = Path::new("/tmp/ultracontext-mounts/state.json");
        let mountpoint = Path::new("/tmp/uctx/ctx");
        let state = MountState {
            pid: Some(123),
            mountpoint: Some(mountpoint.to_path_buf()),
        };

        assert!(!mount_command_matches_state(
            "uc --db /tmp/db mount /tmp/uctx/ctx-child --foreground --mount-state-file /tmp/other.json",
            &state,
            state_file,
            mountpoint,
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mount_output_matches_exact_mountpoint() {
        let output = "\
127.0.0.1:/ on /tmp/uctx/ctx (nfs, nodev, nosuid)\n\
127.0.0.1:/ on /tmp/uctx/ctx-child (nfs, nodev, nosuid)\n";

        assert!(mount_output_has_mountpoint(
            output,
            Path::new("/tmp/uctx/ctx")
        ));
        assert!(!mount_output_has_mountpoint(output, Path::new("/tmp/uctx")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn decodes_mountinfo_escaped_path() {
        assert_eq!(
            decode_mountinfo_path("/tmp/with\\040space"),
            "/tmp/with space"
        );
        assert_eq!(
            decode_mountinfo_path("/tmp/backslash\\134x"),
            "/tmp/backslash\\x"
        );
    }
}
