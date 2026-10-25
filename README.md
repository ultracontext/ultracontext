<div align="center">
  <h1>[•] ultracontext</h1>
  <h3>Context that goes beyond.</h3>
</div>

---

ultracontext is a Dropbox for developers and their agents. One small Rust binary, `uc`, keeps your folders and your Claude Code and Codex sessions the same on every machine, in real time.

Close the MacBook. Open the Linux box. Continue the same session:

```sh
cd ~/Code/myproject
uc resume            # or just: claude -c
```

## Why

You run many agents on many machines. Each machine keeps its own copy of everything: files, transcripts, half-finished work. Copy tools make duplicates, fight over which copy is right, and break files that an agent is still writing.

ultracontext fixes this with one rule: **the hub is the source of truth**.

- **One copy of each thing.** A session is stored once, by its id, no matter how many machines continue it. A file is stored once, by its content. When two machines make the same change, the result is one change and no duplicate.
- **Nothing is lost.**
  - When two machines change the same file, the hub keeps the first change. The other change becomes a conflict copy next to it: `notes.md.conflict-linux-20261025-141502`.
  - Every file uc overwrites or deletes on your disk goes to `~/.ultracontext/trash` for 30 days.
  - Every version stays on the hub (`uc history`, `uc restore`).
- **Safe with agents.**
  - uc never reads a half-written file, and never replaces a file while an agent may still be writing it.
  - A session has one writer at a time. If a second machine writes to it anyway, its lines become a fork with a new session id. They are never mixed into the original.

## Quickstart

**1. Install** on every machine, including the hub box:

```sh
curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/beyond/install.sh | sh
# or from source
cargo install --locked --git https://github.com/ultracontext/ultracontext --branch beyond --bin uc
```

**2. Pick a hub.** Any always-on box you can `ssh` into works. uc speaks its protocol over your existing SSH, so there are no ports to open and no certificates. The hub starts by itself on the first connection. To keep it running across reboots, run once on the hub box:

```sh
uc service install --hub
```

**3. Connect each machine:**

```sh
uc init you@hub-box        # or an ~/.ssh/config alias: uc init hub
uc service install         # start uc at login (launchd / systemd --user)
```

**4. Sync folders:**

```sh
uc add ~/Code              # appears at ~/Code on every machine that runs: uc init <hub> --yes
uc status
```

**5. Sessions follow you.** Claude Code and Codex sessions sync by themselves:

```sh
uc sessions                # every session, every machine, newest first (● = running now)
uc resume                  # newest session of this project, wherever it ran
uc resume 3f2a             # a session by id prefix or search text
```

Before you close the lid, you can run `uc sync`. It waits until everything is on the hub. The daemon already pushes every change as it happens, so this only confirms it.

## How sessions move

- **Paths are rewritten for each machine.** `/Users/you/Code/app` on the Mac becomes `/home/you/Code/app` on Linux. The resumed agent sees paths that exist on the machine it now runs on.
- **Claude Code** transcripts are written to the folder Claude itself uses for that project on that machine. Their mtime is the last activity, so `claude --continue` in the project picks the newest session from any machine.
- **Codex** rollouts are copied byte for byte, because Codex depends on exact byte offsets. uc runs them with `codex resume -C <local dir> <id>`.
- **A session is "live"** only while an awake machine is actually running it. That machine renews a 30-second lease on the hub.
  - When you close the laptop, the lease runs out and the session is free within 30 seconds.
  - `uc resume` on a live session asks you to **take over** (the other machine stops writing to it) or **fork** (you continue as a new session).
  - Agents pass `--takeover` or `--fork`.

## Branches: one folder per branch

A synced repo is one working copy on every machine. If your Mac Mini checks out another branch in `~/Code/app`, your MacBook's `~/Code/app` switches too, under whatever its agent is doing. uc warns when that happens. The fix is to give each branch its own folder:

