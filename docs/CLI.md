# uc command reference

`uc` is the hub, the per-machine daemon and the CLI in one binary (see [DESIGN.md](DESIGN.md)).
The CLI talks to the local daemon over `$UC_HOME/daemon.sock` and starts it when needed.

## Conventions

- `--json` (any position) prints exactly **one JSON document** on stdout and nothing on
  stderr. Use it from agents and scripts.
- Human output is short and aligned; colors only when stdout is a terminal and `NO_COLOR` is
  unset. Progress notes and prompts go to stderr.
- Errors: `uc: <message>` + `hint: <what to do>` on stderr. With `--json`:
  ```json
  {"error": {"code": "offline", "message": "not connected to the hub (...)", "hint": "run 'uc doctor'", "exit_code": 1}}
  ```
  Codes: `usage`, `not_initialized`, `unreachable` (no daemon), `timeout`, `offline` (no hub),
  `busy`, `conflict`, `not_found`, `invalid`, `exists`, `cwd_missing`, `exec`, `error`.
- Exit codes: `0` ok, `1` error, `2` usage error, `3` busy/conflict.
- Paths given to `log`, `history` and `restore` are local paths (relative to the current
  directory, `~` allowed); they must be inside a synced folder.
- Environment: `UC_HOME` (state, default `~/.ultracontext`), `UC_LOG` (log filter, default
  `info`), `UC_SSH` (ssh command prefix), `UC_TOKEN` (tcp token), `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `NO_COLOR`.

## Setup

### `uc init [HUB] [--name NAME] [--yes] [--remote-uc PATH] [--no-agents]`

Creates `$UC_HOME/config.toml`, installs the agent skill (into `~/.claude/skills/uc/` and
`~/.codex/skills/uc/` when those dirs exist; edited copies are kept), starts the daemon,
waits up to 15 s for the hub, then offers to join each hub space at its default path.
`--yes` joins all; without a terminal and without `--yes` nothing is joined (the output
says how). Without `HUB`: prompts on a terminal, keeps the configured hub otherwise, or
fails with exit 2. Switching to a different hub resets this machine's sync state (the old
`client.db` is kept next to it); files are never touched.

```sh
uc init myserver            # ssh host alias (uses your ssh config and keys)
uc init me@10.0.0.5 --yes   # join every space without asking
uc init local               # this machine is the hub
uc init tcp://hub:7707      # LAN/tests; token from UC_TOKEN or config
```

JSON: `{machine: MachineInfo, hub, config, connected, hub_version, joined: [SpaceStatus], available: [SpaceInfo], skills: [{agent, path, action}]}`

### `uc add <DIR> [--name NAME]`

Syncs a folder (created if missing) as a new space, or maps an existing hub space to this
folder with `--name`. The name defaults to the folder name (lowercased, spaces to `-`).
Refuses `$HOME` itself, `/`, uc's own state dir, agent dirs, and folders nested in another
space. JSON: `SpaceStatus`.

```sh
uc add ~/Code
uc add ~/work/code --name code   # same space, different place on this machine
```

### `uc rm <NAME>`

Stops syncing a space on this machine. Local files stay. JSON: `{removed, path}`.

### `uc spaces`

Every hub space and where it lives here. JSON: `[{name, default_path, local_path, synced_here, files, bytes, pending_up, pending_down}]`
(`default_path` is null when the hub is unreachable).

## Everyday

### `uc status`

Hub link, machine, spaces, pending work, conflicts, live sessions. JSON: `StatusReport`.

### `uc sync [--timeout S]`

Rescans and waits until everything is pushed and pulled (default 120 s). Exit 1 when it
timed out. Run it before closing the lid or handing off to another machine.
JSON: `SyncReport`.

### `uc sessions [QUERY] [--agent A] [--machine M] [--here] [--limit N]`

Claude Code and Codex sessions from every machine, newest first. `QUERY` matches id, title,
first prompt or directory. `--here`: only sessions whose directory is the current
directory or one of its parents. JSON: `[SessionInfo]`.

```
   AGENT   ID        MACHINE       UPDATED   DIR            TITLE
