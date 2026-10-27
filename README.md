<div align="center">
  <h1>[•] ultracontext</h1>
  <h3>Context that goes beyond.</h3>
</div>

---

ultracontext keeps your Claude Code and Codex sessions the same on every machine, in real time. It is one small Rust binary, `uc`.

Close the MacBook. Open the Linux box. Continue the same session:

```sh
cd ~/Code/myproject
claude -c            # or: claude --resume, codex resume --all
```

There is no special command. Your agents' own resume finds sessions from every machine. Your code moves the way it already does, with git, so agents on different machines never touch each other's files.

## Why

You run many agents on many machines. Each machine keeps its own sessions, so the conversation you had on the MacBook is gone when you open the Linux box. Copy tools make duplicates, fight over which copy is right, and break files that an agent is still writing.

ultracontext fixes this with one rule: **the hub is the source of truth**.

- **One copy of each session.** A session is stored once, by its id, no matter how many machines continue it.
- **Safe with agents.**
  - uc never reads a half-written line, and never replaces a transcript while an agent may still be writing it.
  - A session has one writer at a time. If a second machine writes to it anyway, its lines become a fork with a new session id. They are never mixed into the original.
- **Code stays yours.** uc never touches your code folders. Two agents can work in the same repo on two machines, on any branch, without uc moving a file under them.
- **Nothing is lost.** Every transcript uc replaces on your disk goes to `~/.ultracontext/trash` for 30 days.

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

**4. Sessions follow you.** Claude Code and Codex sessions sync by themselves, into the
folders the agents already use. Continue them with the agents' own commands:

```sh
claude -c                  # newest session of this project, wherever it ran
claude --resume            # pick one
codex resume --all         # Codex: --all, since the session's folder path differs per machine
uc sessions                # every session, every machine, newest first (● = running now)
```

Before you close the lid, you can run `uc sync`. It waits until everything is on the hub. The daemon already pushes every line as it happens, so this only confirms it.

**5. Code moves with git.** Commit and push before you switch machines, even a WIP commit, then pull on the other one. The uc skill tells your agents to do this before a handoff.

## How sessions move

- **Paths are rewritten for each machine.** Your home folder is swapped, so `/Users/you/Code/app` on the Mac becomes `/home/you/Code/app` on Linux. Keep each project at the same place under your home folder on every machine, and the resumed agent sees paths that exist where it now runs.
- **Claude Code** transcripts are written to the folder Claude itself uses for that project on that machine. Their mtime is the last activity, so `claude --continue` in the project picks the newest session from any machine.
- **Codex** rollouts are copied byte for byte, because Codex depends on exact byte offsets. Their recorded folder stays the original machine's, so `codex resume` lists them under `--all` (or pass the id).
- **Sessions from the last 30 days** are on every machine, the same window Claude Code keeps them.
- **Files don't move.** A session continued on another machine sees that machine's checkout: push your work first, or the agent may refer to edits that are not there.
- **A session is "live"** only while an awake machine is actually running it. That machine renews a 30-second lease on the hub.
  - `uc daemon stop`, logging out or shutting down hands the session over at once. Closing the lid frees it within 30 seconds.
  - If you continue a session while it is still live on another machine, nothing breaks: your new lines become a fork with a new session id, next to the original.

## Commands

| command | what it does |
|---|---|
| `uc init <hub>` | Connect this machine to a hub (`host`, `user@host`, `ssh://user@host:port`, `tcp://host:port`, `local`). |
| `uc status` / `uc sync` | Show the hub link, pending work and live sessions. `sync` waits until everything is pushed and pulled. |
| `uc sessions` | List sessions from every machine. Continue one with `claude --resume` / `codex resume`. |
| `uc doctor` | Find setup problems. |
| `uc service install [--hub]` | Start uc (or the hub) automatically. |

Every command takes `--json`, which prints exactly one JSON document for agents and scripts. Exit codes:

| code | meaning |
|---|---|
| 0 | ok |
| 1 | error |
| 2 | usage |

See [docs/CLI.md](docs/CLI.md).

## For agents

`uc init` installs a skill for Claude Code and Codex (`skills/uc/SKILL.md`). With it, your agents can:

- find work from other machines: `uc sessions --json`
- hand off cleanly: push the code with git, then `uc sync --json`

## What is synced and what is not

**Synced:** Claude Code and Codex session transcripts and their sidecar files (`~/.claude`, `~/.codex`).

**Never synced:**

- your code folders: use git
- credentials (`.credentials.json`, `auth.json`) and live-process records
- agent databases, caches and shell snapshots
- SQLite `-wal` / `-shm` sidecar files and editor temp files

If the hub is restored from an older backup, sync stops with a clear message instead of overwriting newer local work. `uc init` re-joins safely.

## How it works

- **One binary, three roles:**
  - the hub (`uc hub serve`) keeps the change log and the session logs
  - one daemon per machine watches the agent dirs, and keeps one connection to the hub
  - the CLI talks to the daemon
- **Sessions are append-only logs keyed by session id.** Only new lines are sent, and paths are rewritten for each machine.
- **Every append is checked on the hub** against what the writer last saw, so two machines can never both extend a session.

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
- The hub stores your sessions without end-to-end encryption, so run it on a machine you trust.
- Codex rollouts older than 7 days, which Codex compresses (`.jsonl.zst`), are not synced yet.
