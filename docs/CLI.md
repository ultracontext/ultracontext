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
  `not_found`, `invalid`, `error`.
- Exit codes: `0` ok, `1` error, `2` usage error.
- Environment: `UC_HOME` (state, default `~/.ultracontext`), `UC_LOG` (log filter, default
  `info`), `UC_SSH` (ssh command prefix), `UC_TOKEN` (tcp token), `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `NO_COLOR`.

## Setup

### `uc init [HUB] [--name NAME] [--remote-uc PATH] [--no-agents]`

Creates `$UC_HOME/config.toml`, installs the agent skill (into `~/.claude/skills/uc/` and
`~/.codex/skills/uc/` when those dirs exist; edited copies are kept), starts the daemon and
waits up to 15 s for the hub. Without `HUB`: prompts on a terminal, keeps the configured hub
otherwise, or fails with exit 2. Switching to a different hub resets this machine's sync
state (the old `client.db` is kept next to it); files are never touched.

```sh
uc init myserver            # ssh host alias (uses your ssh config and keys)
uc init me@10.0.0.5         # user@host
uc init local               # this machine is the hub
uc init tcp://hub:7707      # LAN/tests; token from UC_TOKEN or config
```

JSON: `{machine: MachineInfo, hub, config, connected, hub_version, skills: [{agent, path, action}]}`

uc syncs agent sessions only. Code moves with git: commit and push before switching
machines.

## Everyday

### `uc status`

Hub link, machine, pending work, diverged sessions, live sessions. JSON: `StatusReport`.

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

Continue a session with the agent itself: `claude --resume <id>`, `claude -c` in the
project, `codex resume <id>` or `codex resume --all`. Sessions from every machine are already
in the agents' native folders (last 30 days). Continuing one that is live on another machine
makes a fork (DESIGN §6.4).

### `uc doctor`

Checks config, daemon, hub link, versions, autostart, `uc` on PATH, free disk, agent dirs. Exit 1 if any check fails.
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
               pending_up, pending_down, conflicts: [string] (diverged sessions),
               sessions_live: [SessionInfo], last_error?, daemon_pid, daemon_version, uptime_s }
SyncReport   { ok, timed_out, pending_up, pending_down, conflicts: [string], head_seq, cursor }
SessionInfo  { space, path, meta: SessionMeta, owner?, owner_name?, live, idle_ms, size,
               version, local_cwd?, local }
SessionMeta  { agent, id, cwd?, title?, first_prompt?, created_at?, updated_at?, git_branch?,
               model?, native_rel?, forked_from?, lines? }       (times: ms since epoch)
MachineInfo  { id, name, os, home }
```

