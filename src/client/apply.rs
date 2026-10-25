//! Safe local writes (DESIGN §5.3, §5.4). Owner: client-core agent. Also used by logsync.

use anyhow::{bail, Context, Result};
use chrono::TimeZone;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::db::LocalFp;
use super::scan::{self, Stat};

/// Atomically place `src_tmp` (already in the target's directory) at `target`, provided the
/// target still matches `expect` (None = must not exist). Sets exec bit and mtime first.
/// Returns the new fingerprint, or Ok(None) if the precondition failed (caller treats as conflict).
/// `src_tmp` is removed whenever it does not end up at `target`.
pub fn atomic_replace(
    src_tmp: &Path,
    target: &Path,
    expect: Option<&LocalFp>,
    exec: bool,
    mtime_ms: Option<i64>,
) -> Result<Option<LocalFp>> {
    let res = replace_inner(src_tmp, target, expect, exec, mtime_ms);
    if !matches!(res, Ok(Some(_))) {
        let _ = fs::remove_file(src_tmp);
    }
    res
}

fn replace_inner(
    src_tmp: &Path,
    target: &Path,
    expect: Option<&LocalFp>,
    exec: bool,
    mtime_ms: Option<i64>,
) -> Result<Option<LocalFp>> {
    let mode = target_mode(target, exec);
    let f = fs::OpenOptions::new()
        .write(true)
        .open(src_tmp)
        .with_context(|| format!("opening {}", src_tmp.display()))?;
    f.set_permissions(fs::Permissions::from_mode(mode))?;
    if let Some(ms) = mtime_ms {
        f.set_modified(system_time(ms))?;
    }
    f.sync_all().context("fsync temp file")?;
    let fp = fp_of(&f.metadata()?);
    drop(f);

    if !precondition_holds(target, expect)? {
        return Ok(None);
    }
    fs::rename(src_tmp, target)
        .with_context(|| format!("renaming into {}", target.display()))?;
    fsync_parent(target);
    Ok(Some(fp))
}

/// Same as `atomic_replace`, for a symlink pointing at `link_target` (never followed).
pub fn atomic_symlink(target: &Path, link_target: &str, expect: Option<&LocalFp>) -> Result<Option<LocalFp>> {
    let tmp = temp_beside(target)?;
    std::os::unix::fs::symlink(link_target, &tmp)
        .with_context(|| format!("creating symlink {}", tmp.display()))?;
    let res = (|| -> Result<Option<LocalFp>> {
        let fp = fp_of(&fs::symlink_metadata(&tmp)?);
        if !precondition_holds(target, expect)? {
            return Ok(None);
        }
        fs::rename(&tmp, target).with_context(|| format!("renaming into {}", target.display()))?;
        fsync_parent(target);
        Ok(Some(fp))
    })();
    if !matches!(res, Ok(Some(_))) {
        let _ = fs::remove_file(&tmp);
    }
    res
}

/// Does `target` still look exactly like `expect` (None = absent)?
pub fn precondition_holds(target: &Path, expect: Option<&LocalFp>) -> Result<bool> {
    let now = scan::stat(target).with_context(|| format!("stat {}", target.display()))?;
    Ok(match (expect, now) {
        (None, Stat::Missing) => true,
        (Some(want), Stat::Entry(_, got)) => same_fp(want, &got),
        _ => false,
    })
}

/// Fingerprint equality used for "unchanged since we last agreed".
pub fn same_fp(a: &LocalFp, b: &LocalFp) -> bool {
    a.size == b.size && a.mtime_ns == b.mtime_ns && a.ino == b.ino && a.exec == b.exec
}

/// Keep existing read/write bits when replacing; only the exec bit is synced (DESIGN §5.6).
fn target_mode(target: &Path, exec: bool) -> u32 {
    let base = match fs::symlink_metadata(target) {
        Ok(m) if m.file_type().is_file() => m.mode() & 0o777,
        _ => 0o644,
    };
    if exec {
        base | ((base & 0o444) >> 2)
    } else {
        base & !0o111
    }
}

