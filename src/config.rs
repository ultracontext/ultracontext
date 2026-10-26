//! Client config: `$UC_HOME/config.toml` (DESIGN §2.1).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths;
use crate::proto::MachineInfo;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    pub machine_id: String,
    pub machine_name: String,
    /// hub address (DESIGN §1); empty = not initialized
    #[serde(default)]
    pub hub: String,
    /// explicit path of `uc` on the hub host (ssh transport)
    #[serde(default)]
    pub remote_uc: String,
    /// tcp transport token
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub sync: SyncConfig,
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default, rename = "space")]
    pub spaces: Vec<SpaceConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncConfig {
    #[serde(default = "yes")]
    pub respect_gitignore: bool,
    #[serde(default = "default_always_include")]
    pub always_include: Vec<String>,
    #[serde(default = "default_debounce")]
    pub debounce_ms: u64,
}

impl Default for SyncConfig {
    fn default() -> Self {
        SyncConfig {
            respect_gitignore: true,
            always_include: default_always_include(),
            debounce_ms: default_debounce(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default = "yes")]
    pub claude: bool,
    #[serde(default = "yes")]
    pub codex: bool,
    #[serde(default = "default_eager_days")]
    pub eager_days: u32,
}

impl Default for AgentsConfig {
    fn default() -> Self {
        AgentsConfig {
            claude: true,
            codex: true,
            eager_days: default_eager_days(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpaceConfig {
    pub name: String,
    /// local path; may start with `~`
    pub path: String,
}

impl SpaceConfig {
    pub fn local_path(&self) -> PathBuf {
        paths::expand_tilde(&self.path)
    }
}

fn yes() -> bool {
    true
}
fn default_always_include() -> Vec<String> {
    vec![".env".into(), ".env.*".into(), ".envrc".into()]
}
fn default_debounce() -> u64 {
    300
}
fn default_eager_days() -> u32 {
    30 // Claude Code keeps transcripts 30 days
}

impl Config {
    /// A fresh config for this machine (random machine id, hostname as name).
    pub fn new_for_this_machine() -> Self {
        let id = format!("m_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        let name = gethostname::gethostname()
            .to_string_lossy()
            .trim_end_matches(".local")
            .to_lowercase();
        Config {
            machine_id: id,
            machine_name: if name.is_empty() {
                "machine".into()
            } else {
                name
            },
            hub: String::new(),
            remote_uc: String::new(),
            token: String::new(),
            sync: SyncConfig::default(),
            agents: AgentsConfig::default(),
            spaces: Vec::new(),
        }
    }

    pub fn load(path: &Path) -> Result<Option<Config>> {
        match std::fs::read_to_string(path) {
            Ok(s) => Ok(Some(
                toml::from_str(&s).with_context(|| format!("parsing {}", path.display()))?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Load, or create + save a fresh one.
    pub fn load_or_create(path: &Path) -> Result<Config> {
        if let Some(c) = Config::load(path)? {
            return Ok(c);
        }
        let c = Config::new_for_this_machine();
        c.save(path)?;
        Ok(c)
    }

    /// Atomic save (tmp + rename).
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("toml.tmp");
        // may hold the tcp token: owner-only from the first byte
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let _ = std::fs::remove_file(&tmp);
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(toml::to_string_pretty(self)?.as_bytes())?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn machine_info(&self) -> MachineInfo {
        MachineInfo {
            id: self.machine_id.clone(),
            name: self.machine_name.clone(),
            os: paths::os_name().to_string(),
            home: paths::home().to_string_lossy().to_string(),
        }
    }

    pub fn space(&self, name: &str) -> Option<&SpaceConfig> {
        self.spaces.iter().find(|s| s.name == name)
    }

    pub fn is_initialized(&self) -> bool {
        !self.hub.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut c = Config::new_for_this_machine();
        c.hub = "uc".into();
        c.spaces.push(SpaceConfig {
            name: "code".into(),
            path: "~/Code".into(),
        });
        let s = toml::to_string_pretty(&c).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        assert_eq!(c, back);
        // minimal file parses with defaults
        let min: Config = toml::from_str("machine_id='m'\nmachine_name='n'\n").unwrap();
        assert!(min.sync.respect_gitignore);
        assert_eq!(min.agents.eager_days, 30);
    }
}
