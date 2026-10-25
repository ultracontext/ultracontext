//! Claude Code driver (DESIGN §6.6). Owner: sessions agent.
//!
//! Native layout ($CLAUDE_CONFIG_DIR or ~/.claude):
//! - `projects/<slug(cwd)>/<sid>.jsonl`                      transcript (log)
//! - `projects/<slug>/<sid>/subagents/agent-*.jsonl`         subagent transcripts (logs)
//! - `projects/<slug>/<sid>/subagents/agent-*.meta.json`, `subagents/workflows/**`,
//!   `tool-results/*`, `session-memory/summary.md`           write-once sidecars (files)
//! - `file-history/<sid>/*`                                  /rewind backups (files)
//!
//! Canonical: `sessions/<sid>.jsonl`, `sessions/<sid>/<same tail>`, `file-history/<sid>/<tail>`.
//! Claude resumes by walking uuid/parentUuid, not byte offsets, so whole-line path rewriting
//! (pathmap clean/smudge) is safe and makes cwd/file paths valid on the target machine.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{AgentDriver, AgentFile, AgentFileKind};
use crate::pathmap::PathMap;
use crate::proto::SessionMeta;

pub struct Claude {
    root: PathBuf,
}

impl Claude {
    /// root = $CLAUDE_CONFIG_DIR or ~/.claude
    pub fn from_env() -> Self {
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::paths::home().join(".claude"));
        Claude { root }
    }
    pub fn with_root(root: PathBuf) -> Self {
        Claude { root }
    }

    /// Is a Claude process running this session on this machine? Reads the live registry
    /// `sessions/<pid>.json` (never the `<pid>.*.key` secrets next to it).
    pub fn is_live(&self, session_id: &str) -> bool {
        is_live_in(&self.root, session_id)
    }
}

/// Liveness check against a Claude root (see [`Claude::is_live`]).
pub fn is_live_in(root: &Path, session_id: &str) -> bool {
    registry_state(root, session_id).is_some()
}

/// A running Claude process is WORKING on the session right now (registry `status` is not
/// "idle"). A window left open at an idle prompt does not count: it must not hold the session
/// against another machine for hours.
pub fn is_busy_in(root: &Path, session_id: &str) -> bool {
    registry_state(root, session_id).is_some_and(|status| status.as_deref() != Some("idle"))
}

/// `Some(status)` when a live process registered this session (status may be absent).
fn registry_state(root: &Path, session_id: &str) -> Option<Option<String>> {
    let Ok(rd) = std::fs::read_dir(root.join("sessions")) else {
        return None;
    };
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(data) = std::fs::read(e.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        if v.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        let pid = v
            .get("pid")
            .and_then(Value::as_i64)
            .or_else(|| stem.parse::<i64>().ok())
            .unwrap_or(0);
        if pid > 0 && pid <= i32::MAX as i64 && process_alive(pid as i32) {
            return Some(v.get("status").and_then(Value::as_str).map(str::to_string));
        }
    }
    None
}

