//! `uc sessions` (DESIGN §6, §7).

use anyhow::{Context, Result};
use std::path::Path;

use super::output::{self, c, cc, emit_json, note, outln, Color, Table, EXIT_OK};
use super::{util, App, SessionsArgs};
use crate::paths;
use crate::proto::{Query, SessionInfo};

/// The session ran in `dir`, or `dir` is inside the session's directory.
pub(crate) fn session_in_dir(s: &SessionInfo, dir: &Path) -> bool {
    s.local_cwd
        .as_deref()
        .is_some_and(|lc| util::is_within(dir, Path::new(lc)))
}

pub fn cmd_sessions(app: &App, a: SessionsArgs) -> Result<i32> {
    let cfg = app.connect()?;
    // --here filters locally, so ask for more and cut after filtering
    let fetch = if a.here { a.limit.max(2000) } else { a.limit };
    let mut list: Vec<SessionInfo> = app.query(Query::Sessions {
        agent: a.agent.clone(),
        machine: a.machine.clone(),
        text: a.query.clone(),
        limit: Some(fetch),
    })?;
    if a.here {
        let cwd = std::env::current_dir().context("the current directory is not accessible")?;
        list.retain(|s| session_in_dir(s, &cwd));
        list.truncate(a.limit as usize);
    }
    if app.json {
        emit_json(&list);
        return Ok(EXIT_OK);
    }
    if list.is_empty() {
        outln!("no sessions found");
        if a.here {
            note("hint: --here only shows sessions started in this folder (or a parent of it); try without --here");
        }
        return Ok(EXIT_OK);
    }
    sessions_table(&list, paths::now_ms(), &cfg.machine_id).print();
    note("continue one in its folder: claude --resume <id> · codex resume --all");
    Ok(EXIT_OK)
}

/// `…/tail/of/a/long/path`
fn truncate_left(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max || max < 2 {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - (max - 1)).collect();
    format!("…{tail}")
}

pub(crate) fn sessions_table(list: &[SessionInfo], now: i64, my_machine_id: &str) -> Table {
    let mut t = Table::new(&[" ", "AGENT", "ID", "MACHINE", "UPDATED", "DIR", "TITLE"]);
    for s in list {
        let machine = match (&s.owner, &s.owner_name) {
            (Some(o), _) if o == my_machine_id => "this machine".to_string(),
            (_, Some(n)) => n.clone(),
            (Some(o), None) => o.clone(),
            (None, None) => "-".to_string(),
        };
        let updated = s.meta.updated_at.unwrap_or(now - s.idle_ms);
        let dir = s
            .local_cwd
            .as_deref()
            .map(|d| paths::tilde(Path::new(d)))
            .or_else(|| s.meta.cwd.clone())
            .unwrap_or_else(|| "-".into());
        let title = [s.meta.title.as_deref(), s.meta.first_prompt.as_deref()]
            .into_iter()
            .flatten()
            .find(|t| !t.trim().is_empty())
            .unwrap_or("");
        t.row(vec![
            if s.live {
                cc("●", Color::Green)
            } else {
                c(" ")
            },
            c(s.meta.agent.clone()),
            cc(output::short_id(&s.meta.id), Color::Cyan),
            c(machine),
            c(output::rel_time(now, updated)),
            c(truncate_left(&dir, 32)),
            c(title.to_string()),
        ]);
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::SessionMeta;

    fn s(id: &str, title: &str, cwd: Option<&str>) -> SessionInfo {
        SessionInfo {
            space: "@claude".into(),
            path: format!("sessions/{id}.jsonl"),
            meta: SessionMeta {
                agent: "claude".into(),
                id: id.into(),
                title: Some(title.into()),
                updated_at: Some(1_000_000),
                ..Default::default()
            },
            owner: Some("m_other".into()),
            owner_name: Some("linux-box".into()),
            live: false,
            idle_ms: 0,
            size: 1,
            version: 1,
            local_cwd: cwd.map(str::to_string),
            local: true,
        }
    }

    #[test]
    fn table_rows() {
        let mut live = s("0123456789", "a title", Some("/x/y"));
        live.live = true;
        let mine = SessionInfo {
            owner: Some("m_me".into()),
            ..s("fedcba9876", "", None)
        };
        let out = sessions_table(&[live, mine], 1_000_000, "m_me").render(200, false);
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].contains("AGENT") && lines[0].contains("TITLE"));
        assert!(
            lines[1].starts_with("●  claude  01234567  linux-box"),
            "{}",
            lines[1]
        );
        assert!(lines[1].ends_with("/x/y  a title"), "{}", lines[1]);
        assert!(lines[2].contains("this machine"), "{}", lines[2]);
        assert_eq!(truncate_left("/a/very/long/path", 8), "…ng/path");
    }
}
