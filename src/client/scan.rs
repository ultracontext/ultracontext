//! Folder scanning, ignore rules (DESIGN §5.5) and fingerprints. Owner: client-core agent.
//!
//! The walker and the single-path check (`is_ignored`, used for watcher events) share one
//! rule evaluation, so they always agree. Gitignore semantics come from the `ignore` crate's
//! matcher; the hierarchy walk is ours so `always_include` can rescue gitignored files.

use anyhow::{bail, Context, Result};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::{debug, warn};

use super::db::LocalFp;
use crate::paths;

/// Rule 1 of §5.5, matched against canonical relative paths. Never overridable.
const BUILTIN_ANY: &[&str] = &[
    "**/.DS_Store",
    "**/Thumbs.db",
    "**/.uc-tmp-*",
    "**/*.swp",
    "**/*.swo",
    "**/*~",
    "**/.#*",
    "**/.git/**/*.lock",
    "**/.git/gc.pid",
    "**/.git/objects/pack/tmp_*",
    "**/.git/objects/*/tmp_obj_*",
];
const BUILTIN_DIRS: &[&str] = &[
    "**/node_modules",
    "**/target",
    "**/.venv",
    "**/venv",
    "**/__pycache__",
    "**/.pytest_cache",
    "**/.mypy_cache",
    "**/.ruff_cache",
    "**/.next",
    "**/.turbo",
    "**/.parcel-cache",
    "**/.gradle",
    "**/.terraform",
    "**/.git/fsmonitor--daemon",
];

pub const UCIGNORE: &str = ".ucignore";
pub const GITIGNORE: &str = ".gitignore";

#[derive(Default)]
struct DirRules {
    uc: Option<Gitignore>,
    git: Option<Gitignore>,
    /// a repo boundary: .gitignore files above it do not apply below it
    has_git: bool,
}

/// Ignore matcher for one space root.
pub struct Ignore {
    root: PathBuf,
    respect_gitignore: bool,
    builtin_any: GlobSet,
    builtin_dirs: GlobSet,
    include_names: GlobSet,
    include_paths: GlobSet,
    /// directories inside the root that are never synced (uc's own state, agent roots)
    excluded: Vec<PathBuf>,
    cache: Mutex<HashMap<PathBuf, Arc<DirRules>>>,
}

fn globset(patterns: &[&str]) -> Result<GlobSet> {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        b.add(
            GlobBuilder::new(p)
                .literal_separator(true)
                .build()
                .with_context(|| format!("bad glob {p:?}"))?,
        );
    }
    Ok(b.build()?)
}

