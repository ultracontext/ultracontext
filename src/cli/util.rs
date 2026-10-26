//! Pure helpers: durations, local path -> (space, rel), shell quoting, prompts.

use anyhow::Result;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use super::output::CliError;
use crate::config::SpaceConfig;
use crate::paths;

/// "30m", "2h", "1d", "1w", "45s" (also "90" = seconds).
pub fn parse_since(s: &str) -> Result<Duration, String> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: u64 = num
        .parse()
        .map_err(|_| format!("invalid duration '{s}' (use e.g. 30m, 2h, 1d, 1w)"))?;
    let mult = match unit.trim() {
        "" | "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        "w" => 7 * 86_400,
        _ => return Err(format!("invalid duration '{s}' (use e.g. 30m, 2h, 1d, 1w)")),
    };
    n.checked_mul(mult)
        .map(Duration::from_secs)
        .ok_or_else(|| format!("duration '{s}' is too large"))
}

/// clap value parser for `--since`: validates, keeps the text.
pub fn since_arg(s: &str) -> Result<String, String> {
    parse_since(s).map(|_| s.to_string())
}

/// Expand `~`, make absolute against `cwd`, and resolve `.`/`..` lexically.
pub fn absolutize(input: &str, cwd: &Path) -> PathBuf {
    let p = paths::expand_tilde(input);
    let p = if p.is_absolute() { p } else { cwd.join(p) };
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalize the longest existing ancestor and re-append the rest (works for deleted files).
pub fn canonicalize_lenient(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest = Vec::new();
    loop {
        if let Ok(c) = existing.canonicalize() {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (
            existing.file_name().map(|f| f.to_os_string()),
            existing.parent(),
        ) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// A local path located inside a synced space.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub space: String,
    /// canonical relative path; None = the space root itself
    pub rel: Option<String>,
    pub abs: PathBuf,
}

/// Resolve a user-supplied local path to (space, rel) using the configured spaces (longest
/// matching root wins). Both the literal and the symlink-resolved forms are tried.
pub fn locate(spaces: &[SpaceConfig], input: &str, cwd: &Path) -> Result<Located, CliError> {
    let abs = absolutize(input, cwd);
    let candidates = [abs.clone(), canonicalize_lenient(&abs)];
    // fewest components left after the root = the innermost space
    let mut best: Option<(usize, Located)> = None;
    for s in spaces {
        let root = s.local_path();
        for r in [root.clone(), canonicalize_lenient(&root)] {
            for cand in &candidates {
                if !cand.starts_with(&r) {
                    continue;
                }
                let remainder = cand.components().count() - r.components().count();
                if best.as_ref().is_some_and(|(d, _)| *d <= remainder) {
                    continue;
                }
                let rel = if cand == &r {
                    None
                } else {
                    match paths::rel_canonical(&r, cand) {
                        Some(rel) => Some(rel),
                        None => continue,
                    }
                };
                best = Some((
                    remainder,
                    Located {
                        space: s.name.clone(),
                        rel,
                        abs: abs.clone(),
                    },
                ));
            }
        }
    }
    best.map(|(_, l)| l).ok_or_else(|| {
        let synced: Vec<String> = spaces.iter().map(|s| s.path.clone()).collect();
        let hint = if synced.is_empty() {
            "no folders are synced on this machine yet: uc add <dir>".to_string()
        } else {
            format!("synced folders here: {}", synced.join(", "))
        };
        CliError::new(
            "not_found",
            format!("{} is not inside a synced folder", paths::tilde(&abs)),
        )
        .hint(hint)
    })
}

/// `a == b` or `a` inside `b`, comparing literal and symlink-resolved forms.
pub fn is_within(a: &Path, b: &Path) -> bool {
    let ca = canonicalize_lenient(a);
    let cb = canonicalize_lenient(b);
    a.starts_with(b) || ca.starts_with(&cb)
}

/// Default space name for a folder: basename, lowercased, whitespace -> '-'.
pub fn default_space_name(dir: &Path) -> String {
    let base = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    base.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// Can we ask the user questions? (never in --json mode)
pub fn interactive(json: bool) -> bool {
    !json && std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

/// Ask on stderr, read one line from stdin (trimmed). None on EOF.
pub fn prompt(question: &str) -> Option<String> {
    let mut err = std::io::stderr().lock();
    let _ = write!(err, "{question}");
    let _ = err.flush();
    drop(err);
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line.trim().to_string()),
    }
}

/// Yes/no question; empty answer = `default`.
pub fn confirm(question: &str, default: bool) -> bool {
    let suffix = if default { "[Y/n]" } else { "[y/N]" };
    match prompt(&format!("{question} {suffix} ")) {
        Some(a) if a.is_empty() => default,
        Some(a) => matches!(a.to_lowercase().as_str(), "y" | "yes"),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_units() {
        assert_eq!(parse_since("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_since("2h").unwrap(), Duration::from_secs(7200));
        assert_eq!(parse_since("1d").unwrap(), Duration::from_secs(86_400));
        assert_eq!(parse_since("1w").unwrap(), Duration::from_secs(604_800));
        assert_eq!(parse_since("45s").unwrap(), Duration::from_secs(45));
        assert_eq!(parse_since("90").unwrap(), Duration::from_secs(90));
        for bad in ["", "m", "1y", "-1h", "1.5h", "h1", "99999999999999999999w"] {
            assert!(parse_since(bad).is_err(), "{bad:?}");
        }
        assert_eq!(since_arg("2h").unwrap(), "2h");
    }

    #[test]
    fn absolutize_lexically() {
        let cwd = Path::new("/w/proj");
        assert_eq!(absolutize("a/../b/./c", cwd), PathBuf::from("/w/proj/b/c"));
        assert_eq!(absolutize("../x", cwd), PathBuf::from("/w/x"));
        assert_eq!(absolutize("/abs/p", cwd), PathBuf::from("/abs/p"));
        assert_eq!(absolutize("~/Code", cwd), paths::home().join("Code"));
    }

    fn space(name: &str, path: &Path) -> SpaceConfig {
        SpaceConfig {
            name: name.into(),
            path: path.to_string_lossy().into(),
        }
    }

    #[test]
    fn locate_longest_match_and_deleted_files() {
        let tmp = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        // /tmp is a symlink on macOS: use the literal (non-canonical) form on purpose
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join("code/proj/src")).unwrap();
        std::fs::create_dir_all(root.join("code/vendor")).unwrap();
        let spaces = vec![
            space("code", &root.join("code")),
            space("vendor", &root.join("code/vendor")),
        ];
        let cwd = root.join("code/proj");

        let l = locate(&spaces, "src/main.rs", &cwd).unwrap();
        assert_eq!(
            (l.space.as_str(), l.rel.as_deref()),
            ("code", Some("proj/src/main.rs"))
        );
        let l = locate(&spaces, "../vendor/lib.rs", &cwd).unwrap();
        assert_eq!(
            (l.space.as_str(), l.rel.as_deref()),
            ("vendor", Some("lib.rs"))
        );
        let l = locate(&spaces, ".", &root.join("code")).unwrap();
        assert_eq!((l.space.as_str(), l.rel), ("code", None));
        // via the resolved path too (cwd as the OS reports it)
        let canon_cwd = cwd.canonicalize().unwrap();
        let l = locate(&spaces, "gone/deleted.txt", &canon_cwd).unwrap();
        assert_eq!(l.rel.as_deref(), Some("proj/gone/deleted.txt"));
        // NFD input is normalized to NFC
        let l = locate(&spaces, "cafe\u{301}.txt", &cwd).unwrap();
        assert_eq!(l.rel.as_deref(), Some("proj/caf\u{e9}.txt"));

        let err = locate(&spaces, "/etc/hosts", &cwd).unwrap_err();
        assert_eq!(err.code, "not_found");
        assert!(err.hint.unwrap().contains("synced folders"));
        assert!(locate(&[], "x", &cwd)
            .unwrap_err()
            .hint
            .unwrap()
            .contains("uc add"));
    }

    #[test]
    fn within() {
        assert!(is_within(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(is_within(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!is_within(Path::new("/a/bc"), Path::new("/a/b")));
    }

    #[test]
    fn names() {
        assert_eq!(default_space_name(Path::new("/x/My Project")), "my-project");
        assert_eq!(default_space_name(Path::new("/x/Code")), "code");
    }
}