/// kill(pid, 0): alive unless ESRCH (EPERM = exists, owned by someone else).
pub fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 performs only the existence/permission check.
    let r = unsafe { libc::kill(pid, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Claude's project dir name for a cwd: every UTF-16 code unit that is not [A-Za-z0-9]
/// becomes '-'; names longer than 200 get truncated + "-" + base36(|java_hash(path)|).
pub fn slug(path: &str) -> String {
    let units: Vec<u16> = path.encode_utf16().collect();
    let s: String = units
        .iter()
        .map(|&u| match u {
            0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a => u as u8 as char,
            _ => '-',
        })
        .collect();
    if s.len() <= 200 {
        return s;
    }
    let mut h: i32 = 0;
    for &u in &units {
        h = h.wrapping_shl(5).wrapping_sub(h).wrapping_add(u as i32);
    }
    format!("{}-{}", &s[..200], base36((h as i64).unsigned_abs()))
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Canonical 8-4-4-4-12 lowercase/uppercase hex UUID.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// A component we never sync: hidden/temp files and uc's own temp files.
fn junk(name: &str) -> bool {
    name.is_empty()
        || name.starts_with('.')
        || name.ends_with(".tmp")
        || name.ends_with('~')
        || name.contains(".uc-tmp-")
}

fn file(canonical: String, sid: &str, kind: AgentFileKind, transcript: bool) -> Option<AgentFile> {
    Some(AgentFile {
        canonical,
        session_id: sid.to_string(),
        kind,
        transcript,
    })
}

/// Parse complete JSON lines out of a window; drops a partial first/last line silently.
pub(crate) fn json_lines(buf: &[u8]) -> Vec<Value> {
    buf.split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_slice::<Value>(l).ok())
        .collect()
}

/// RFC 3339 timestamp -> ms since epoch.
pub(crate) fn ts_ms(v: &Value) -> Option<i64> {
    let s = v.get("timestamp")?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

pub(crate) fn clip(s: &str, max: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max {
        return t;
    }
    let mut out: String = t.chars().take(max).collect();
    out.push('…');
    out
}

/// Text a human typed, or None for tool results / injected context.
fn user_text(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if v.get("isMeta").and_then(Value::as_bool) == Some(true)
        || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || v.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|i| i.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
        return None;
    }
    Some(t.to_string())
}

impl AgentDriver for Claude {
    fn name(&self) -> &'static str {
        "claude"
    }
    fn space(&self) -> &'static str {
        "@claude"
    }
    fn root(&self) -> PathBuf {
        self.root.clone()
    }

    fn classify(&self, rel: &str) -> Option<AgentFile> {
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.iter().any(|p| junk(p)) {
            return None;
        }
        match parts.as_slice() {
            ["projects", _slug, name] => {
                let sid = name.strip_suffix(".jsonl")?;
                is_uuid(sid).then_some(())?;
                file(
                    format!("sessions/{sid}.jsonl"),
                    sid,
                    AgentFileKind::Log,
                    true,
                )
            }
            ["projects", _slug, sid, tail @ ..] if is_uuid(sid) && !tail.is_empty() => {
                let kind = match tail {
                    ["subagents", name]
                        if name.starts_with("agent-") && name.ends_with(".jsonl") =>
                    {
                        AgentFileKind::Log
                    }
                    ["subagents", name]
                        if name.starts_with("agent-") && name.ends_with(".meta.json") =>
                    {
                        AgentFileKind::File
                    }
                    ["subagents", "workflows", _, ..] => AgentFileKind::File,
                    ["tool-results", _] => AgentFileKind::File,
                    ["session-memory", "summary.md"] => AgentFileKind::File,
                    _ => return None,
                };
                file(
                    format!("sessions/{sid}/{}", tail.join("/")),
                    sid,
                    kind,
                    false,
                )
            }
            ["file-history", sid, _, ..] if is_uuid(sid) => {
                file(rel.to_string(), sid, AgentFileKind::File, false)
            }
            _ => None,
        }
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
            agent: "claude".into(),
            id: session_id.to_string(),
            ..Default::default()
        };
        m.created_at = all().find_map(ts_ms);
        m.updated_at = all().filter_map(ts_ms).max();
        let first_cwd =
            all().find_map(|v| v.get("cwd").and_then(Value::as_str).map(str::to_string));
        let relocated = all()
            .filter(|v| v.get("type").and_then(Value::as_str) == Some("relocated"))
            .filter_map(|v| v.get("relocatedCwd").and_then(Value::as_str))
            .next_back()
            .map(str::to_string);
        m.cwd = relocated.or(first_cwd).map(|c| map.clean(&c));
        m.git_branch = all()
            .filter_map(|v| v.get("gitBranch").and_then(Value::as_str))
            .filter(|b| !b.is_empty())
            .next_back()
            .map(str::to_string);
        m.model = all()
            .filter(|v| v.get("type").and_then(Value::as_str) == Some("assistant"))
            .filter_map(|v| v.get("message")?.get("model")?.as_str())
            .filter(|m| !m.starts_with('<'))
            .next_back()
            .map(str::to_string);
        // custom titles beat AI titles beat legacy summaries; the latest of each kind wins
        let latest = |ty: &str, field: &str| {
            all()
                .filter(|v| v.get("type").and_then(Value::as_str) == Some(ty))
                .filter_map(|v| v.get(field).and_then(Value::as_str))
                .filter(|s| !s.trim().is_empty())
                .next_back()
                .map(|s| clip(s, 200))
        };
        m.title = latest("custom-title", "customTitle")
            .or_else(|| latest("ai-title", "aiTitle"))
            .or_else(|| latest("summary", "summary"));
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
        if canonical.starts_with("file-history/") {
            return Some(canonical.to_string());
        }
        let rest = canonical.strip_prefix("sessions/")?;
        let cwd = map.smudge(meta?.cwd.as_deref()?);
        if !cwd.starts_with('/') {
            return None;
        }
        // Claude slugs the PHYSICAL cwd (a session started in /tmp lives in -private-tmp-...)
        let cwd = std::fs::canonicalize(&cwd)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(cwd);
        Some(format!("projects/{}/{}", slug(&cwd), rest))
    }

    fn fork_line(&self, line: &str, old_id: &str, new_id: &str) -> String {
        line.replace(old_id, new_id)
    }

    fn resume_argv(&self, meta: &SessionMeta, local_cwd: &Path) -> Vec<String> {
        let _ = local_cwd;
        vec!["claude".into(), "--resume".into(), meta.id.clone()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b9f2c1e-5d4a-4e8b-9c7d-1a2b3c4d5e6f";

    #[test]
    fn slug_matches_claude() {
        assert_eq!(slug("/Users/x/.claude/hooks"), "-Users-x--claude-hooks");
        assert_eq!(slug("/home/fabio/my_proj.v2"), "-home-fabio-my-proj-v2");
        // non-BMP char = two UTF-16 units = two dashes; BMP non-ASCII = one dash
        assert_eq!(slug("/a/😀/é"), "-a-----");
        let long = format!("/Users/fabio/{}", "a".repeat(250));
        let s = slug(&long);
        assert!(s.starts_with(&slug(&long)[..200]));
        assert_eq!(s.len(), 201 + base36(java(&long).unsigned_abs()).len());
        // known value: java "hello".hashCode() = 99162322
        assert_eq!(java("hello"), 99162322);
        assert_eq!(base36(99162322), "1n1e4y");
        assert_eq!(base36(0), "0");
        let p = format!("/{}", "b".repeat(220));
        assert_eq!(
            slug(&p),
            format!("-{}-{}", "b".repeat(199), base36(java(&p).unsigned_abs()))
        );
    }

    fn java(s: &str) -> i64 {
        let mut h: i32 = 0;
        for u in s.encode_utf16() {
            h = h.wrapping_mul(31).wrapping_add(u as i32);
        }
        h as i64
    }

    #[test]
    fn classify_table() {
        let c = Claude::with_root("/r".into());
        let yes = [
            (
                format!("projects/-Users-x-p/{SID}.jsonl"),
                format!("sessions/{SID}.jsonl"),
                AgentFileKind::Log,
                true,
            ),
            (
                format!("projects/-p/{SID}/subagents/agent-a1b2.jsonl"),
                format!("sessions/{SID}/subagents/agent-a1b2.jsonl"),
                AgentFileKind::Log,
                false,
            ),
            (
                format!("projects/-p/{SID}/subagents/agent-a1b2.meta.json"),
                format!("sessions/{SID}/subagents/agent-a1b2.meta.json"),
                AgentFileKind::File,
                false,
            ),
            (
                format!("projects/-p/{SID}/subagents/workflows/w1/run.json"),
                format!("sessions/{SID}/subagents/workflows/w1/run.json"),
                AgentFileKind::File,
                false,
            ),
            (
                format!("projects/-p/{SID}/tool-results/toolu_01.txt"),
                format!("sessions/{SID}/tool-results/toolu_01.txt"),
                AgentFileKind::File,
                false,
            ),
            (
                format!("projects/-p/{SID}/session-memory/summary.md"),
                format!("sessions/{SID}/session-memory/summary.md"),
                AgentFileKind::File,
                false,
            ),
            (
                format!("file-history/{SID}/abc123@v2"),
                format!("file-history/{SID}/abc123@v2"),
                AgentFileKind::File,
                false,
            ),
        ];
        for (rel, canon, kind, tr) in yes {
            let f = c.classify(&rel).unwrap_or_else(|| panic!("{rel}"));
            assert_eq!(
                (
                    f.canonical.as_str(),
                    f.kind,
                    f.transcript,
                    f.session_id.as_str()
                ),
                (canon.as_str(), kind, tr, SID),
                "{rel}"
            );
        }
        let no = [
            ".credentials.json".to_string(),
            "settings.json".into(),
            "settings.local.json".into(),
            "history.jsonl".into(),
            "projects/-p/memory/MEMORY.md".into(),
            format!("projects/-p/memory/{SID}.jsonl"),
            format!("sessions/{SID}.json"),
            "sessions/12345.json".into(),
            "sessions/12345.abcdef.key".into(),
            format!("session-env/{SID}/x"),
            "shell-snapshots/snap.sh".into(),
            format!("todos/{SID}.json"),
            "plans/p.md".into(),
            "statsig/x".into(),
            "ide/1234.lock".into(),
            "projects/-p/not-a-uuid.jsonl".into(),
            format!("projects/-p/{SID}.jsonl.bak"),
            format!("projects/-p/.{SID}.jsonl"),
            format!("projects/-p/{SID}.jsonl.uc-tmp-1"),
            format!("projects/-p/{SID}/subagents/other.jsonl"),
            format!("projects/-p/{SID}/random/file.txt"),
            format!("projects/{SID}.jsonl"),
            format!("file-history/{SID}"),
            "file-history/nope/x".into(),
            "projects/-p/x/y/z.jsonl".into(),
            "cache/x.db".into(),
            "a.sqlite".into(),
        ];
        for rel in no {
            assert!(c.classify(&rel).is_none(), "{rel} must not sync");
        }
    }

    #[test]
    fn parse_meta_head_tail() {
        let map = PathMap::new(
            Path::new("/Users/fab"),
            &[("code".into(), PathBuf::from("/Users/fab/Code"))],
        );
        let head = format!(
            "{}\n{}\n{}\n{}\n{{\"type\":\"user\",\"mess",
            r#"{"type":"file-history-snapshot","messageId":"m0","snapshot":{"trackedFileBackups":{}}}"#,
            format!(
                r#"{{"parentUuid":null,"isSidechain":false,"type":"user","message":{{"role":"user","content":"<command-name>/clear</command-name>"}},"uuid":"u1","timestamp":"2026-10-20T10:00:00.000Z","cwd":"/Users/fab/Code/proj","sessionId":"{SID}","gitBranch":"main"}}"#
            ),
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: meta"},"uuid":"u2","timestamp":"2026-10-20T10:00:01.000Z","cwd":"/Users/fab/Code/proj"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"fix the bug in /Users/fab/Code/proj/src/main.rs please"}]},"uuid":"u3","timestamp":"2026-10-20T10:00:02.000Z","cwd":"/Users/fab/Code/proj","gitBranch":"main"}"#,
        );
        let tail = format!(
            "ial\"}}\n{}\n{}\n{}\n",
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":[]},"uuid":"a1","timestamp":"2026-10-20T11:00:00.000Z","cwd":"/Users/fab/Code/proj","gitBranch":"feat/x"}"#,
            r#"{"type":"ai-title","aiTitle":"Fix main bug","sessionId":"s"}"#,
            r#"{"type":"custom-title","customTitle":"My title","sessionId":"s"}"#,
        );
        let c = Claude::with_root("/r".into());
        let m = c
            .parse_meta(SID, head.as_bytes(), tail.as_bytes(), &map)
            .unwrap();
        assert_eq!(m.agent, "claude");
        assert_eq!(m.id, SID);
        assert_eq!(m.cwd.as_deref(), Some("@@UC_SPACE:code@@/proj"));
        assert_eq!(
            m.first_prompt.as_deref(),
            Some("fix the bug in @@UC_SPACE:code@@/proj/src/main.rs please")
        );
        assert_eq!(m.title.as_deref(), Some("My title"));
        assert_eq!(m.git_branch.as_deref(), Some("feat/x"));
        assert_eq!(m.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(m.created_at, Some(1_792_490_400_000));
        assert_eq!(m.updated_at, Some(1_792_494_000_000));
        assert!(c.parse_meta(SID, b"garbage\n{", b"", &map).is_none());
    }

    #[test]
    fn relocation_and_native_rel() {
        let mac = PathMap::new(Path::new("/Users/fab"), &[]);
        let lin = PathMap::new(Path::new("/home/fab"), &[]);
        let head = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"hi"}},"timestamp":"2026-10-20T10:00:00Z","cwd":"/Users/fab/p","sessionId":"{SID}"}}"#
        ) + "\n";
        let tail = r#"{"type":"relocated","relocatedCwd":"/Users/fab/p/.worktrees/w1"}"#
            .to_string()
            + "\n";
        let c = Claude::with_root("/r".into());
        let m = c
            .parse_meta(SID, head.as_bytes(), tail.as_bytes(), &mac)
            .unwrap();
        assert_eq!(m.cwd.as_deref(), Some("@@UC_HOME@@/p/.worktrees/w1"));
        assert_eq!(
            c.native_rel(&format!("sessions/{SID}.jsonl"), Some(&m), &lin)
                .unwrap(),
            format!("projects/-home-fab-p--worktrees-w1/{SID}.jsonl")
        );
        assert_eq!(
            c.native_rel(
                &format!("sessions/{SID}/subagents/agent-1.jsonl"),
                Some(&m),
                &lin
            )
            .unwrap(),
            format!("projects/-home-fab-p--worktrees-w1/{SID}/subagents/agent-1.jsonl")
        );
        assert_eq!(
            c.native_rel(&format!("file-history/{SID}/x@v1"), None, &lin)
                .unwrap(),
            format!("file-history/{SID}/x@v1")
        );
        assert!(c
            .native_rel(&format!("sessions/{SID}.jsonl"), None, &lin)
            .is_none());
        assert_eq!(
            c.fork_line(&format!(r#"{{"sessionId":"{SID}"}}"#), SID, "new"),
            r#"{"sessionId":"new"}"#
        );
        assert_eq!(
            c.resume_argv(&m, Path::new("/x")),
            vec!["claude", "--resume", SID]
        );
    }

    #[test]
    fn liveness_registry() {
        let dir = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let c = Claude::with_root(dir.path().to_path_buf());
        assert!(!c.is_live(SID));
        std::fs::create_dir_all(dir.path().join("sessions")).unwrap();
        let me = std::process::id();
        std::fs::write(
            dir.path().join(format!("sessions/{me}.json")),
            format!(r#"{{"pid":{me},"sessionId":"{SID}"}}"#),
        )
        .unwrap();
        std::fs::write(dir.path().join(format!("sessions/{me}.abc.key")), "secret").unwrap();
        assert!(c.is_live(SID));
        assert!(!c.is_live("other"));
        // a dead pid does not count
        std::fs::write(
            dir.path().join("sessions/999999.json"),
            r#"{"pid":999999,"sessionId":"dead"}"#,
        )
        .unwrap();
        assert!(!c.is_live("dead"));
    }
}