```sh
cd ~/Code/app
uc branch feat/login        # creates ~/Code/app-feat-login (a git worktree), synced like the rest
```

Any machine can then work on any branch, and resume its sessions, without touching the others.

## Commands

| command | what it does |
|---|---|
| `uc init <hub>` | Connect this machine to a hub (`host`, `user@host`, `ssh://user@host:port`, `tcp://host:port`, `local`). |
| `uc add <dir>` / `uc rm <name>` | Start or stop syncing a folder. Stopping keeps the files. |
| `uc status` / `uc sync` | Show the hub link, pending work, conflicts and live sessions. `sync` waits until everything is pushed and pulled. |
| `uc sessions` / `uc resume` | List sessions from every machine, and continue one here. |
| `uc log` / `uc history <file>` / `uc restore <file>` | See who changed what, and get any version back. |
| `uc conflicts` | List conflict copies that need your decision. |
| `uc branch <name>` | Work on a branch in its own synced folder (a relative-path git worktree). |
| `uc doctor` | Find setup problems. |
| `uc service install [--hub]` | Start uc (or the hub) automatically. |

Every command takes `--json`, which prints exactly one JSON document for agents and scripts. Exit codes:

| code | meaning |
|---|---|
| 0 | ok |
| 1 | error |
| 2 | usage |
| 3 | busy or conflict |

See [docs/CLI.md](docs/CLI.md).

## For agents

`uc init` installs a skill for Claude Code and Codex (`skills/uc/SKILL.md`). With it, your agents can:

- find work from other machines: `uc sessions --json`
- see what other agents changed: `uc log --json --since 1h`
- make sure their work reached the hub before a handoff: `uc sync --json`

## What is synced and what is not

**Synced:**

- the folders you add, including `.git/` and your `.env` files
- Claude Code and Codex session transcripts and their sidecar files

`.env` files are synced on purpose, because your other machine needs them too.

**Never synced:**

- credentials (`.credentials.json`, `auth.json`) and live-process records
- agent databases, caches and shell snapshots
- dependency and build dirs: `node_modules`, `target`, `.venv`, `__pycache__`, `.next`, and so on
- SQLite `-wal` / `-shm` sidecar files and editor temp files
- anything your `.gitignore` or a `.ucignore` excludes

uc also refuses to do anything that would silently destroy data:

- If most files of a folder vanish at once (an unmounted disk, or a folder that was moved away), uc does not delete them on your other machines. If you really deleted them, run `touch <folder>/.uc-allow-deletes`.
- If the hub is restored from an older backup, sync stops with a clear message instead of overwriting newer local work. `uc init` re-joins safely.

Synced files get the current time when they are written, the same as `git checkout`, so `make` and `cargo` rebuild correctly.

## How it works

- **One binary, three roles:**
  - the hub (`uc hub serve`) keeps the change log, content-addressed blobs and session logs
  - one daemon per machine watches your folders and agent dirs, and keeps one connection to the hub
  - the CLI talks to the daemon
- **Folders sync with three states per file:**
  - **local**: what is on disk now
  - **base**: what this machine and the hub last agreed on
  - **remote**: what the hub has now

  Every change is a compare-and-swap on the hub, so two machines can never both "win".
- **Sessions are append-only logs keyed by session id.** Only new lines are sent, and paths are rewritten for each machine.

The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## Development

```sh
cargo test                       # unit tests + multi-machine e2e (hub + 2 machines on one box)
e2e/run.sh --with-mac            # Docker: hub + 2 Linux machines over ssh (+ this Mac over tcp)
cargo test real_agent_data -- --ignored --nocapture   # read-only check against your real agent data
```

## Status

v1 has these limits:

- macOS and Linux only.
- One user per hub.
- The hub stores your files without end-to-end encryption, so run it on a machine you trust.
- Codex rollouts older than 7 days, which Codex compresses (`.jsonl.zst`), are not synced yet.
