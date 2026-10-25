//! The `uc` agent skill, embedded in the binary and installed by `uc init` into the agent dirs
//! that exist on this machine.

use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::paths;

pub const SKILL_MD: &str = include_str!("../../skills/uc/SKILL.md");
/// Present in every copy we manage; a file without it was edited by the user and is kept.
pub const MARKER: &str = "<!-- uc-skill: managed by 'uc init'";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillAction {
    Installed,
    Updated,
    Unchanged,
    /// a user-edited copy (no marker) was left alone
    Kept,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillInstall {
    pub agent: String,
    pub path: PathBuf,
    pub action: SkillAction,
}

/// Agent config roots, honoring CLAUDE_CONFIG_DIR / CODEX_HOME.
pub fn agent_roots() -> Vec<(&'static str, PathBuf)> {
    let env_or = |var: &str, default: &str| {
        std::env::var_os(var)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| paths::home().join(default))
    };
    vec![
        ("claude", env_or("CLAUDE_CONFIG_DIR", ".claude")),
        ("codex", env_or("CODEX_HOME", ".codex")),
    ]
}

/// Install or refresh `<root>/skills/uc/SKILL.md` for every agent root that exists.
pub fn install_all() -> Result<Vec<SkillInstall>> {
    let mut out = Vec::new();
    for (agent, root) in agent_roots() {
        if !root.is_dir() {
            continue;
        }
        let path = root.join("skills/uc/SKILL.md");
        let action = install_at(&path, SKILL_MD)?;
        out.push(SkillInstall {
            agent: agent.to_string(),
            path,
            action,
        });
    }
    Ok(out)
}

/// Write `content` at `path` unless a user-owned (marker-less) file is there.
pub fn install_at(path: &Path, content: &str) -> Result<SkillAction> {
    let action = match std::fs::read_to_string(path) {
        Ok(existing) if existing == content => return Ok(SkillAction::Unchanged),
        Ok(existing) if !existing.contains(MARKER) => return Ok(SkillAction::Kept),
        Ok(_) => SkillAction::Updated,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SkillAction::Installed,
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, content).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(action)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_skill_is_well_formed() {
        assert!(SKILL_MD.starts_with("---\nname: uc\ndescription: "));
        assert!(SKILL_MD.contains(MARKER));
        assert!(SKILL_MD.lines().count() < 120);
    }

    #[test]
    fn never_overwrites_user_edits() {
        let tmp = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let p = tmp.path().join("skills/uc/SKILL.md");
        assert_eq!(install_at(&p, SKILL_MD).unwrap(), SkillAction::Installed);
        assert_eq!(install_at(&p, SKILL_MD).unwrap(), SkillAction::Unchanged);
        let newer = format!("{SKILL_MD}\nmore\n");
        assert_eq!(install_at(&p, &newer).unwrap(), SkillAction::Updated);
        std::fs::write(&p, "my own notes").unwrap();
        assert_eq!(install_at(&p, SKILL_MD).unwrap(), SkillAction::Kept);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "my own notes");
    }
}
