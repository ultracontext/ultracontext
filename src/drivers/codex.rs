//! Codex CLI driver (DESIGN §6.6). Owner: sessions agent.
//!
//! Native layout ($CODEX_HOME or ~/.codex): `sessions/YYYY/MM/DD/rollout-<local ts>-<uuid>.jsonl`.
//! `codex resume <id>` finds a rollout by walking `sessions/**` for the id in the file name, so
//! a rollout placed at the same relative path is resumable without touching Codex's sqlite DBs.
//!
//! Rollouts are replicated byte-exact: byte offsets and ordinals inside them are load-bearing,
//! so `clean_line`/`smudge_line` are the identity and paths are only translated in metadata and
//! in the resume argv (`codex resume -C <local cwd> <id>`).
//!
//! Not synced (v1): `.jsonl.zst` compressed rollouts (older than 7 days), revert rollouts
//! (`..-<id>_<rollout>.jsonl`), archived sessions, history/session_index, every sqlite DB.

use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::claude::{clip, json_lines, ts_ms};
use super::{AgentDriver, AgentFile, AgentFileKind};
use crate::pathmap::PathMap;
use crate::proto::SessionMeta;

pub struct Codex {
    root: PathBuf,
}

impl Codex {
    /// root = $CODEX_HOME or ~/.codex
    pub fn from_env() -> Self {
        let root = std::env::var_os("CODEX_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::paths::home().join(".codex"));
        Codex { root }
    }
    pub fn with_root(root: PathBuf) -> Self {
        Codex { root }
    }

    /// Does a live Codex hold the writer lock of this thread? (see [`writer_locked`])
    pub fn is_live(&self, thread_id: &str) -> bool {
        writer_locked(&self.root, thread_id)
    }
}

fn try_flock(f: &std::fs::File) -> std::io::Result<bool> {
    // SAFETY: plain flock(2) on a descriptor we own for the duration of the call.
    let r = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if r == 0 {
        return Ok(true);
    }
    let e = std::io::Error::last_os_error();
    if e.kind() == std::io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(e)
    }
}

fn unlock(f: &std::fs::File) {
    // SAFETY: as above.
    unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_UN) };
}

