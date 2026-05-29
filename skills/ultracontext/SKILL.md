---
name: ultracontext
description: |
  ultracontext is the user's GLOBAL context layer: shared workspace state across every synced
  machine, AI agent, session, and indexed folder. Trigger immediately when the user references
  prior work, another agent, another machine, synced context, notes, history, or "ultracontext".

  Also handles setup: `uc init`, `uc sync`, `uc source`, `uc event`, `uc driver`, `uc doctor`.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# ultracontext

UltraContext is a shared filesystem context layer for agents. It does not answer for you. It gives you the synced workspace so *you* can inspect the right evidence and answer accurately. Revolutionary idea: files still exist.

## Mental model

You are one agent in a fleet. The user may also run Claude, Codex, OpenClaw, Hermes, and other tools on several machines. UltraContext syncs those sources into one workspace tree.

- Workspace root: `~/.ultracontext/workspace/`
- Layout: `<host-id>/<source-folder>/<native-agent-layout>`
- Built-in source folders usually include `.claude`, `.codex`, `.openclaw`, `.hermes`
- Custom indexed folders use their configured source name
- Events may live outside host folders under `~/.ultracontext/events/`

Never assume there is only one machine. That is the whole bloody point.

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

1. Locate the workspace root.
   - Prefer configured/known root: `~/.ultracontext/workspace/`.
   - If remote sync is configured, inspect the remote workspace, not just the local machine.
   - `uc status` can show the workspace, host, and enabled sources.

2. Enumerate all relevant hosts first.
   - List matching `<host-id>/<source-folder>/` folders across the workspace.
   - Source-specific means every host for that source:
     - Codex: `<host>/.codex/`
     - Claude: `<host>/.claude/`
     - OpenClaw: `<host>/.openclaw/`
     - Hermes: `<host>/.hermes/`

3. Rank candidates by internal timestamps.
   - Prefer JSONL/session metadata timestamps over file mtime.
   - Use file mtime only as fallback.
   - Include host name when multiple hosts match or when it clarifies where work happened.

4. Return evidence-backed context.
   - Include file paths, agents, hosts, timestamps, session ids, and short excerpts when useful.
   - If nothing clearly useful exists, say `NONE` internally or tell the user you found nothing relevant.
   - Never preserve secrets; redact tokens, credentials, cookies, signed URLs, and headers as `[REDACTED]`.

## Latest/recent requests

For "latest", "last", "newest", "recent", or "most recent":

- Do not rely on semantic relevance alone.
- Enumerate candidate sessions across all hosts and relevant agents.
- Inspect internal timestamps before deciding.
- For "latest thing we did", compare Codex, Claude, OpenClaw, Hermes, and event records when relevant.

## Codex fast path

Use this path for Codex recall. It is faster and less stupid than brute-forcing every rollout first.

1. Start with every `<host>/.codex/history.jsonl`.
   - Compact JSONL index with `session_id`, `ts` epoch seconds, and `text`.
   - Search exact terms, user wording, project names, and recent activity here first.

2. For latest/recent Codex activity:
   - Compare `history.jsonl` entries by `ts` across all hosts.
   - If history is sparse or missing, enumerate newest `<host>/.codex/sessions/**/rollout-*.jsonl` and inspect the first `session_meta` line.

3. Map history hits to full transcripts:
   - Find `<host>/.codex/sessions/**/rollout-*<session_id>.jsonl`.
   - Open the rollout when details matter.

4. In Codex rollouts:
   - First line is usually `session_meta` with `payload.id`, `payload.timestamp`, `payload.cwd`, CLI version, and model provider.
   - User prompts appear in `event_msg` with `type=user_message` and in `response_item` messages with `role=user`.
   - Assistant replies, tool calls, command outputs, and errors appear later in `response_item` and `event_msg` records.
   - Skip giant system/developer instruction blobs unless the user asks about prompts, permissions, or agent setup.

5. Resume snapshots:
   - `<host>/.codex/resume/ctx_*.md` are compact resume snapshots.
   - Use them for continue/context-transfer questions, but use rollouts for authoritative detail.

## Claude fast path

1. Start with every `<host>/.claude/history.jsonl`.
   - Fields usually include `display`, `timestamp` epoch milliseconds, `project`, `sessionId`, and sometimes pasted content.

2. Map a hit to transcript:
   - Encode `project` like Claude does for project dirs: replace `/` and `.` with `-`.
   - Open `<host>/.claude/projects/<encoded-project>/<sessionId>.jsonl`.
   - If missing, search `<host>/.claude/projects/**/<sessionId>.jsonl`.

3. If history is sparse, scan `<host>/.claude/projects/**/*.jsonl` directly and rank by internal `timestamp`.

## OpenClaw fast path