●  claude  1a2b3c4d  linux-box     2m ago    ~/Code/api     fix the login redirect
   codex   9f8e7d6c  this machine  3h ago    ~/Code/web     add dark mode
```

### `uc resume [ID|QUERY] [--agent A] [--takeover|--fork] [--print]`

Target: exact id, then unique id prefix, then the newest text match. Without a target: the
newest session of the current directory (or a parent), else the newest overall. The daemon
materializes the transcript, claims it, and `uc` runs the agent in the session's directory
(`exec`). If the session is live on another machine (exit 3 without a terminal), choose
`--takeover` (this machine becomes the writer) or `--fork` (continue as a new session).
`--print` prints `cd '<dir>' && claude --resume <id>` instead. JSON: `ResumePlan` (never execs).

### `uc log [PATH] [--since 30m|2h|1d|1w] [--limit N]`

Recent changes: when, which machine, what. A folder path lists changes below it.
JSON: `[LogRecord]`.

### `uc history <PATH>`

Versions of a file, newest first. JSON: `[LogRecord]`.

### `uc restore <PATH> [--seq N]`

Restores a version as a new change (nothing is overwritten; the current version stays in
history). Default: the version before the current one. JSON: `{space, path, seq, restored_from: LogRecord}`.

### `uc conflicts`

Conflict copies in synced folders (from every machine). Resolve: read both, merge into the
original, delete the copy. JSON: `[{space, path, local_path, original}]`.

### `uc doctor`

Checks config, daemon, hub link, versions, inotify limit (Linux), autostart, `uc` on PATH,
free disk, agent dirs. Exit 1 if any check fails.
JSON: `{ok, checks: [{name, status: "ok"|"warn"|"fail", detail, fix?}]}`.

## Daemon, service, hub

| command | what |
|---|---|
| `uc daemon run` | run in the foreground (logs to stderr) |
| `uc daemon start` | start in the background if needed (logs to `$UC_HOME/logs/daemon.log`) |
| `uc daemon stop` | graceful stop (falls back to SIGTERM) |
| `uc daemon status` | exit 0 if running, 1 if not. JSON: `{running, pid, version, uptime_s, connected, log}` |
| `uc service install [--hub]` | launchd agent (`dev.ultracontext.daemon` / `.hub`) or systemd user unit (`uc.service` / `uc-hub.service`), restarted on failure. On headless Linux also run `loginctl enable-linger $USER` |
| `uc service uninstall [--hub]` | stop and remove it |
| `uc hub serve [--tcp ADDR] [--detach]` | run the hub; `--tcp` requires `UC_TOKEN` |
| `uc hub connect` | stdio bridge to the local hub (what clients run over ssh) |

## JSON shapes (from `src/proto.rs`)

```text
StatusReport { machine: MachineInfo?, hub, connected, hub_version?, cursor, head_seq,
               spaces: [SpaceStatus], pending_up, pending_down, conflicts: [string],
               sessions_live: [SessionInfo], last_error?, daemon_pid, daemon_version, uptime_s }
SpaceStatus  { name, path, files, pending_up, pending_down, case_collisions: [string] }
SyncReport   { ok, timed_out, pending_up, pending_down, conflicts: [string], head_seq, cursor }
SessionInfo  { space, path, meta: SessionMeta, owner?, owner_name?, live, idle_ms, size,
               version, local_cwd?, local }
SessionMeta  { agent, id, cwd?, title?, first_prompt?, created_at?, updated_at?, git_branch?,
               model?, native_rel?, forked_from?, lines? }       (times: ms since epoch)
ResumePlan   { agent, id, cwd, argv: [string], native_path, took_over, forked_to?, cwd_missing }
LogRecord    { seq, op: put|delete|append|reset|claim, at, space, path, kind, hash, size,
               origin, origin_name }
MachineInfo  { id, name, os, home }
SpaceInfo    { name, default_path, created_at, files, bytes }
```

