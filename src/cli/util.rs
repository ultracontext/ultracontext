//! Pure helpers: paths, prompts.

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

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

/// `a == b` or `a` inside `b`, comparing literal and symlink-resolved forms.
pub fn is_within(a: &Path, b: &Path) -> bool {
    let ca = canonicalize_lenient(a);
    let cb = canonicalize_lenient(b);
    a.starts_with(b) || ca.starts_with(&cb)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within() {
        assert!(is_within(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(is_within(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!is_within(Path::new("/a/bc"), Path::new("/a/b")));
    }
}
