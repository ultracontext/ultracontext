//! `uc branch <name>`: one synced folder per branch (a git worktree next to the repo).
//!
//! A synced repo is ONE working copy on every machine: checking out another branch on one
//! machine switches it under the agents of the others. Worktrees give each branch its own
//! folder, so any machine can work on any branch without touching the others.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::output::{self, emit_json, EXIT_OK};
use super::App;
use crate::paths;

#[derive(Serialize)]
struct BranchReport {
    branch: String,
    path: String,
    created_branch: bool,
    relative_paths: bool,
}

fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .context("running git (is it installed?)")
}

fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    let out = git(dir, args)?;
    if !out.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `--relative-paths` needs git >= 2.48; without it the worktree link holds absolute paths
/// and breaks on a machine whose $HOME differs.
fn supports_relative(dir: &Path) -> bool {
    let Ok(v) = git_ok(dir, &["--version"]) else {
        return false;
    };
    let nums: Vec<u32> = v
        .split_whitespace()
        .nth(2)
        .unwrap_or("")
        .split('.')
        .filter_map(|n| n.parse().ok())
        .collect();
    matches!(nums.as_slice(), [maj, min, ..] if (*maj, *min) >= (2, 48))
}

/// Folder name for a branch: `<repo>-<branch>` with path separators flattened.
pub(crate) fn folder_for(repo: &Path, branch: &str) -> PathBuf {
    let name = repo
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    let flat: String = branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    repo.with_file_name(format!("{name}-{flat}"))
}

pub fn cmd_branch(app: &App, name: &str, from: Option<&str>) -> Result<i32> {
    let start = match from {
        Some(d) => paths::expand_tilde(d),
        None => std::env::current_dir()?,
    };
    let top = PathBuf::from(
        git_ok(&start, &["rev-parse", "--show-toplevel"])
            .context("not inside a git repository (use --from <repo>)")?,
    );
    let dest = folder_for(&top, name);
    if dest.exists() {
        bail!(
            "{} already exists; work there: cd {}",
            paths::tilde(&dest),
            paths::tilde(&dest)
        );
    }
    let exists = git(&top, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")])?
        .status
        .success();
    let relative = supports_relative(&top);
    let dest_s = dest.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if relative {
        args.push("--relative-paths");
    }
    if exists {
        args.extend([dest_s.as_str(), name]);
    } else {
        args.extend(["-b", name, dest_s.as_str()]);
    }
    git_ok(&top, &args)?;

    let report = BranchReport {
        branch: name.to_string(),
        path: dest_s.clone(),
        created_branch: !exists,
        relative_paths: relative,
    };
    if app.json {
        emit_json(&report);
        return Ok(EXIT_OK);
    }
    println!(
        "{} branch '{}' lives in {} (its own synced folder)",
        output::ok_mark(),
        name,
        paths::tilde(&dest)
    );
    if !relative {
        println!(
            "{} git < 2.48: the worktree link uses absolute paths and only works on machines \
             with the same home directory; upgrade git for Mac <-> Linux",
            output::warn_mark()
        );
    }
    println!("  cd {} && claude", paths::tilde(&dest));
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_folders() {
        assert_eq!(
            folder_for(Path::new("/u/Code/app"), "feat/login"),
            PathBuf::from("/u/Code/app-feat-login")
        );
        assert_eq!(
            folder_for(Path::new("/u/Code/app"), "main"),
            PathBuf::from("/u/Code/app-main")
        );
    }
}
