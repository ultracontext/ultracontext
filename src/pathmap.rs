//! Machine-neutral path translation for session logs (DESIGN §6.2).
//!
//! `clean`  (local -> canonical): replace this machine's `$HOME` with a token.
//! `smudge` (canonical -> local): replace the token with this machine's `$HOME`.
//! Replacements only happen at a path boundary: the next char is not alphanumeric, '-', '_'
//! or '.', and the previous char is not one either, so `/x/Users/fab` is never rewritten
//! while `file:///Users/fab` and `"/Users/fab` are.
//!
//! Older versions also wrote `@@UC_SPACE:<name>@@` tokens for synced folders; those smudge to
//! `$HOME/<name>` instead of leaking the token.

use std::path::Path;

pub const HOME_TOKEN: &str = "@@UC_HOME@@";
const SPACE_PREFIX: &str = "@@UC_SPACE:";
const TOKEN_END: &str = "@@";

#[derive(Debug, Clone, PartialEq)]
pub struct PathMap {
    /// absolute $HOME, no trailing slash
    pub home: String,
    /// $HOME with symlinks resolved, when it differs: agents record physical cwds, so `clean`
    /// must recognise both spellings.
    pub physical: Option<String>,
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
    pub fn new(home: &Path) -> Self {
        let home_s = home.to_string_lossy().trim_end_matches('/').to_string();
        let physical = home
            .canonicalize()
            .ok()
            .map(|r| r.to_string_lossy().trim_end_matches('/').to_string())
            .filter(|r| *r != home_s);
        PathMap {
            home: home_s,
            physical,
        }
    }

    /// Usable roots, longest first.
    fn rules(&self) -> Vec<String> {
        let mut v: Vec<String> = std::iter::once(&self.home)
            .chain(self.physical.as_ref())
            .filter_map(|p| usable_root(p))
            .collect();
        v.sort_by_key(|r| std::cmp::Reverse(r.len()));
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
                let hit = rules.iter().find(|root| {
                    rest.starts_with(root.as_str())
                        && !rest[root.len()..].chars().next().is_some_and(is_name_char)
                });
                if let Some(root) = hit {
                    out.push_str(HOME_TOKEN);
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
                        out.push_str(&format!("{}/{name}", self.home));
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mac() -> PathMap {
        PathMap::new(Path::new("/Users/fabio"))
    }

    fn linux() -> PathMap {
        PathMap::new(Path::new("/home/fabio"))
    }

    #[test]
    fn mac_to_linux_roundtrip() {
        let line = r#"{"cwd":"/Users/fabio/Code/proj","tool":{"file_path":"/Users/fabio/Code/work/api/main.rs"},"cmd":"cat /Users/fabio/.zshrc && ls /Users/fabio"}"#;
        let canon = mac().clean(line);
        assert_eq!(
            canon,
            r#"{"cwd":"@@UC_HOME@@/Code/proj","tool":{"file_path":"@@UC_HOME@@/Code/work/api/main.rs"},"cmd":"cat @@UC_HOME@@/.zshrc && ls @@UC_HOME@@"}"#
        );
        let lin = linux().smudge(&canon);
        assert_eq!(
            lin,
            r#"{"cwd":"/home/fabio/Code/proj","tool":{"file_path":"/home/fabio/Code/work/api/main.rs"},"cmd":"cat /home/fabio/.zshrc && ls /home/fabio"}"#
        );
        // and back: linux clean gives the same canonical form
        assert_eq!(linux().clean(&lin), canon);
        assert_eq!(mac().smudge(&canon), line);
    }

    #[test]
    fn boundaries() {
        let m = PathMap::new(Path::new("/Users/fab"));
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
    fn root_slash_never_used() {
        let m = PathMap::new(Path::new("/"));
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
    fn legacy_space_and_garbage_tokens() {
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
