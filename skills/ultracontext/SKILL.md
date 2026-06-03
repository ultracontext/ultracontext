---
name: ultracontext
description: |
  ultracontext is the user's GLOBAL context layer: shared workspace state across every synced
  machine, AI agent, session, and indexed folder. Trigger immediately when the user references
  prior work, another agent, another machine, synced context, notes, history, or "ultracontext".

  Also handles setup: `uc init`, `uc sync`, `uc sync source`, `uc event`, `uc driver`, `uc doctor`.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# ultracontext

UltraContext is a shared filesystem context layer for agents. It does not answer for you. It gives you the synced workspace so *you* can inspect the right evidence and answer accurately. Revolutionary idea: files still exist.

## Mental model

You are one agent in a fleet. The user may also run Claude, Codex, OpenClaw, Hermes, and other tools on several machines. UltraContext mirrors those sources into one workspace tree on a hub, and exposes three primitives:

- **Files** — the archive. Everything that ever happened, mirrored by sync. You grep and read these.
- **Events** — the status board. Small immutable facts about *what changed, now* (`uc event tail`).
- **Contexts** — versioned conversational state an agent reads and writes (`uc create`/`append`/`get`).

Files are the past, events are the present, contexts are live state. Never assume there is only one machine. That is the whole point.

### Workspace layout

- Hub workspace root: `~/.ultracontext/workspace/`
- Layout: `workspace/<host>/<leaf>/...mirrored files`
  - `<host>` is one dir per machine (the host id, e.g. `laptop`, `mini`).
  - `<leaf>` is the **leaf of the source's local path**, not the source name. So the `claude` source at `~/.claude/projects` lands under `projects/`, not `.claude/`. Confirm the real leaf with `uc sync source list`.
- Config: `~/.ultracontext/config.json` (a legacy `config.toml` is auto-migrated on first `uc sync`, kept as `config.toml.migrated`).
- Ignores: `~/.ultracontext/ignores/.ultracontextignore` (global) and `~/.ultracontext/ignores/<source>/.ultracontextignore` (per-source).

## When to use UltraContext

Use it whenever the user references context that may live outside the current chat or repo:

- "what did we ship last week?"
- "where did Codex leave this?"
- "the Claude session on the macbook last night"
- "pick up the OpenClaw thread about X"
- "in my notes / docs / brain dump"
- "what agents have been doing?"
- "latest Codex session"

Do **not** use it for things clearly available in the current conversation or current repo. Use normal file/git inspection for that. Don't summon the interdimensional archive to read the file already open in front of you.

## Core retrieval strategy

1. Orient. Run `uc doctor` and `uc sync source list` to see the workspace root, this host, and the configured sources (with their real leaf dirs and enabled state). If a remote hub is configured, the canonical workspace lives on the hub, not just this machine.

2. Check the status board first. `uc event tail --limit 20` shows what changed recently across the fleet. For "what have agents been doing?", this is the fastest answer — each `*.session.updated` event carries a `payload_ref` pointing at the file with the detail.

3. Enumerate all relevant hosts. List matching `workspace/<host>/<leaf>/` folders across the workspace. Source-specific means *every* host for that source's leaf — never just the local machine.

4. Rank candidates by internal timestamps. Prefer JSONL/session metadata timestamps over file mtime; use mtime only as a fallback. Include the host name when multiple hosts match or when it clarifies where work happened.

5. Return evidence-backed context. Include file paths, agents, hosts, timestamps, session ids, and short excerpts when useful. If nothing clearly useful exists, say so. Never preserve secrets — redact tokens, credentials, cookies, signed URLs, and headers as `[REDACTED]`.

## Latest/recent requests

For "latest", "last", "newest", "recent", or "most recent":

- Do not rely on semantic relevance alone.
- Tail events (`uc event tail`) AND enumerate candidate sessions across all hosts and relevant agents.
- Inspect internal timestamps before deciding.
- For "latest thing we did", compare Codex, Claude, OpenClaw, Hermes, and event records when relevant.

## Codex fast path

Use this path for Codex recall. It is faster than brute-forcing every rollout first.

1. Start with every `workspace/<host>/<codex-leaf>/history.jsonl` (the `codex` source usually mirrors `~/.codex`).
   - Compact JSONL index with `session_id`, `ts` epoch seconds, and `text`.
   - Search exact terms, user wording, project names, and recent activity here first.

2. For latest/recent Codex activity:
   - Compare `history.jsonl` entries by `ts` across all hosts.
   - If history is sparse or missing, enumerate the newest `sessions/**/rollout-*.jsonl` and inspect the first `session_meta` line.

3. Map history hits to full transcripts:
   - Find `sessions/**/rollout-*<session_id>.jsonl`.
   - Open the rollout when details matter.

4. In Codex rollouts:
   - First line is usually `session_meta` with `payload.id`, `payload.timestamp`, `payload.cwd`, CLI version, and model provider.
   - User prompts appear in `event_msg` with `type=user_message` and in `response_item` messages with `role=user`.
   - Assistant replies, tool calls, command outputs, and errors appear later in `response_item` and `event_msg` records.
   - Skip giant system/developer instruction blobs unless the user asks about prompts, permissions, or agent setup.

5. Resume snapshots:
   - `resume/ctx_*.md` are compact resume snapshots. Use them for continue/context-transfer questions, but use rollouts for authoritative detail.

## Claude fast path

1. Start with every `workspace/<host>/<claude-leaf>/history.jsonl`.
   - Fields usually include `display`, `timestamp` epoch milliseconds, `project`, `sessionId`, and sometimes pasted content.

