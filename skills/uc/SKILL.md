---
name: uc
description: What ultracontext (`uc`) is, how it works, how to set it up, and how to use it to see and continue Claude Code / Codex sessions across machines. Use when the user mentions ultracontext or uc, another machine (laptop, desktop, Linux box, server), another or previous session, continuing/resuming work started elsewhere, "what did the other agent do", handing off to another machine, or setting up session sync.
---
<!-- uc-skill: managed by 'uc init'; delete this line to keep your own edits -->

# ultracontext (`uc`): agent sessions on every machine

## What it is

ultracontext keeps the user's Claude Code and Codex sessions the same on every machine, in
real time. A session started on the MacBook can be continued on the Linux box with the
agent's own resume (`claude -c`, `claude --resume`, `codex resume --all`): same id, same
transcript. It is one Rust binary, `uc`.

It does **not** sync code. Each machine has its own checkout; code moves with git. That is on
purpose: agents on different machines can work in the same repo without uc changing files
under them.

## How it works

- **Hub**: one always-on box (any host reachable over ssh) is the single source of truth.
  It stores each session once, as an append-only log keyed by session id. Clients reach it
  through `ssh <host> uc hub connect`; no ports, no certificates. It starts on demand.
- **Daemon**: every machine runs `uc daemon`. It watches `~/.claude` and `~/.codex`, pushes
  new transcript lines as they are written, and writes lines from other machines into the
  agents' own folders. Sessions active in the last 30 days are on every machine.
- **Paths**: the home folder is rewritten per machine (`/Users/fab/Code/app` on the Mac is
  `/home/fab/Code/app` on Linux), so projects must live at the same place under `$HOME`
  everywhere. Codex rollouts are copied byte for byte (their recorded cwd stays the
  original machine's, which is why Codex needs `--all`).
- **One writer per session**: the machine running a session holds a 30 s lease on the hub.
  A clean stop (`uc daemon stop`, logout, shutdown) releases it at once; a closed lid frees
  it within 30 s. If another machine writes to a session that is still live elsewhere, its
  lines become a **fork** (new session id, `meta.forked_from` = the original). Nothing is
  mixed or lost.
- **Never synced**: code folders, credentials (`.credentials.json`, `auth.json`), agent
  databases and caches.
- State lives in `~/.ultracontext` (config, client db, logs, trash). Never edit, move or
  delete anything there.

## Setup (for a machine that has no `uc` yet)

Ask the user before each step that touches another machine, installs a service, or picks
the hub. Run checks yourself.

1. **Is it installed?** `uc --version`. If not:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/beyond/install.sh | sh
   ```
   It installs to `~/.local/bin/uc` (make sure that is on `PATH`). With no prebuilt binary
   for the platform it builds from source and needs `cargo`
   (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`).
2. **Pick the hub** (ask the user): an always-on host they can ssh into, e.g. an
   `~/.ssh/config` alias. Check that ssh works without a prompt:
   `ssh -o BatchMode=yes <hub> true`. If this machine is the hub, use `local`.
3. **Install `uc` on the hub host too** (same installer, run there:
   `ssh <hub> 'curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/beyond/install.sh | sh'`).
   Optional but recommended, to survive reboots: `ssh <hub> '~/.local/bin/uc service install --hub'`
   (on Linux also `loginctl enable-linger $USER` there).
4. **Connect this machine**: `uc init <hub> --json`, then `uc service install` so the daemon
   starts at login (headless Linux: also `loginctl enable-linger $USER`).
5. **Verify**: `uc doctor --json` must have `"ok": true`; `uc status --json` must show
   `"connected": true`. Report any failing check with its `fix`.

Repeat steps 1, 4 and 5 on every other machine, with the same hub.

## Commands (always add `--json` when you parse the output)

```sh
uc status --json            # hub link, pending ↑/↓, diverged sessions, live sessions
uc sessions --json          # every session on every machine, newest first
uc sessions --here --json   # sessions of the current project
uc sessions "auth bug" --json --limit 5
uc sync --json              # wait until every session line is pushed and pulled
uc doctor --json            # diagnose setup problems
uc daemon stop | start      # stop hands this machine's sessions over at once
```

Exit codes: `0` ok, `1` error, `2` usage error. With `--json`, stdout is exactly one JSON
document; errors look like `{"error":{"code":"offline","message":"...","hint":"..."}}`.

## Typical tasks

**"What did I / the other agent do on the other machine?"**
1. `uc sessions --json --limit 10`: find the session (fields: `meta.agent`, `meta.id`,
   `meta.title`, `meta.first_prompt`, `owner_name` = machine, `live`, `local_cwd`).
2. Read its transcript; it is already in this machine's agent folder.
3. For code changes, use git: `git fetch` and look at the branch the other machine pushed.

**Continue a session here**: tell the user to run `claude --resume <id>` (or `claude -c` in
the project) or `codex resume <id>` (`codex resume --all` to pick). Do not resume a session
from inside another agent session unless the user asks. If the session is still live on
another machine (`live: true`), continuing it here makes a fork; say so first.

**Before handing off or before the user closes the laptop**:
1. Commit and push your work with git, even unfinished (a WIP commit on the current
   branch), so the next machine can pull it. Ask before pushing if the user has not
   allowed it.
2. `uc sync --json` and check `"ok": true`. If `timed_out` is true, report `pending_up` /
   `pending_down` and run `uc status --json`.

**Picking up on this machine**: `git pull` (or check out the pushed branch) before
continuing, so the code matches what the transcript describes.

## Troubleshooting

- `offline` / `unreachable`: run `uc doctor --json` and report the failing checks with their
  `fix` hints instead of retrying in a loop.
- `uc: not found on the hub host`: install uc on the hub, or `uc init <hub> --remote-uc /path/to/uc`.
- A session missing on this machine: older than 30 days, or the daemon is not running
  (`uc daemon status`).
- `uc status` lists a session under `diverged`: this machine wrote to a session another
  machine owned; its lines continue as the fork named there. Nothing to fix.
