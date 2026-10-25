//! Machine-neutral path translation for session logs (DESIGN §6.2).
//!
//! `clean`  (local -> canonical): replace this machine's absolute roots with tokens.
//! `smudge` (canonical -> local): replace tokens with this machine's roots.
//! Space roots are replaced before `$HOME` (longest first); replacements only happen at a
//! path boundary (next char not alphanumeric, '-', '_' or '.').
//!
//! Two refinements over the bare rule:
//! - a root also needs a left boundary (the previous char must not be a path-name char), so
//!   `/x/Users/fab` is never rewritten while `file:///Users/fab` and `"/Users/fab` are;
//! - a space token whose space is not mapped on this machine smudges to `$HOME/<name>`, the
//!   default location a space would get here (DESIGN §3.1), instead of leaking the token.

use std::path::{Path, PathBuf};

use crate::config::Config;

pub const HOME_TOKEN: &str = "@@UC_HOME@@";
const SPACE_PREFIX: &str = "@@UC_SPACE:";
const TOKEN_END: &str = "@@";

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

/// Absolute root without trailing '/'; None for "/", "" or relative paths (never mapped).
fn usable_root(p: &str) -> Option<String> {
    let t = p.trim_end_matches('/');
    if t.is_empty() || !t.starts_with('/') {
        return None;
    }
    Some(t.to_string())
}

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | '.')
}

fn valid_space_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains('@')
        && !name.contains('/')
        && !name
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\\')
}

impl PathMap {
    pub fn new(home: &Path, spaces: &[(String, PathBuf)]) -> Self {
        PathMap {
            home: home.to_string_lossy().trim_end_matches('/').to_string(),
            spaces: spaces
                .iter()
                .filter(|(name, _)| valid_space_name(name))
                .map(|(n, p)| {
                    (
                        n.clone(),
                        p.to_string_lossy().trim_end_matches('/').to_string(),
                    )
                })
                .collect(),
        }
    }

    pub fn from_config(cfg: &Config) -> Self {
        let spaces: Vec<(String, PathBuf)> = cfg
            .spaces
            .iter()
            .map(|s| (s.name.clone(), s.local_path()))
            .collect();
        PathMap::new(&crate::paths::home(), &spaces)
    }

    /// (root, token), longest root first; unusable roots dropped.
    fn rules(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .spaces
            .iter()
            .filter(|(n, _)| valid_space_name(n))
            .filter_map(|(n, p)| usable_root(p).map(|r| (r, space_token(n))))
            .collect();
        if let Some(h) = usable_root(&self.home) {
            v.push((h, HOME_TOKEN.to_string()));
        }
        // longest first; spaces win ties against $HOME because they were pushed first
        v.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        v
    }