fn fp_of(m: &fs::Metadata) -> LocalFp {
    LocalFp {
        size: m.len(),
        mtime_ns: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128,
        ino: m.ino(),
        exec: m.file_type().is_file() && m.mode() & 0o111 != 0,
    }
}

fn system_time(ms: i64) -> SystemTime {
    if ms >= 0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH
            .checked_sub(Duration::from_millis(ms.unsigned_abs()))
            .unwrap_or(UNIX_EPOCH)
    }
}

fn fsync_parent(p: &Path) {
    if let Some(dir) = p.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
}

/// A fresh temp path next to `target` (`.uc-tmp-<rand>`), creating parent dirs.
pub fn temp_beside(target: &Path) -> Result<PathBuf> {
    let dir = target
        .parent()
        .with_context(|| format!("{} has no parent directory", target.display()))?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let rand = uuid::Uuid::new_v4().simple().to_string();
    Ok(dir.join(format!(".uc-tmp-{}", &rand[..16])))
}

/// Move a file to `$UC_HOME/trash/<date>/<machine-relative path>` (keeps it recoverable).
/// The machine-relative path is home-relative when under `$HOME`. Never overwrites: an existing
/// trash entry gets a ` (n)` suffix.
pub fn move_to_trash(trash_root: &Path, abs: &Path) -> Result<PathBuf> {
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let home = crate::paths::home();
    let rel = abs
        .strip_prefix(&home)
        .ok()
        .filter(|r| !r.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| abs.components().skip(1).collect());
    let mut dest = trash_root.join(&day).join(&rel);
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let mut n = 2;
    while fs::symlink_metadata(&dest).is_ok() {
        dest.set_file_name(suffixed(&name, &format!(" ({n})")));
        n += 1;
    }
    match fs::rename(abs, &dest) {
        Ok(()) => {}
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            copy_preserving(abs, &dest)?;
            fs::remove_file(abs).with_context(|| format!("removing {}", abs.display()))?;
        }
        Err(e) => {
            return Err(e).with_context(|| format!("moving {} to trash", abs.display()));
        }
    }
    fsync_parent(abs);
    Ok(dest)
}

/// Delete trash day-folders older than `keep_days` (DESIGN §2: trash is kept 30 days).
/// Returns how many day-folders were removed.
pub fn purge_trash(trash_root: &Path, keep_days: i64) -> Result<usize> {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(keep_days)).date_naive();
    let rd = match fs::read_dir(trash_root) {
        Ok(rd) => rd,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e).with_context(|| format!("reading {}", trash_root.display())),
    };
    let mut removed = 0;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let Ok(day) = chrono::NaiveDate::parse_from_str(&name, "%Y-%m-%d") else { continue };
        if day < cutoff && ent.file_type().is_ok_and(|t| t.is_dir()) {
            fs::remove_dir_all(ent.path()).with_context(|| format!("purging {}", ent.path().display()))?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn copy_preserving(src: &Path, dest: &Path) -> Result<()> {
    let m = fs::symlink_metadata(src)?;
    if m.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(src)?, dest)?;
        return Ok(());
    }
    fs::copy(src, dest).with_context(|| format!("copying {} to trash", src.display()))?;
    if let Ok(t) = m.modified() {
        if let Ok(f) = fs::OpenOptions::new().write(true).open(dest) {
            let _ = f.set_modified(t);
        }
    }
    Ok(())
}

/// Split a file name into (stem, ext) the way conflict copies need it: dotfiles and names
/// without an extension keep the whole name as stem.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn suffixed(name: &str, suffix: &str) -> String {
    let (stem, ext) = split_ext(name);
    format!("{stem}{suffix}{ext}")
}

const CONFLICT_MARK: &str = ".conflict-";

