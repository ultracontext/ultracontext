---
name: uc
description: Use ultracontext (`uc`) to see and continue work across machines and agent sessions. Use when the user mentions another machine (laptop, desktop, Linux box, server), another or previous session, continuing/resuming work started elsewhere, "what did the other agent do", syncing files, conflicts, or ultracontext.
---
<!-- uc-skill: managed by 'uc init'; delete this line to keep your own edits -->

# uc: folders and agent sessions that follow you

## Mental model

- One **hub** (an always-on box) is the single source of truth. Every machine runs a `uc`
  daemon that keeps synced folders identical everywhere, in real time.
- Claude Code and Codex **sessions sync too**: a session started on one machine can be
  continued on another, same id, same transcript, paths rewritten for this machine.
- Nothing is silently lost: older versions stay on the hub (`uc history`, `uc restore`),
  and when two machines edit the same file the hub's version wins and the other edit is
  kept as a **conflict copy** next to it.
- Never edit, move or delete anything under `~/.ultracontext` (uc's own state).

## Commands (always add `--json` when you parse the output)

```sh
uc status --json            # hub link, pending ↑/↓, conflicts, live sessions
uc sessions --json          # every session on every machine, newest first
uc sessions --here --json   # sessions of the current project
uc sessions "auth bug" --json --limit 5
uc log --json --since 1h    # who changed which files recently, from which machine
uc log src/ --json          # recent changes under a folder
uc history path/to/file --json
uc conflicts --json
uc sync --json              # wait until everything is pushed and pulled
uc resume <id> --print      # the shell command that continues a session here
uc doctor --json            # diagnose setup problems
```

Exit codes: `0` ok, `1` error, `2` usage error, `3` busy/conflict. With `--json`, stdout is
exactly one JSON document; errors look like
`{"error":{"code":"offline","message":"...","hint":"..."}}`.

## Typical tasks

**"What did I / the other agent do on the other machine?"**
1. `uc sessions --json --limit 10`: find the session (fields: `meta.agent`, `meta.id`,
   `meta.title`, `meta.first_prompt`, `owner_name` = machine, `live`, `local_cwd`).
2. `uc log --json --since 2h`: the files that changed and on which machine (`origin_name`).
3. Read the changed files directly; they are already synced into this machine's folders.

**Continue a session here**: run `uc resume <id> --print` and show the user the command.
Do not resume a session from inside another agent session unless the user asks. If uc
exits with code 3 the session is live on another machine: ask the user whether to
`--takeover` (the other machine stops writing it) or `--fork` (continue as a new session).

**Before handing off or before the user closes the laptop**: `uc sync --json` and check
`"ok": true`. If `timed_out` is true, report `pending_up` / `pending_down` and run
`uc status --json`.

**A file looks wrong or was lost**: `uc history <path> --json`, then
`uc restore <path> --seq <SEQ>` (the restore is a new change; nothing is overwritten).

## Conflicts

A conflict copy sits next to the original:
`notes.md.conflict-linux-box-20261025-141502`. To resolve:
1. Read both files completely.
2. Merge the wanted changes into the original (the path without `.conflict-...`).
3. Delete the conflict copy. Deleting it syncs everywhere.

Never delete or overwrite a conflict copy you have not read. Inside `.git/` a conflict
copy of a ref is a valid ref (`main.conflict-...`): `git log` it to see the other side.

## Branches

A synced repo is one checkout on every machine. Never `git checkout` another branch in a
synced repo another machine may be working in: run `uc branch <name>` and work in the
new folder it prints (`<repo>-<name>`, a worktree with relative paths).

## Rules

- Synced folders are live on all machines: edits appear on the other machines within
  seconds. Do not create large scratch files inside synced folders; use `/tmp`.
- `.env`, `.env.*` and `.envrc` are synced on purpose (even when gitignored).
  `node_modules/`, `target/`, `.venv/` and similar are never synced.
- Add a folder with `uc add <dir>`; stop syncing with `uc rm <name>` (files are kept).
  Ask the user before running either.
- If a command fails with `offline` or `unreachable`, run `uc doctor --json` and report
  the failing checks with their `fix` hints instead of retrying in a loop.