    /// local -> canonical
    pub fn clean(&self, text: &str) -> String {
        let rules = self.rules();
        if rules.is_empty() || !text.contains('/') {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        let mut prev: Option<char> = None;
        while i < text.len() {
            let rest = &text[i..];
            if rest.starts_with('/') && !prev.is_some_and(is_name_char) {
                let hit = rules.iter().find(|(root, _)| {
                    rest.starts_with(root.as_str())
                        && !rest[root.len()..].chars().next().is_some_and(is_name_char)
                });
                if let Some((root, token)) = hit {
                    out.push_str(token);
                    i += root.len();
                    prev = root.chars().next_back();
                    continue;
                }
            }
            let c = rest.chars().next().expect("non-empty rest");
            out.push(c);
            prev = Some(c);
            i += c.len_utf8();
        }
        out
    }

    /// canonical -> local
    pub fn smudge(&self, text: &str) -> String {
        if !text.contains("@@UC_") {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(pos) = rest.find("@@UC_") {
            out.push_str(&rest[..pos]);
            let tail = &rest[pos..];
            if let Some(after) = tail.strip_prefix(HOME_TOKEN) {
                out.push_str(&self.home);
                rest = after;
                continue;
            }
            if let Some(body) = tail.strip_prefix(SPACE_PREFIX) {
                if let Some(end) = body.find(TOKEN_END) {
                    let name = &body[..end];
                    if valid_space_name(name) {
                        out.push_str(&self.space_root(name));
                        rest = &body[end + TOKEN_END.len()..];
                        continue;
                    }
                }
            }
            // not a token: keep literally
            out.push_str("@@UC_");
            rest = &tail["@@UC_".len()..];
        }
        out.push_str(rest);
        out
    }

    /// Local root of a space; unmapped spaces fall back to `$HOME/<name>`.
    pub fn space_root(&self, name: &str) -> String {
        match self.spaces.iter().find(|(n, _)| n == name) {
            Some((_, p)) => p.clone(),
            None => format!("{}/{}", self.home, name),
        }
    }

    pub fn clean_path(&self, p: &Path) -> String {
        self.clean(&p.to_string_lossy())
    }

    pub fn smudge_path(&self, s: &str) -> PathBuf {
        PathBuf::from(self.smudge(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mac() -> PathMap {
        PathMap::new(
            Path::new("/Users/fabio"),
            &[
                ("code".into(), PathBuf::from("/Users/fabio/Code")),
                ("work".into(), PathBuf::from("/Users/fabio/Code/work/")),
            ],
        )
    }

    fn linux() -> PathMap {
        PathMap::new(
            Path::new("/home/fabio"),
            &[
                ("code".into(), PathBuf::from("/home/fabio/src")),
                ("work".into(), PathBuf::from("/srv/work")),
            ],
        )
    }

    #[test]
    fn mac_to_linux_roundtrip() {
        let line = r#"{"cwd":"/Users/fabio/Code/proj","tool":{"file_path":"/Users/fabio/Code/work/api/main.rs"},"cmd":"cat /Users/fabio/.zshrc && ls /Users/fabio"}"#;
        let canon = mac().clean(line);
        assert_eq!(
            canon,
            r#"{"cwd":"@@UC_SPACE:code@@/proj","tool":{"file_path":"@@UC_SPACE:work@@/api/main.rs"},"cmd":"cat @@UC_HOME@@/.zshrc && ls @@UC_HOME@@"}"#
        );
        let lin = linux().smudge(&canon);
        assert_eq!(
            lin,
            r#"{"cwd":"/home/fabio/src/proj","tool":{"file_path":"/srv/work/api/main.rs"},"cmd":"cat /home/fabio/.zshrc && ls /home/fabio"}"#
        );
        // and back: linux clean gives the same canonical form
        assert_eq!(linux().clean(&lin), canon);
        assert_eq!(mac().smudge(&canon), line);
    }

    #[test]
    fn boundaries() {
        let m = PathMap::new(Path::new("/Users/fab"), &[]);
        assert_eq!(m.clean("/Users/fabio2/x"), "/Users/fabio2/x");
        assert_eq!(m.clean("/Users/fab.bak"), "/Users/fab.bak");
        assert_eq!(
            m.clean("/Users/fab-x /Users/fab_y"),
            "/Users/fab-x /Users/fab_y"
        );
        assert_eq!(m.clean("/Users/fab/x"), "@@UC_HOME@@/x");
        assert_eq!(m.clean("\"/Users/fab\""), "\"@@UC_HOME@@\"");
        assert_eq!(m.clean("/Users/fab:/usr/bin"), "@@UC_HOME@@:/usr/bin");
        // left boundary: embedded in another path or word
        assert_eq!(m.clean("/data/Users/fab/x"), "/data/Users/fab/x");
        assert_eq!(m.clean("file:///Users/fab/x"), "file://@@UC_HOME@@/x");
        assert_eq!(m.clean("PATH=/Users/fab/bin"), "PATH=@@UC_HOME@@/bin");
        // unicode after the root is a name char
        assert_eq!(m.clean("/Users/fabé"), "/Users/fabé");
        assert_eq!(m.clean("ação /Users/fab/ç"), "ação @@UC_HOME@@/ç");
    }

    #[test]
    fn longest_first() {
        let m = PathMap::new(
            Path::new("/u"),
            &[
                ("a".into(), PathBuf::from("/u/c")),
                ("b".into(), PathBuf::from("/u/c/d")),
            ],
        );
        assert_eq!(m.clean("/u/c/d/e"), "@@UC_SPACE:b@@/e");
        assert_eq!(m.clean("/u/c/x"), "@@UC_SPACE:a@@/x");
        assert_eq!(m.clean("/u/cd"), "@@UC_HOME@@/cd");
    }

    #[test]
    fn root_slash_and_empty_never_used() {
        let m = PathMap::new(
            Path::new("/"),
            &[
                ("x".into(), PathBuf::from("")),
                ("y".into(), PathBuf::from("/")),
            ],
        );
        assert_eq!(m.clean("/etc/hosts and /"), "/etc/hosts and /");
    }

    #[test]
    fn idempotent_and_json_safe() {
        let m = mac();
        let s = r#"{"a":"/Users/fabio/Code/p","b":"say \"/Users/fabio\"","c":"\\/Users/fabio"}"#;
        let once = m.clean(s);
        assert_eq!(m.clean(&once), once);
        // the escaped quote before the path is a boundary; serde_json still parses it
        let v: serde_json::Value = serde_json::from_str(&once).unwrap();
        assert_eq!(v["b"], "say \"@@UC_HOME@@\"");
        assert_eq!(m.smudge(&once), s);
    }

    #[test]
    fn unknown_space_and_garbage_tokens() {
        let l = linux();
        assert_eq!(
            l.smudge("@@UC_SPACE:music@@/a.mp3"),
            "/home/fabio/music/a.mp3"
        );
        assert_eq!(l.smudge("x @@UC_SPACE:@@ y"), "x @@UC_SPACE:@@ y");
        assert_eq!(l.smudge("@@UC_ @@UC_HOME@@"), "@@UC_ /home/fabio");
        assert_eq!(l.smudge("@@UC_SPACE:no end"), "@@UC_SPACE:no end");
    }
}