/// Conflict copy name (DESIGN §5.4): `<name>.conflict-<machine>-<YYYYMMDD-HHMMSS>`. The suffix
/// goes after the whole file name, so a copy never matches language globs (`*.rs`, `test_*.py`),
/// never breaks a build, and is still a valid git ref name inside `.git/refs`.
pub fn conflict_name(rel: &str, machine_name: &str, at_ms: i64) -> String {
    let when = chrono::Local
        .timestamp_millis_opt(at_ms)
        .single()
        .unwrap_or_else(chrono::Local::now)
        .format("%Y%m%d-%H%M%S")
        .to_string();
    let machine: String = machine_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '-' })
        .collect();
    format!("{rel}{CONFLICT_MARK}{machine}-{when}")
}

/// Is this a conflict copy name? (`<name>.conflict-<machine>-<YYYYMMDD-HHMMSS>`)
pub fn is_conflict_name(rel: &str) -> bool {
    conflict_original(rel).is_some()
}

/// The path a conflict copy belongs to: `dir/notes.md.conflict-mac-20261025-141502` -> `dir/notes.md`.
pub fn conflict_original(rel: &str) -> Option<&str> {
    let i = rel.rfind(CONFLICT_MARK)?;
    let tail = rel[i + CONFLICT_MARK.len()..].as_bytes();
    // <machine>-YYYYMMDD-HHMMSS, machine non-empty
    let n = tail.len();
    if n < 17 || tail[n - 16] != b'-' || tail[n - 7] != b'-' {
        return None;
    }
    let digits = tail[n - 15..n - 7].iter().chain(&tail[n - 6..]).all(u8::is_ascii_digit);
    (digits && i > 0 && !rel[..i].ends_with('/')).then(|| &rel[..i])
}

