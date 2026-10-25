//! `uc sessions` and `uc resume` (DESIGN §6, §7).

use anyhow::Result;
use std::path::Path;

use super::output::{
    self, c, cc, emit_json, note, outln, CliError, Color, Table, EXIT_BUSY, EXIT_OK,
};
use super::{util, App, ResumeArgs, SessionsArgs};
use crate::client::control;
use crate::paths;
use crate::proto::{Ctl, Query, ResumePlan, SessionInfo};

/// Materializing a long transcript over a slow link can take a while.
const RESUME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

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
        let cwd = super::cwd()?;
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

/// Pick a session for `uc resume <target>` from the hub's text matches (newest first):
/// exact id, then unique id prefix, then the newest text match.
/// Returns the session and an optional note for the user.
pub(crate) fn pick_by_target(
    list: &[SessionInfo],
    target: &str,
) -> Result<(SessionInfo, Option<String>), CliError> {
    let t = target.to_lowercase();
    if let Some(s) = list.iter().find(|s| s.meta.id.to_lowercase() == t) {
        return Ok((s.clone(), None));
    }
    let prefixed: Vec<&SessionInfo> = list
        .iter()
        .filter(|s| s.meta.id.to_lowercase().starts_with(&t))
        .collect();
    match prefixed.as_slice() {
        [one] => return Ok(((*one).clone(), None)),
        [] => {}
        many => {
            let ids: Vec<String> = many
                .iter()
                .take(5)
                .map(|s| format!("{} ({})", s.meta.id, s.meta.agent))
                .collect();
            return Err(
                CliError::usage(format!("'{target}' matches {} session ids", many.len()))
                    .hint(format!("use a longer prefix: {}", ids.join(", "))),
            );
        }
    }
    match list.first() {
        Some(s) => {
            let note = (list.len() > 1).then(|| {
                format!(
                    "{} sessions match '{target}'; resuming the most recent (pass an id to pick another: uc sessions \"{target}\")",
                    list.len()
                )
            });
            Ok((s.clone(), note))
        }
        None => Err(
            CliError::new("not_found", format!("no session matches '{target}'"))
                .hint("list them: uc sessions"),
        ),
    }
}

/// `uc resume` without a target: the newest session of this folder, else the newest overall.
pub(crate) fn pick_default(
    list: &[SessionInfo],
    cwd: &Path,
) -> Result<(SessionInfo, Option<String>), CliError> {
    if let Some(s) = list.iter().find(|s| session_in_dir(s, cwd)) {
        return Ok((s.clone(), None));
    }
    match list.first() {
        Some(s) => Ok((
            s.clone(),
            Some("no session of this folder; resuming the most recent one".to_string()),
        )),
        None => Err(CliError::new("not_found", "no sessions yet")
            .hint("sessions appear once Claude Code or Codex has run on a synced machine")),
    }
}

/// `cd '<cwd>' && <argv>` for --print.
pub(crate) fn shell_command(plan: &ResumePlan) -> String {
    let argv: Vec<String> = plan.argv.iter().map(|a| util::sh_quote(a)).collect();
    format!("cd {} && {}", util::sh_quote(&plan.cwd), argv.join(" "))
}