1. Start with `<host>/.openclaw/agents/<agent-id>/sessions/sessions.json`.
   - Values may include `sessionId`, `sessionFile`, `label`, `status`, `spawnedBy`, `startedAt`, `updatedAt`, `endedAt`, `runtimeMs`.
   - Treat `updatedAt`, `startedAt`, and `endedAt` as epoch milliseconds.

2. Open referenced transcript:
   - `<host>/.openclaw/agents/<agent-id>/sessions/<session-id>.jsonl`
   - If `sessionFile` is an absolute local path, map it into the synced workspace path.

3. For reset/deleted history, inspect siblings:
   - `<session-id>.jsonl.reset.<timestamp>`
   - `<session-id>.jsonl.deleted.<timestamp>`
   - `<session-id>.trajectory.jsonl`
   - `<session-id>.trajectory.jsonl.deleted.<timestamp>`
   - `<session-id>.trajectory-path.json`

## Search helpers

If the workspace is indexed with QMD, use:

```sh
qmd search "exact project/file/error/user wording"
```

Use QMD to narrow candidates, not as a substitute for opening source files. Trust, but verify. Mostly don't trust.

## Setup commands

- `uc init <local|user@host>`: configure workspace, choose sources, install this skill, optionally start sync.
- `uc status`: show workspace, host, and sync/source status.
- `uc sync start`: start syncing enabled sources.
- `uc sync list`: list configured sync sessions.
- `uc sync status`: show Mutagen session state.
- `uc sync stop`: pause enabled sync sessions.
- `uc sync reset`: terminate and recreate sessions after config or ignore edits.
- `uc source list`: list sources.
- `uc source add <name> <path>`: add arbitrary indexed folder.
- `uc source remove <name> [--yes]`: terminate sync, delete remote copy, remove config entry. Local files stay.
- `uc source enable <name>` / `uc source disable <name>`: toggle one source.
- `uc event tail [--limit <n>]`: show recent shared activity/events; use first when the user asks what agents have been doing.
- `uc event emit` / `uc event commit`: record small activity facts only.
- `uc driver <list|run>`: manage/run configured drivers.
- `uc doctor`: verify installation, config, remote reachability, and workspace health.
- `uc update`: update using the active install manager.

## Core, drivers, extensions, and sources

Use this boundary when reasoning about UltraContext architecture:

- **Core**: mandatory runtime primitives: workspace layout, event log, outbox, identity, privacy, locks, subscriptions, scheduler.
- **Driver**: code/package that connects an external system to UltraContext. Drivers bring outside state into UC and may emit metadata-only events.
- **Extension**: behavior that transforms or acts on context already inside UltraContext, such as summarizers, indexers, digests, routers, or policy engines.
- **Agent**: a user-space process that reads/writes UC while doing work.

Rule of thumb: **drivers bring the outside world in; extensions transform what is already inside**.

Do not confuse a mirrored source folder with the driver that maintains it:

- `.chatgpt` is the **source mirror / workspace folder** for ChatGPT data.
- The **ChatGPT driver** may include bounded sync, iOS lifecycle relay, raw-to-Markdown parsing, checkpoints/watermarks, and `uc.event.v1` event mapping.
- `.claude-web` is the **source mirror / workspace folder** for Claude.ai web data.
- The **Claude.ai driver** may include bounded sync, parser/transpiler, checkpoints/watermarks, and event mapping.

Concrete examples:

```text
ChatGPT driver
  source mirror: .chatgpt
  lifecycle hook: iOS Shortcut relay
  sync: bounded recent sync
  parser/transpiler: raw -> markdown
  event mapper: sync.completed -> uc.event.v1
  checkpoint/watermark

Claude.ai driver
  source mirror: .claude-web
  sync: bounded recent sync
  parser/transpiler
  event mapper
  checkpoint/watermark
```

When reporting synced external app content, explicitly say it came from UltraContext/external app sync, not the current chat.

## Config shape

```toml
remote      = "user@vps"        # or "local"
remote_root = "~/.ultracontext"
host_id     = "macbook"

[sources.claude]
path    = "~/.claude"
enabled = true

[sources.codex]
path    = "~/.codex"
enabled = true
```

## Files

- Config: `~/.ultracontext/config.toml`
- Ignores: `~/.ultracontext/ignores/.ultracontextignore` and `~/.ultracontext/ignores/<source>/.ultracontextignore`
- Workspace: `~/.ultracontext/workspace/<host-id>/<source-folder>/`
- Events: `~/.ultracontext/events/events.jsonl`

## Event rule

Events are for small activity facts. Do not put raw prompts, full transcripts, secrets, cookies, tokens, headers, signed URLs, or huge payloads in events. Store deep context as files/artifacts and reference them.