impl Ignore {
    /// Build from built-ins + .ucignore + (.gitignore if respect_gitignore) + always_include.
    pub fn new(root: &Path, respect_gitignore: bool, always_include: &[String]) -> Result<Ignore> {
        let (paths_pats, names): (Vec<&str>, Vec<&str>) = always_include
            .iter()
            .map(|s| s.trim().trim_start_matches('/').trim_end_matches('/'))
            .filter(|s| !s.is_empty())
            .partition(|s| s.contains('/'));
        Ok(Ignore {
            root: root.to_path_buf(),
            respect_gitignore,
            builtin_any: globset(BUILTIN_ANY)?,
            builtin_dirs: globset(BUILTIN_DIRS)?,
            include_names: globset(&names)?,
            include_paths: globset(&paths_pats)?,
            excluded: Vec::new(),
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// Never sync anything under `dir` (when it lies strictly inside the root), whatever the
    /// rules say: e.g. `$UC_HOME` or an agent root inside a synced home folder.
    pub fn exclude(&mut self, dir: &Path) {
        if dir.starts_with(&self.root) && dir != self.root && !self.excluded.iter().any(|d| d == dir) {
            self.excluded.push(dir.to_path_buf());
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Is this absolute path (inside root) ignored? `is_dir` for directory rules.
    /// Paths outside the root count as ignored; the root itself never is.
    pub fn is_ignored(&self, abs: &Path, is_dir: bool) -> bool {
        if abs == self.root {
            return false;
        }
        let Some(rel) = paths::rel_canonical(&self.root, abs) else {
            return true;
        };
        if let Some(name) = abs.file_name().and_then(|n| n.to_str()) {
            if name == GITIGNORE || name == UCIGNORE || name == ".git" {
                if let Some(dir) = abs.parent() {
                    self.invalidate(dir);
                }
            }
        }
        // an ignored ancestor hides everything below it (the walker never descends there)
        let comps: Vec<&str> = rel.split('/').collect();
        let mut dir_abs = self.root.clone();
        let raw: Vec<_> = match abs.strip_prefix(&self.root) {
            Ok(r) => r.components().collect(),
            Err(_) => return true,
        };
        for i in 0..comps.len().saturating_sub(1) {
            dir_abs.push(raw[i]);
            if self.entry_ignored(&dir_abs, &comps[..=i].join("/"), true) {
                return true;
            }
        }
        self.entry_ignored(abs, &rel, is_dir)
    }

    /// Drop cached rules of one directory (its .gitignore/.ucignore/.git changed).
    pub fn invalidate(&self, dir: &Path) {
        self.lock().remove(dir);
    }

    pub fn clear_cache(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Arc<DirRules>>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Is `name` an ignore-rules file whose change should trigger a subtree rescan?
    pub fn is_rules_file(name: &str) -> bool {
        name == GITIGNORE || name == UCIGNORE
    }

    /// Rule evaluation for one entry whose ancestors are known not to be ignored.
    fn entry_ignored(&self, abs: &Path, rel: &str, is_dir: bool) -> bool {
        if self.builtin_any.is_match(rel) || (is_dir && self.builtin_dirs.is_match(rel)) {
            return true;
        }
        if self.excluded.iter().any(|d| abs.starts_with(d)) {
            return true;
        }
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if self.include_names.is_match(name) || self.include_paths.is_match(rel) {
            return false;
        }
        // git never applies .gitignore to its own internals
        let inside_git = rel.split('/').rev().skip(1).any(|c| c == ".git");
        let mut m_uc: Option<bool> = None;
        let mut m_git: Option<bool> = None;
        let mut saw_git = false;
        let mut dir = abs.parent();
        while let Some(d) = dir {
            if !d.starts_with(&self.root) {
                break;
            }
            let rules = self.rules(d);
            if m_uc.is_none() {
                m_uc = rules.uc.as_ref().and_then(|g| tri(g, abs, is_dir));
            }
            if self.respect_gitignore && !inside_git && !saw_git && m_git.is_none() {
                m_git = rules.git.as_ref().and_then(|g| tri(g, abs, is_dir));
            }
            saw_git = saw_git || rules.has_git;
            if d == self.root || (m_uc.is_some() && (m_git.is_some() || saw_git)) {
                break;
            }
            dir = d.parent();
        }
        m_uc.or(m_git).unwrap_or(false)
    }

    fn rules(&self, dir: &Path) -> Arc<DirRules> {
        if let Some(r) = self.lock().get(dir) {
            return r.clone();
        }
        let rules = Arc::new(DirRules {
            uc: load_gitignore(dir, UCIGNORE),
            git: if self.respect_gitignore { load_gitignore(dir, GITIGNORE) } else { None },
            has_git: fs::symlink_metadata(dir.join(".git")).is_ok(),
        });
        self.lock().insert(dir.to_path_buf(), rules.clone());
        rules
    }
}

/// Some(true) = ignored, Some(false) = whitelisted (`!pattern`), None = no rule matched.
fn tri(g: &Gitignore, abs: &Path, is_dir: bool) -> Option<bool> {
    let m = g.matched(abs, is_dir);
    if m.is_ignore() {
        Some(true)
    } else if m.is_whitelist() {
        Some(false)
    } else {
        None
    }
}

fn load_gitignore(dir: &Path, name: &str) -> Option<Gitignore> {
    let p = dir.join(name);
    match fs::symlink_metadata(&p) {
        Ok(m) if m.is_file() => {}
        _ => return None,
    }
    let mut b = GitignoreBuilder::new(dir);
    if let Some(e) = b.add(&p) {
        warn!("{}: {e}", p.display());
    }
    match b.build() {
        Ok(g) if !g.is_empty() => Some(g),
        Ok(_) => None,
        Err(e) => {
            warn!("{}: {e}", p.display());
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LocalKind {
    File,
    Symlink(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Scanned {
    /// canonical relative path
    pub rel: String,
    pub abs: PathBuf,
    pub kind: LocalKind,
    pub fp: LocalFp,
}

/// What lstat says about a path.
#[derive(Debug, Clone, PartialEq)]
pub enum Stat {
    /// absent (or a parent is not a directory)
    Missing,
    Dir,
    /// fifo, socket, device, or a symlink whose target is not UTF-8: never synced
    Special,
    Entry(LocalKind, LocalFp),
}

/// lstat a path, distinguishing "absent" from real I/O errors (EACCES, EIO): callers must not
/// conclude a file was deleted when it merely could not be read.
pub fn stat(abs: &Path) -> std::io::Result<Stat> {
    let gone = |e: &std::io::Error| {
        e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR)
    };
    let m = match fs::symlink_metadata(abs) {
        Ok(m) => m,
        Err(e) if gone(&e) => return Ok(Stat::Missing),
        Err(e) => return Err(e),
    };
    let ft = m.file_type();
    if ft.is_dir() {
        return Ok(Stat::Dir);
    }
    let fp = LocalFp {
        size: m.len(),
        mtime_ns: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128,
        ino: m.ino(),
        exec: ft.is_file() && m.mode() & 0o111 != 0,
    };
    if ft.is_symlink() {
        return match fs::read_link(abs) {
            Ok(t) => Ok(match t.into_os_string().into_string() {
                Ok(s) => Stat::Entry(LocalKind::Symlink(s), fp),
                Err(_) => Stat::Special,
            }),
            Err(e) if gone(&e) => Ok(Stat::Missing),
            Err(e) => Err(e),
        };
    }
    if ft.is_file() {
        return Ok(Stat::Entry(LocalKind::File, fp));
    }
    Ok(Stat::Special)
}

/// Walk a space root (not following symlinks), applying ignore rules.
pub fn scan(root: &Path, ignore: &Ignore) -> Result<Vec<Scanned>> {
    scan_dir(root, root, ignore)
}

/// Walk the subtree at `dir` (inside `root`, or `root` itself). Ancestors of `dir` must be
/// checked by the caller (`Ignore::is_ignored(dir, true)`).
pub fn scan_dir(root: &Path, dir: &Path, ignore: &Ignore) -> Result<Vec<Scanned>> {
    if dir == root {
        ignore.clear_cache();
    }
    match fs::metadata(dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => bail!("{} is not a directory", dir.display()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    }
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = match fs::read_dir(&d) {
            Ok(rd) => rd,
            Err(e) if d.as_path() == dir => {
                return Err(e).with_context(|| format!("reading {}", d.display()))
            }
            Err(e) => {
                warn!("skipping unreadable {}: {e}", d.display());
                continue;
            }
        };
        for ent in rd {
            let ent = match ent {
                Ok(e) => e,
                Err(e) => {
                    warn!("reading {}: {e}", d.display());
                    continue;
                }
            };
            let abs = ent.path();
            let Some(name) = ent.file_name().to_str().map(str::to_string) else {
                debug!("skipping non-UTF-8 name {}", abs.display());
                continue;
            };
            let Some(rel) = paths::rel_canonical(root, &abs) else { continue };
            let ft = match ent.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if !unicode_normalization::is_nfc(&name) && !resolves_same(root, &rel, &abs) {
                warn!("skipping {}: name is not NFC on a normalization-sensitive filesystem", abs.display());
                continue;
            }
            if ft.is_dir() {
                if !ignore.entry_ignored(&abs, &rel, true) {
                    stack.push(abs);
                }
                continue;
            }
            if !(ft.is_file() || ft.is_symlink()) || ignore.entry_ignored(&abs, &rel, false) {
                continue;
            }
            match stat(&abs) {
                Ok(Stat::Entry(kind, fp)) => out.push(Scanned { rel, abs, kind, fp }),
                Ok(_) => {}
                Err(e) => warn!("stat {}: {e}", abs.display()),
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn resolves_same(root: &Path, rel: &str, abs: &Path) -> bool {
    match (
        fs::symlink_metadata(paths::join_canonical(root, rel)),
        fs::symlink_metadata(abs),
    ) {
        (Ok(a), Ok(b)) => a.ino() == b.ino() && a.dev() == b.dev(),
        _ => false,
    }
}

/// lstat-based fingerprint; None if missing or not a regular file/symlink.
pub fn fingerprint(abs: &Path) -> Option<(LocalKind, LocalFp)> {
    match stat(abs) {
        Ok(Stat::Entry(k, fp)) => Some((k, fp)),
        _ => None,
    }
}

/// Is the filesystem at `dir` case-insensitive? Probes with a temp file (DESIGN §5.6).
pub fn probe_case_insensitive(dir: &Path) -> Result<bool> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let lower = dir.join(format!(".uc-tmp-case-{}", &id[..12]));
    let upper = dir.join(format!(".UC-TMP-CASE-{}", id[..12].to_uppercase()));
    fs::write(&lower, b"").with_context(|| format!("probing {}", dir.display()))?;
    let insensitive = fs::symlink_metadata(&upper).is_ok();
    let _ = fs::remove_file(&lower);
    Ok(insensitive)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("uc").tempdir_in("/tmp").unwrap()
    }

    fn touch(root: &Path, rel: &str, data: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, data).unwrap();
    }

    fn rels(v: &[Scanned]) -> Vec<&str> {
        v.iter().map(|s| s.rel.as_str()).collect()
    }

    fn default_ignore(root: &Path) -> Ignore {
        let inc = vec![".env".to_string(), ".env.*".to_string(), ".envrc".to_string()];
        Ignore::new(root, true, &inc).unwrap()
    }

    #[test]
    fn rules_and_agreement() {
        let d = tmpdir();
        let r = d.path();
        touch(r, "proj/.gitignore", "*.log\n.env*\nbuild/\n!keep.log\n");
        touch(r, "proj/.git/HEAD", "ref: refs/heads/main\n");
        touch(r, "proj/.git/index", "idx");
        touch(r, "proj/.git/index.lock", "x");
        touch(r, "proj/.git/refs/heads/main.lock", "x");
        touch(r, "proj/.git/objects/ab/cdef", "obj");
        touch(r, "proj/.git/objects/pack/tmp_pack_1", "x");
        touch(r, "proj/.git/logs/x.log", "gitignore must not reach inside .git");
        touch(r, "proj/src/main.rs", "fn main(){}");
        touch(r, "proj/a.log", "ignored");
        touch(r, "proj/keep.log", "whitelisted");
        touch(r, "proj/.env", "SECRET=1");
        touch(r, "proj/.env.local", "SECRET=2");
        touch(r, "proj/.envrc", "use nix");
        touch(r, "proj/build/out.js", "x");
        touch(r, "proj/build/.env", "dir ignored: never descended");
        touch(r, "proj/node_modules/x/index.js", "x");
        touch(r, "proj/sub/.ucignore", "secret.txt\n");
        touch(r, "proj/sub/secret.txt", "x");
        touch(r, "proj/sub/ok.txt", "x");
        touch(r, "proj/.DS_Store", "x");
        touch(r, "proj/notes.txt~", "x");
        touch(r, "proj/.uc-tmp-123", "x");
        touch(r, "target/foo", "built-in dir at root");
        touch(r, "top.txt", "x");
        std::os::unix::fs::symlink("/etc", r.join("proj/link")).unwrap();
        std::os::unix::fs::symlink("src", r.join("proj/srclink")).unwrap();

        let ig = default_ignore(r);
        let got = scan(r, &ig).unwrap();
        let names = rels(&got);
        assert_eq!(
            names,
            vec![
                "proj/.env",
                "proj/.env.local",
                "proj/.envrc",
                "proj/.git/HEAD",
                "proj/.git/index",
                "proj/.git/logs/x.log",
                "proj/.git/objects/ab/cdef",
                "proj/.gitignore",
                "proj/keep.log",
                "proj/link",
                "proj/src/main.rs",
                "proj/srclink",
                "proj/sub/.ucignore",
                "proj/sub/ok.txt",
                "top.txt",
            ]
        );
        let link = got.iter().find(|s| s.rel == "proj/link").unwrap();
        assert_eq!(link.kind, LocalKind::Symlink("/etc".into()));

        // single-path checks agree with the walk for every file in the tree
        let mut all = Vec::new();
        let mut stack = vec![r.to_path_buf()];
        while let Some(dd) = stack.pop() {
            for e in fs::read_dir(&dd).unwrap() {
                let e = e.unwrap();
                let ft = e.file_type().unwrap();
                if ft.is_dir() {
                    stack.push(e.path());
                } else {
                    all.push(e.path());
                }
            }
        }
        let fresh = default_ignore(r);
        for p in all {
            let rel = paths::rel_canonical(r, &p).unwrap();
            assert_eq!(
                !fresh.is_ignored(&p, false),
                names.contains(&rel.as_str()),
                "disagreement on {rel}"
            );
        }
        assert!(fresh.is_ignored(&r.join("proj/node_modules"), true));
        assert!(!fresh.is_ignored(r, true));
        assert!(fresh.is_ignored(Path::new("/elsewhere/x"), false));
    }

    #[test]
    fn gitignore_optional_and_cache_invalidation() {
        let d = tmpdir();
        let r = d.path();
        touch(r, "a.log", "x");
        touch(r, ".gitignore", "*.log\n");
        let ig = Ignore::new(r, false, &[]).unwrap();
        assert!(!ig.is_ignored(&r.join("a.log"), false));
        let ig = Ignore::new(r, true, &[]).unwrap();
        assert!(ig.is_ignored(&r.join("a.log"), false));
        touch(r, ".gitignore", "*.tmp\n");
        // an event on the .gitignore itself refreshes the cached rules
        assert!(!ig.is_ignored(&r.join(".gitignore"), false));
        assert!(!ig.is_ignored(&r.join("a.log"), false));
        assert!(ig.is_ignored(&r.join("b.tmp"), false));
    }

    #[test]
    fn excluded_dirs() {
        let d = tmpdir();
        let r = d.path();
        touch(r, ".ultracontext/client.db", "x");
        touch(r, ".claude/projects/a.jsonl", "x");
        touch(r, "Code/a.txt", "x");
        let mut ig = default_ignore(r);
        ig.exclude(&r.join(".ultracontext"));
        ig.exclude(&r.join(".claude"));
        ig.exclude(r);
        let names: Vec<String> = scan(r, &ig).unwrap().into_iter().map(|s| s.rel).collect();
        assert_eq!(names, vec!["Code/a.txt"]);
        assert!(ig.is_ignored(&r.join(".claude/projects/a.jsonl"), false));
    }

    #[test]
    fn nested_repo_boundary() {
        let d = tmpdir();
        let r = d.path();
        touch(r, ".gitignore", "*.dat\n");
        touch(r, "outer.dat", "x");
        touch(r, "repo/.git/HEAD", "x");
        touch(r, "repo/inner.dat", "x");
        let ig = default_ignore(r);
        let names: Vec<String> = scan(r, &ig).unwrap().into_iter().map(|s| s.rel).collect();
        assert!(!names.contains(&"outer.dat".to_string()));
        assert!(names.contains(&"repo/inner.dat".to_string()));
    }

    #[test]
    fn stat_kinds() {
        let d = tmpdir();
        let f = d.path().join("f");
        fs::write(&f, b"abc").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
        let (k, fp) = fingerprint(&f).unwrap();
        assert_eq!(k, LocalKind::File);
        assert_eq!(fp.size, 3);
        assert!(fp.exec);
        assert_eq!(stat(&d.path().join("nope")).unwrap(), Stat::Missing);
        assert_eq!(stat(&f.join("under-a-file")).unwrap(), Stat::Missing);
        assert_eq!(stat(d.path()).unwrap(), Stat::Dir);
        let _ = probe_case_insensitive(d.path()).unwrap();
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
}