/// Codex's writer protocol: take `thread-writer-locks/.coordination.lock`, then try-lock
/// `<thread_id>.lock` (held by the writer for as long as it appends). We follow the same order
/// so our probe can never make a starting Codex believe another writer exists.
pub fn writer_locked(root: &Path, thread_id: &str) -> bool {
    let dir = root.join("thread-writer-locks");
    let Ok(thread_lock) = std::fs::File::open(dir.join(format!("{thread_id}.lock"))) else {
        return false;
    };
    let coord = std::fs::File::open(dir.join(".coordination.lock")).ok();
    if let Some(c) = &coord {
        let mut held = false;
        for _ in 0..50 {
            match try_flock(c) {
                Ok(true) => {
                    held = true;
                    break;
                }
                Ok(false) => std::thread::sleep(std::time::Duration::from_millis(5)),
                Err(_) => break,
            }
        }
        if !held {
            // someone is mid-acquire for a long time: assume a writer
            return true;
        }
    }
    let live = match try_flock(&thread_lock) {
        Ok(true) => {
            unlock(&thread_lock);
            false
        }
        Ok(false) => true,
        Err(e) => {
            tracing::debug!("flock probe failed for codex thread {thread_id}: {e}");
            false
        }
    };
    if let Some(c) = &coord {
        unlock(c);
    }
    live
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// `YYYY-MM-DDThh-mm-ss`
fn is_ts(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 19
        && b.iter().enumerate().all(|(i, &c)| match i {
            4 | 7 | 13 | 16 => c == b'-',
            10 => c == b'T',
            _ => c.is_ascii_digit(),
        })
}

/// Thread id of a rollout file name (`rollout-<ts>-<uuid>.jsonl`), None for anything else.
pub fn rollout_id(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    if rest.len() != 19 + 1 + 36 || !rest.is_char_boundary(19) {
        return None;
    }
    let (ts, id) = rest.split_at(19);
    let id = id.strip_prefix('-')?;
    (is_ts(ts) && super::claude::is_uuid(id)).then_some(id)
}

/// First user message text, skipping Codex's injected context blocks.
fn user_text(v: &Value) -> Option<String> {
    let ty = v.get("type").and_then(Value::as_str)?;
    let p = v.get("payload")?;
    let text = match (ty, p.get("type").and_then(Value::as_str)) {
        ("event_msg", Some("user_message")) => p.get("message")?.as_str()?.to_string(),
        ("response_item", Some("message"))
            if p.get("role").and_then(Value::as_str) == Some("user") =>
        {
            p.get("content")?
                .as_array()?
                .iter()
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return None,
    };
    let t = text.trim();
    let injected = t.starts_with('<')
        || t.starts_with("# AGENTS.md")
        || t.contains("<environment_context>")
        || t.contains("<user_instructions>");
    (!t.is_empty() && !injected).then(|| t.to_string())
}

impl AgentDriver for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }
    fn space(&self) -> &'static str {
        "@codex"
    }
    fn root(&self) -> PathBuf {
        self.root.clone()
    }

    fn classify(&self, rel: &str) -> Option<AgentFile> {
        let parts: Vec<&str> = rel.split('/').collect();
        let ["sessions", y, m, d, name] = parts.as_slice() else {
            return None;
        };
        if !(digits(y, 4) && digits(m, 2) && digits(d, 2)) {
            return None;
        }
        let id = rollout_id(name)?;
        Some(AgentFile {
            canonical: format!("sessions/{id}.jsonl"),
            session_id: id.to_string(),
            kind: AgentFileKind::Log,
            transcript: true,
        })
    }

    fn parse_meta(
        &self,
        session_id: &str,
        head: &[u8],
        tail: &[u8],
        map: &PathMap,
    ) -> Option<SessionMeta> {
        let head_v = json_lines(head);
        let tail_v = json_lines(tail);
        if head_v.is_empty() && tail_v.is_empty() {
            return None;
        }
        let all = || head_v.iter().chain(tail_v.iter());
        let mut m = SessionMeta {
            agent: "codex".into(),
            id: session_id.to_string(),
            ..Default::default()
        };
        let sm = head_v
            .iter()
            .find(|v| v.get("type").and_then(Value::as_str) == Some("session_meta"))
            .and_then(|v| v.get("payload"));
        if let Some(p) = sm {
            m.cwd = p.get("cwd").and_then(Value::as_str).map(|c| map.clean(c));
            m.git_branch = p
                .get("git")
                .and_then(|g| g.get("branch"))
                .and_then(Value::as_str)
                .map(str::to_string);
            m.forked_from = p
                .get("forked_from_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            m.created_at = ts_ms(p);
        }
        m.created_at = m.created_at.or_else(|| all().find_map(ts_ms));
        m.updated_at = all().filter_map(ts_ms).max();
        m.model = all()
            .filter(|v| v.get("type").and_then(Value::as_str) == Some("turn_context"))
            .filter_map(|v| v.get("payload")?.get("model")?.as_str())
            .last()
            .map(str::to_string);
        if m.cwd.is_none() {
            m.cwd = all()
                .filter(|v| v.get("type").and_then(Value::as_str) == Some("turn_context"))
                .filter_map(|v| v.get("payload")?.get("cwd")?.as_str())
                .last()
                .map(|c| map.clean(c));
        }
        m.first_prompt = head_v
            .iter()
            .find_map(user_text)
            .map(|t| clip(&map.clean(&t), 300));
        Some(m)
    }

    fn native_rel(
        &self,
        canonical: &str,
        meta: Option<&SessionMeta>,
        map: &PathMap,
    ) -> Option<String> {
        let _ = map;
        let id = canonical
            .strip_prefix("sessions/")?
            .strip_suffix(".jsonl")?;
        if let Some(rel) = meta.and_then(|m| m.native_rel.as_deref()) {
            if self.classify(rel).is_some_and(|f| f.canonical == canonical) {
                return Some(rel.to_string());
            }
        }
        // fallback: the layout Codex itself would have used on this machine
        let created = meta.and_then(|m| m.created_at)?;
        let local = chrono::DateTime::from_timestamp_millis(created)?.with_timezone(&chrono::Local);
        Some(format!(
            "sessions/{}/rollout-{}-{id}.jsonl",
            local.format("%Y/%m/%d"),
            local.format("%Y-%m-%dT%H-%M-%S")
        ))
    }

    fn clean_line(&self, line: &str, _map: &PathMap) -> String {
        line.to_string()
    }

    fn smudge_line(&self, line: &str, _map: &PathMap) -> String {
        line.to_string()
    }

    fn fork_line(&self, line: &str, old_id: &str, new_id: &str) -> String {
        line.replace(old_id, new_id)
    }

    fn resume_argv(&self, meta: &SessionMeta, local_cwd: &Path) -> Vec<String> {
        vec![
            "codex".into(),
            "resume".into(),
            "-C".into(),
            local_cwd.to_string_lossy().to_string(),
            meta.id.clone(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TID: &str = "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b";

    #[test]
    fn classify_table() {
        let c = Codex::with_root("/r".into());
        let rel = format!("sessions/2026/10/25/rollout-2026-10-25T06-57-52-{TID}.jsonl");
        let f = c.classify(&rel).unwrap();
        assert_eq!(f.canonical, format!("sessions/{TID}.jsonl"));
        assert_eq!(f.session_id, TID);
        assert!(f.transcript);
        assert_eq!(f.kind, AgentFileKind::Log);
        let no = [
            "auth.json".to_string(),
            "installation_id".into(),
            "config.toml".into(),
            "history.jsonl".into(),
            "session_index.jsonl".into(),
            "state_5.sqlite".into(),
            "state_5.sqlite-wal".into(),
            "logs_2.sqlite".into(),
            "models_cache.json".into(),
            format!("thread-writer-locks/{TID}.lock"),
            "shell_snapshots/x.sh".into(),
            "log/codex-tui.log".into(),
            format!("sessions/2026/10/25/rollout-2026-10-25T06-57-52-{TID}.jsonl.zst"),
            format!("sessions/2026/10/25/rollout-2026-10-25T06-57-52-{TID}_0199.jsonl"),
            format!("archived_sessions/rollout-2026-10-25T06-57-52-{TID}.jsonl"),
            format!("sessions/2026/10/rollout-2026-10-25T06-57-52-{TID}.jsonl"),
            format!("sessions/2026/10/25/rollout-2026-10-25-{TID}.jsonl"),
            format!("sessions/26/10/25/rollout-2026-10-25T06-57-52-{TID}.jsonl"),
            "sessions/2026/10/25/rollout-2026-10-25T06-57-52-nope.jsonl".into(),
            format!("sessions/2026/10/25/.rollout-2026-10-25T06-57-52-{TID}.jsonl"),
        ];
        for r in no {
            assert!(c.classify(&r).is_none(), "{r} must not sync");
        }
    }

    #[test]
    fn meta_identity_and_resume() {
        let map = PathMap::new(Path::new("/Users/fab"), &[]);
        let lines = [
            format!(r#"{{"timestamp":"2026-10-25T09:57:52.100Z","type":"session_meta","payload":{{"id":"{TID}","timestamp":"2026-10-25T09:57:52.000Z","cwd":"/Users/fab/p","originator":"codex_cli_rs","cli_version":"0.162.1","source":"cli","model_provider":"openai","git":{{"commit_hash":"abc","branch":"main"}}}}}}"#),
            r#"{"timestamp":"2026-10-25T09:57:53.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/Users/fab/p</cwd>\n</environment_context>"}]}}"#.to_string(),
            r#"{"timestamp":"2026-10-25T09:57:53.500Z","type":"turn_context","payload":{"cwd":"/Users/fab/p","model":"gpt-6-codex"}}"#.to_string(),
            r#"{"timestamp":"2026-10-25T09:57:54.000Z","type":"event_msg","payload":{"type":"user_message","message":"add tests to /Users/fab/p/lib.rs"}}"#.to_string(),
        ];
        let head = lines.join("\n") + "\n";
        let c = Codex::with_root("/r".into());
        let m = c.parse_meta(TID, head.as_bytes(), b"", &map).unwrap();
        assert_eq!(m.cwd.as_deref(), Some("@@UC_HOME@@/p"));
        assert_eq!(m.git_branch.as_deref(), Some("main"));
        assert_eq!(m.model.as_deref(), Some("gpt-6-codex"));
        assert_eq!(
            m.first_prompt.as_deref(),
            Some("add tests to @@UC_HOME@@/p/lib.rs")
        );
        assert!(m.title.is_none());
        assert_eq!(m.created_at, Some(1_792_922_272_000));
        assert_eq!(m.updated_at, Some(1_792_922_274_000));
        // byte-exact lines
        assert_eq!(c.clean_line(&lines[0], &map), lines[0]);
        assert_eq!(c.smudge_line("@@UC_HOME@@/x", &map), "@@UC_HOME@@/x");
        assert_eq!(
            c.resume_argv(&m, Path::new("/home/fab/p")),
            vec!["codex", "resume", "-C", "/home/fab/p", TID]
        );
    }

    #[test]
    fn native_rel_prefers_hint() {
        let c = Codex::with_root("/r".into());
        let map = PathMap::new(Path::new("/h"), &[]);
        let canon = format!("sessions/{TID}.jsonl");
        let hint = format!("sessions/2026/10/25/rollout-2026-10-25T06-57-52-{TID}.jsonl");
        let mut m = SessionMeta {
            agent: "codex".into(),
            id: TID.into(),
            native_rel: Some(hint.clone()),
            created_at: Some(1_792_922_272_000),
            ..Default::default()
        };
        assert_eq!(c.native_rel(&canon, Some(&m), &map).unwrap(), hint);
        // a hint for another id is ignored; fallback derives from created_at (local time)
        m.native_rel = Some(hint.replace(TID, "019a1b2c-3d4e-7f60-8a9b-ffffffffffff"));
        let fb = c.native_rel(&canon, Some(&m), &map).unwrap();
        assert!(
            c.classify(&fb).is_some_and(|f| f.canonical == canon),
            "{fb}"
        );
        assert!(c.native_rel(&canon, None, &map).is_none());
    }

    #[test]
    fn writer_lock_probe() {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let c = Codex::with_root(dir.path().to_path_buf());
        assert!(!c.is_live(TID));
        let locks = dir.path().join("thread-writer-locks");
        std::fs::create_dir_all(&locks).unwrap();
        std::fs::write(locks.join(".coordination.lock"), b"").unwrap();
        let f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(locks.join(format!("{TID}.lock")))
            .unwrap();
        assert!(!c.is_live(TID), "lock file without a holder is not live");
        assert!(try_flock(&f).unwrap());
        assert!(c.is_live(TID));
        unlock(&f);
        assert!(!c.is_live(TID));
    }
}