pub fn cmd_resume(app: &App, a: ResumeArgs) -> Result<i32> {
    let cfg = app.connect()?;
    let cwd = super::cwd()?;
    let (target, pick_note) = match &a.target {
        Some(t) => {
            let list: Vec<SessionInfo> = app.query(Query::Sessions {
                agent: a.agent.clone(),
                machine: None,
                text: Some(t.clone()),
                limit: Some(200),
            })?;
            pick_by_target(&list, t)?
        }
        None => {
            let list: Vec<SessionInfo> = app.query(Query::Sessions {
                agent: a.agent.clone(),
                machine: None,
                text: None,
                limit: Some(500),
            })?;
            pick_default(&list, &cwd)?
        }
    };
    if let (Some(n), false) = (&pick_note, app.json) {
        note(n);
    }
    let (mut takeover, mut fork) = (a.takeover, a.fork);
    let plan: ResumePlan = loop {
        let cmd = Ctl::Resume {
            agent: Some(target.meta.agent.clone()),
            id: target.meta.id.clone(),
            takeover,
            fork,
        };
        let err = match app.ctl::<ResumePlan>(cmd, RESUME_TIMEOUT) {
            Ok(p) => break p,
            Err(e) => e,
        };
        let busy = control::ctl_error(&err).is_some_and(|c| c.is_busy());
        if !busy || takeover || fork {
            return Err(err);
        }
        let who = target
            .owner_name
            .clone()
            .or(target.owner.clone())
            .unwrap_or_else(|| "another machine".into());
        if !util::interactive(app.json) {
            return Err(CliError::new(
                "busy",
                format!(
                    "session {} is live on {who} (active {}s ago); not resuming",
                    output::short_id(&target.meta.id),
                    target.idle_ms.max(0) / 1000
                ),
            )
            .exit(EXIT_BUSY)
            .hint("agents: pass --takeover (the other machine stops writing it) or --fork (continue as a new session)")
            .into());
        }
        let answer = util::prompt(&format!(
            "Session is live on {who} (active {}s ago). [t]ake over, [f]ork, [c]ancel? ",
            target.idle_ms.max(0) / 1000
        ))
        .unwrap_or_default()
        .to_lowercase();
        match answer.as_str() {
            "t" | "take" | "takeover" => takeover = true,
            "f" | "fork" => fork = true,
            _ => {
                note("cancelled");
                return Ok(EXIT_BUSY);
            }
        }
    };
    if app.json {
        emit_json(&plan);
        return Ok(EXIT_OK);
    }
    if a.print {
        outln!("{}", shell_command(&plan));
        return Ok(EXIT_OK);
    }
    if plan.argv.is_empty() {
        return Err(CliError::new(
            "internal",
            "the daemon returned an empty command for this session",
        )
        .into());
    }
    if plan.cwd_missing || !Path::new(&plan.cwd).is_dir() {
        return Err(CliError::new(
            "cwd_missing",
            format!(
                "the session's folder {} does not exist on this machine",
                paths::tilde(Path::new(&plan.cwd))
            ),
        )
        .hint(format!(
            "sync that folder here first (uc spaces / uc add <dir> --name <space>), or run it elsewhere: {}",
            shell_command(&plan)
        ))
        .into());
    }
    let from = match (&target.owner, &target.owner_name) {
        (Some(o), _) if *o == cfg.machine_id => "this machine".to_string(),
        (_, Some(n)) => n.clone(),
        (Some(o), None) => o.clone(),
        (None, None) => "the hub".to_string(),
    };
    let fork_note = plan
        .forked_to
        .as_deref()
        .map(|f| {
            format!(
                " (forked from {} as {})",
                output::short_id(&target.meta.id),
                output::short_id(f)
            )
        })
        .unwrap_or_default();
    note(&format!(
        "resuming {} session {} from {from} in {}{fork_note}",
        plan.agent,
        output::short_id(&plan.id),
        paths::tilde(Path::new(&plan.cwd))
    ));
    exec_plan(&plan)
}

fn exec_plan(plan: &ResumePlan) -> Result<i32> {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(&plan.argv[0])
        .args(&plan.argv[1..])
        .current_dir(&plan.cwd)
        .env("PWD", &plan.cwd)
        .exec();
    let hint = if err.kind() == std::io::ErrorKind::NotFound {
        format!(
            "is '{}' installed and on PATH? 'uc resume --print' shows the full command",
            plan.argv[0]
        )
    } else {
        "'uc resume --print' shows the full command".to_string()
    };
    Err(
        CliError::new("exec", format!("could not run '{}': {err}", plan.argv[0]))
            .hint(hint)
            .into(),
    )
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
    fn target_resolution_order() {
        let list = vec![
            s("aaaa1111-x", "fix aaaa bug", None),
            s("aaaa2222-y", "other", None),
            s("bbbb3333-z", "mentions aaaa1111-x", None),
        ];
        // exact id beats a (newer) text match
        let (got, note) =
            pick_by_target(&[list[2].clone(), list[0].clone()], "aaaa1111-x").unwrap();
        assert_eq!((got.meta.id.as_str(), note), ("aaaa1111-x", None));
        // unique prefix
        assert_eq!(
            pick_by_target(&list, "AAAA1").unwrap().0.meta.id,
            "aaaa1111-x"
        );
        // ambiguous prefix is a usage error listing candidates
        let e = pick_by_target(&list, "aaaa").unwrap_err();
        assert_eq!(e.exit, output::EXIT_USAGE);
        assert!(e.hint.unwrap().contains("aaaa2222-y"));
        // text: newest wins, with a note
        let texts = vec![s("c1", "login bug", None), s("c2", "login bug again", None)];
        let (got, note) = pick_by_target(&texts, "login").unwrap();
        assert_eq!(got.meta.id, "c1");
        assert!(note.unwrap().contains("2 sessions"));
        assert_eq!(pick_by_target(&[], "zzz").unwrap_err().code, "not_found");
    }

    #[test]
    fn default_prefers_this_folder() {
        let tmp = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(proj.join("src")).unwrap();
        let list = vec![
            s("newest", "elsewhere", Some("/somewhere/else")),
            s("mine", "here", Some(proj.to_str().unwrap())),
        ];
        assert_eq!(
            pick_default(&list, &proj.join("src")).unwrap().0.meta.id,
            "mine"
        );
        let (got, note) = pick_default(&list, tmp.path()).unwrap();
        assert_eq!(got.meta.id, "newest");
        assert!(note.is_some());
        assert_eq!(pick_default(&[], tmp.path()).unwrap_err().code, "not_found");
    }

    #[test]
    fn print_command_is_shell_safe() {
        let plan = ResumePlan {
            agent: "claude".into(),
            id: "abc".into(),
            cwd: "/Users/f/My Code/proj".into(),
            argv: vec!["claude".into(), "--resume".into(), "abc".into()],
            ..Default::default()
        };
        assert_eq!(
            shell_command(&plan),
            "cd '/Users/f/My Code/proj' && claude --resume abc"
        );
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
