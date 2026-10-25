//! Machine-neutral path translation for session logs (DESIGN §6.2).
//!
//! `clean`  (local -> canonical): replace this machine's absolute roots with tokens.
//! `smudge` (canonical -> local): replace tokens with this machine's roots.
//! Space roots are replaced before `$HOME` (longest first); replacements only happen at a
//! path boundary (next char not alphanumeric, '-', '_' or '.').

use std::path::{Path, PathBuf};

use crate::config::Config;

pub const HOME_TOKEN: &str = "@@UC_HOME@@";

pub fn space_token(name: &str) -> String {
    format!("@@UC_SPACE:{name}@@")
}

#[derive(Debug, Clone, PartialEq)]
pub struct PathMap {
    /// absolute $HOME, no trailing slash
    pub home: String,
    /// (space name, absolute local root without trailing slash), any order
    pub spaces: Vec<(String, String)>,
}

impl PathMap {
    pub fn new(home: &Path, spaces: &[(String, PathBuf)]) -> Self {
        let _ = (home, spaces);
        todo!("sessions agent")
    }

    pub fn from_config(cfg: &Config) -> Self {
        let spaces: Vec<(String, PathBuf)> = cfg
            .spaces
            .iter()
            .map(|s| (s.name.clone(), s.local_path()))
            .collect();
        PathMap::new(&crate::paths::home(), &spaces)
    }

    /// local -> canonical
    pub fn clean(&self, text: &str) -> String {
        let _ = text;
        todo!("sessions agent")
    }

    /// canonical -> local
    pub fn smudge(&self, text: &str) -> String {
        let _ = text;
        todo!("sessions agent")
    }

    pub fn clean_path(&self, p: &Path) -> String {
        self.clean(&p.to_string_lossy())
    }

    pub fn smudge_path(&self, s: &str) -> PathBuf {
        PathBuf::from(self.smudge(s))
    }
}
