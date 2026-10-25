//! Local file primitives for session logs. Writes never clobber a file an agent may own:
//! new files are linked into place only if absent, appends go through O_APPEND, and whole-file
//! replacements keep the previous content in trash.

use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::hash;

/// Bytes `[start, end)` of a file (short if the file is shorter).
pub fn read_range(path: &Path, start: u64, end: u64) -> Result<Vec<u8>> {
    let mut f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let size = f.metadata()?.len();
    let end = end.min(size);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(end.saturating_sub(start) as usize);
    f.take(end.saturating_sub(start)).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Length of the complete-lines prefix (up to and including the last '\n').
pub fn complete_len(data: &[u8]) -> usize {
    data.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1)
}

/// Does the file still have the expected tail fingerprint at `len`?
pub fn tail_ok(path: &Path, len: u64, want: &str) -> bool {
    hash::tail_fp_file(path, len).is_ok_and(|fp| fp == want)
}

/// (size, mtime_ns) of a regular file.
pub fn fp(path: &Path) -> Option<(u64, i128)> {
    let m = std::fs::metadata(path).ok()?;
    m.is_file().then(|| {
        (
            m.len(),
            m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128,
        )
    })
}

/// Cut a file back to `len` bytes (same inode).
pub fn truncate(path: &Path, len: u64) -> Result<()> {
    let f = OpenOptions::new().write(true).open(path)?;
    f.set_len(len)?;
    f.sync_data()?;
    Ok(())
}

/// A fresh `.uc-tmp-*` path next to `target` (parents created); agent drivers never classify it.
pub fn temp_path_beside(target: &Path) -> Result<PathBuf> {
    temp_beside(target)
}

fn temp_beside(target: &Path) -> Result<PathBuf> {
    let dir = target.parent().context("target has no parent")?;
    std::fs::create_dir_all(dir).with_context(|| format!("mkdir {}", dir.display()))?;
    let rand = uuid::Uuid::new_v4().simple().to_string();
    Ok(dir.join(format!(".uc-tmp-{}", &rand[..12])))
}

fn write_temp(target: &Path, data: &[u8], mtime_ms: Option<i64>) -> Result<PathBuf> {
    let tmp = temp_beside(target)?;
    let res = (|| -> Result<()> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        if let Some(ms) = mtime_ms {
            f.set_modified(UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64))?;
        }
        Ok(())
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.context(format!("writing temp file for {}", target.display())));
    }
    Ok(tmp)
}

/// Create `target` with `data` atomically, only if it does not exist. Ok(false) if it does.
pub fn write_new(target: &Path, data: &[u8], mtime_ms: Option<i64>) -> Result<bool> {
    let tmp = write_temp(target, data, mtime_ms)?;
    let r = std::fs::hard_link(&tmp, target);
    let _ = std::fs::remove_file(&tmp);
    match r {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e).with_context(|| format!("placing {}", target.display())),
    }
}

/// Replace `target` with `data` (temp + rename). Caller has verified nobody is writing it.
pub fn replace(target: &Path, data: &[u8], mtime_ms: Option<i64>) -> Result<()> {
    let tmp = write_temp(target, data, mtime_ms)?;
    std::fs::rename(&tmp, target).with_context(|| format!("replacing {}", target.display()))
}

/// Append complete lines; the file must exist.
pub fn append(target: &Path, data: &[u8]) -> Result<()> {
    let mut f = OpenOptions::new()
        .append(true)
        .open(target)
        .with_context(|| format!("open {} for append", target.display()))?;
    f.write_all(data)?;
    f.sync_data()?;
    Ok(())
}

pub fn set_mtime(path: &Path, ms: i64) -> Result<()> {
    let f = OpenOptions::new().write(true).open(path)?;
    f.set_modified(UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64))?;
    Ok(())
}

fn trash_dest(trash_root: &Path, abs: &Path) -> PathBuf {
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let flat: String = abs
        .to_string_lossy()
        .trim_start_matches('/')
        .replace('/', "%");
    let stamp = chrono::Local::now().format("%H%M%S%.3f").to_string();
    trash_root.join(day).join(format!("{stamp} {flat}"))
}

/// Move a file into `trash_root` (copy + remove across filesystems).
pub fn move_to_trash(trash_root: &Path, abs: &Path) -> Result<PathBuf> {
    let dest = trash_dest(trash_root, abs);
    std::fs::create_dir_all(dest.parent().context("trash dest")?)?;
    if std::fs::rename(abs, &dest).is_err() {
        std::fs::copy(abs, &dest).with_context(|| format!("copy {} to trash", abs.display()))?;
        std::fs::remove_file(abs)?;
    }
    Ok(dest)
}

/// Keep a copy of a file in trash (the original stays).
pub fn copy_to_trash(trash_root: &Path, abs: &Path) -> Result<PathBuf> {
    let dest = trash_dest(trash_root, abs);
    std::fs::create_dir_all(dest.parent().context("trash dest")?)?;
    std::fs::copy(abs, &dest).with_context(|| format!("copy {} to trash", abs.display()))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_new_never_clobbers() {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let t = dir.path().join("a/b.jsonl");
        assert!(write_new(&t, b"one\n", Some(1_000_000)).unwrap());
        assert!(!write_new(&t, b"two\n", None).unwrap());
        assert_eq!(std::fs::read(&t).unwrap(), b"one\n");
        append(&t, b"x\n").unwrap();
        assert_eq!(read_range(&t, 4, 100).unwrap(), b"x\n");
        assert_eq!(complete_len(b"a\nb"), 2);
        assert_eq!(complete_len(b"ab"), 0);
        let leftovers: Vec<_> = std::fs::read_dir(t.parent().unwrap())
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(leftovers.len(), 1, "no temp files left behind");
        let moved = move_to_trash(&dir.path().join("trash"), &t).unwrap();
        assert!(!t.exists() && moved.exists());
    }
}
