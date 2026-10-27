---
name: uc
description: Use ultracontext (`uc`) to see and continue agent sessions across machines. Use when the user mentions another machine (laptop, desktop, Linux box, server), another or previous session, continuing/resuming work started elsewhere, "what did the other agent do", handing off to another machine, or ultracontext.
---
<!-- uc-skill: managed by 'uc init'; delete this line to keep your own edits -->

# uc: agent sessions that follow you

## Mental model

- One **hub** (an always-on box) is the single source of truth. Every machine runs a `uc`
  daemon that keeps Claude Code and Codex sessions the same everywhere, in real time.
- A session started on one machine can be continued on another: same id, same transcript,
  paths rewritten for this machine (by home folder).
- **uc never syncs code.** Each machine has its own checkout; code moves with git. A
  session continued elsewhere only sees what was pushed.
- Never edit, move or delete anything under `~/.ultracontext` (uc's own state).

## Commands (always add `--json` when you parse the output)

```sh
uc status --json            # hub link, pending ↑/↓, diverged sessions, live sessions
uc sessions --json          # every session on every machine, newest first
uc sessions --here --json   # sessions of the current project
uc sessions "auth bug" --json --limit 5
uc sync --json              # wait until every session line is pushed and pulled
uc doctor --json            # diagnose setup problems
```

Exit codes: `0` ok, `1` error, `2` usage error. With `--json`, stdout is exactly one JSON
document; errors look like `{"error":{"code":"offline","message":"...","hint":"..."}}`.

## Typical tasks

**"What did I / the other agent do on the other machine?"**
1. `uc sessions --json --limit 10`: find the session (fields: `meta.agent`, `meta.id`,
   `meta.title`, `meta.first_prompt`, `owner_name` = machine, `live`, `local_cwd`).
2. Read its transcript; it is already in this machine's agent folder.
3. For code changes, use git: `git fetch` and look at the branch the other machine pushed.

**Continue a session here**: sessions from every machine are already in the agents' own
folders. Tell the user to run `claude --resume <id>` (or `claude -c` in the project) or
`codex resume <id>` (`codex resume --all` to pick). Do not resume a session from inside
another agent session unless the user asks. If the session is still live on another machine
(`live: true`), continuing it here makes a fork; say so first.

**Before handing off or before the user closes the laptop**:
1. Commit and push your work with git, even unfinished (a WIP commit on the current
   branch), so the next machine can pull it. Ask before pushing if the user has not
   allowed it.
2. `uc sync --json` and check `"ok": true`. If `timed_out` is true, report `pending_up` /
   `pending_down` and run `uc status --json`.

**Picking up on this machine**: `git pull` (or check out the pushed branch) before
continuing, so the code matches what the transcript describes.

## Rules

- Keep each project at the same place under the home folder on every machine
  (`~/Code/app`), so transcript paths resolve everywhere.
- If a command fails with `offline` or `unreachable`, run `uc doctor --json` and report
  the failing checks with their `fix` hints instead of retrying in a loop.