2. Map a hit to transcript:
   - Encode `project` like Claude does for project dirs: replace `/` and `.` with `-`.
   - Open `projects/<encoded-project>/<sessionId>.jsonl`.
   - If missing, search `projects/**/<sessionId>.jsonl`.

3. If history is sparse, scan `projects/**/*.jsonl` directly and rank by internal `timestamp`.

## OpenClaw fast path

1. Start with `agents/<agent-id>/sessions/sessions.json`.
   - Values may include `sessionId`, `sessionFile`, `label`, `status`, `spawnedBy`, `startedAt`, `updatedAt`, `endedAt`, `runtimeMs`.
   - Treat `updatedAt`, `startedAt`, and `endedAt` as epoch milliseconds.

2. Open referenced transcript:
   - `agents/<agent-id>/sessions/<session-id>.jsonl`.
   - If `sessionFile` is an absolute local path, map it into the synced workspace path.

3. For reset/deleted history, inspect siblings:
   - `<session-id>.jsonl.reset.<timestamp>`
   - `<session-id>.jsonl.deleted.<timestamp>`
   - `<session-id>.trajectory.jsonl`
   - `<session-id>.trajectory.jsonl.deleted.<timestamp>`
   - `<session-id>.trajectory-path.json`

## Contexts (versioned conversational state)

A context is live, versioned conversational state — distinct from the read-only file archive. Use these when the user wants to capture, fork, or replay a conversation rather than browse synced files.

```sh
uc create                                  # create a context; --from <id> forks; --meta <k=v> tags it (repeatable)
uc append <id> "text" --role user          # append a message (omit text for stdin; --message <json> for a raw object)
uc get <id>                                 # read a context; --history for version history
uc get <id> --version <n>                   # read a specific version (or --at <index> / --before <ts>)
uc update <id> --index <n> --content "..."  # edit a message in place (or --id <msg-id> to target by id)
uc delete <id> --ids <n...>                 # delete messages; bare `delete <id> --permanent` drops the whole context
uc delete <a> <b> --permanent               # batch-delete whole contexts
uc list                                      # list contexts; --source / --project_path / --limit filters
```

Most context verbs accept `UC_CONTEXT` instead of an explicit id. Add `--remote` (or configure a hosted backend) to talk to the hosted API instead of local SQLite.

## Events (the status board)

Events are small, immutable facts about what just changed. Tail them first when the user asks what agents have been doing.

```sh
uc event tail --limit 20                    # read the committed log (one JSON object per line)
uc event tail --kind claude.session.updated # filter by kind / --source / --subject
uc event tail --local                        # read THIS machine's db even with a remote hub
uc event status                              # pending vs committed counts
uc event flush                               # retry anything still pending
uc event emit --kind <k> --source <s> --subject <subj>   # record a small activity fact
```

Event rule: events carry small facts only — never raw prompts, full transcripts, secrets, cookies, tokens, headers, signed URLs, or huge payloads. Heavy content lives in files; an event points at it with `payload_ref` (a `file://` URL) + `payload_hash` (`sha256:`). `uc event commit --from-stdin` is the hub-side SSH transport target; you rarely call it directly.

## Sync (the file mirror)

`uc sync` orchestrates Mutagen sessions that mirror sources into the hub workspace. It moves bytes; it does not emit events or version state.

```sh
uc sync init <local|user@host[:root]>       # set the hub target; --host-id <id> overrides the host id
uc sync start                                # start syncing enabled sources
uc sync stop                                 # pause enabled sessions
uc sync status                               # live Mutagen session state
uc sync list                                 # configured sources + sync state
uc sync reset                                # terminate owned sessions and restart (after config/ignore edits)
uc sync source list                          # list configured sources
uc sync source add <name> <path>            # add an indexed folder; --disabled to add without starting
uc sync source remove <name>                # remove a source; --purge-remote also deletes its hub dir (DESTRUCTIVE)
uc sync source enable <name>                 # enable one source
uc sync source disable <name>                # disable one source
```

## Drivers (bring the outside world in)

A driver is a `driver.toml` manifest that teaches UltraContext to pull data out of a system it doesn't own (a web app, a phone, a SaaS) and turn it into files + events. Core stays vendor-free; the driver holds the side effects.

```sh
uc driver list                               # list installed manifests from ~/.ultracontext/drivers/
uc driver run <driver> <command>            # run a manifest command (e.g. opened, poll, status) on this host
```

Rule of thumb: **drivers bring the outside world in; events + files are what core sees.** A driver's stdout is not load-bearing — its committed events are. Do not confuse a mirrored source leaf (the workspace folder) with the driver that maintains it.

## Setup & health

```sh
uc init                                      # onboard ultracontext for this project (--yes to accept defaults)
uc doctor                                    # diagnose env, config, workspace, and reachability
uc upgrade                                   # self-update the uc CLI (--dry-run to preview)
uc version                                   # print the installed uc version
uc commands --json                           # machine-readable command tree (use this to discover exact flags)
```

When in doubt about exact flags or a command's current shape, run `uc commands --json` — it is the authoritative, machine-readable surface.

## Pipe-awareness

`uc` is pipe-aware: pass `--json` (or run with a non-TTY stdout) and data goes to stdout as machine JSON, while spinners/logs go to stderr. Exit `0` on success, `1` on error, `130` on user cancel. Prefer `--json` when you parse output programmatically.

## Privacy

Never preserve or surface secrets. Redact tokens, credentials, cookies, signed URLs, and auth headers as `[REDACTED]`. Store deep context as files/artifacts and reference them from events — never inline sensitive payloads into events or contexts.