/// Rename `abs` to a conflict copy beside it, never overwriting. Returns the new path.
pub fn rename_to_conflict(abs: &Path, machine_name: &str, at_ms: i64) -> Result<PathBuf> {
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .with_context(|| format!("bad file name {}", abs.display()))?;
    for bump in 0..100i64 {
        let cand = abs.with_file_name(conflict_name(name, machine_name, at_ms + bump * 1000));
        match fs::symlink_metadata(&cand) {
            Ok(_) => continue,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                fs::rename(abs, &cand)
                    .with_context(|| format!("renaming {} to conflict copy", abs.display()))?;
                fsync_parent(abs);
                return Ok(cand);
            }
            Err(e) => return Err(e.into()),
        }
    }
    bail!("no free conflict name for {}", abs.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("uc").tempdir_in("/tmp").unwrap()
    }

    #[test]
    fn conflict_names() {
        let at = chrono::Local
            .with_ymd_and_hms(2026, 10, 25, 14, 15, 2)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            conflict_name("dir/report.md", "mac", at),
            "dir/report.md.conflict-mac-20261025-141502"
        );
        assert_eq!(conflict_name("Makefile", "mac", at), "Makefile.conflict-mac-20261025-141502");
        assert_eq!(conflict_name("a/.env", "mac", at), "a/.env.conflict-mac-20261025-141502");
        assert_eq!(
            conflict_name("x.tar.gz", "lin/ux box", at),
            "x.tar.gz.conflict-lin-ux-box-20261025-141502"
        );
        assert_eq!(
            conflict_original("dir/report.md.conflict-mac-20261025-141502"),
            Some("dir/report.md")
        );
        assert_eq!(conflict_original("a.conflict-notes.md"), None);
        assert_eq!(conflict_original("dir/.conflict-mac-20261025-141502"), None);
        assert!(is_conflict_name(&conflict_name("a/b.txt", "m", at)));
        assert!(!is_conflict_name("a/b.txt"));
    }

    #[test]
    fn replace_checks_precondition() {
        let d = tmpdir();
        let target = d.path().join("sub/dir/f.txt");
        // absent target, expect None -> placed
        let tmp = temp_beside(&target).unwrap();
        assert!(tmp.file_name().unwrap().to_str().unwrap().starts_with(".uc-tmp-"));
        fs::write(&tmp, b"one").unwrap();
        let fp1 = atomic_replace(&tmp, &target, None, true, Some(1_700_000_000_123)).unwrap().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"one");
        assert!(fp1.exec);
        assert_eq!(fp1.mtime_ns, 1_700_000_000_123_000_000);
        assert_eq!(scan::fingerprint(&target).unwrap().1, fp1);
        assert!(!tmp.exists());

        // expect None but target exists -> precondition fails, tmp removed, target untouched
        let tmp = temp_beside(&target).unwrap();
        fs::write(&tmp, b"two").unwrap();
        assert!(atomic_replace(&tmp, &target, None, false, None).unwrap().is_none());
        assert!(!tmp.exists());
        assert_eq!(fs::read(&target).unwrap(), b"one");

        // matching fingerprint -> replaced, exec cleared
        let tmp = temp_beside(&target).unwrap();
        fs::write(&tmp, b"three").unwrap();
        let fp2 = atomic_replace(&tmp, &target, Some(&fp1), false, None).unwrap().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"three");
        assert!(!fp2.exec);
        assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o644);

        // local edit after we agreed (stale expect) -> refused
        fs::write(&target, b"local edit!").unwrap();
        let tmp = temp_beside(&target).unwrap();
        fs::write(&tmp, b"four").unwrap();
        assert!(atomic_replace(&tmp, &target, Some(&fp2), false, None).unwrap().is_none());
        assert_eq!(fs::read(&target).unwrap(), b"local edit!");
    }

    #[test]
    fn symlink_replace() {
        let d = tmpdir();
        let link = d.path().join("l");
        let fp = atomic_symlink(&link, "../somewhere", None).unwrap().unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), PathBuf::from("../somewhere"));
        assert!(atomic_symlink(&link, "other", None).unwrap().is_none());
        atomic_symlink(&link, "other", Some(&fp)).unwrap().unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), PathBuf::from("other"));
        let leftovers: Vec<_> = fs::read_dir(d.path()).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn trash_never_overwrites() {
        let d = tmpdir();
        let trash = d.path().join("trash");
        let f = d.path().join("x.txt");
        fs::write(&f, b"1").unwrap();
        let t1 = move_to_trash(&trash, &f).unwrap();
        fs::write(&f, b"2").unwrap();
        let t2 = move_to_trash(&trash, &f).unwrap();
        assert_ne!(t1, t2);
        assert!(t2.file_name().unwrap().to_str().unwrap().ends_with(" (2).txt"));
        assert_eq!(fs::read(&t1).unwrap(), b"1");
        assert_eq!(fs::read(&t2).unwrap(), b"2");
        assert!(!f.exists());
        assert!(t1.starts_with(&trash));
    }

    #[test]
    fn trash_purge_keeps_recent_days() {
        let d = tmpdir();
        let trash = d.path().join("trash");
        let f = d.path().join("x.txt");
        fs::write(&f, b"1").unwrap();
        move_to_trash(&trash, &f).unwrap();
        fs::create_dir_all(trash.join("2001-01-01/a")).unwrap();
        fs::create_dir_all(trash.join("not-a-date")).unwrap();
        assert_eq!(purge_trash(&trash, 30).unwrap(), 1);
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 2);
        assert_eq!(purge_trash(&d.path().join("missing"), 30).unwrap(), 0);
    }

    #[test]
    fn conflict_rename_in_place() {
        let d = tmpdir();
        let f = d.path().join("notes.md");
        fs::write(&f, b"mine").unwrap();
        let c = rename_to_conflict(&f, "mac", 0).unwrap();
        assert!(!f.exists());
        assert_eq!(c.parent(), f.parent());
        assert!(is_conflict_name(c.to_str().unwrap()));
        fs::write(&f, b"again").unwrap();
        let c2 = rename_to_conflict(&f, "mac", 0).unwrap();
        assert_ne!(c, c2);
    }
}
