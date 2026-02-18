# UltraContext Daemon + TUI

Team observability app for ingesting local agent sessions into UltraContext, with:

- `State Store (Redis-compatible)` for dedupe (`SETNX`) and per-file offset checkpoints
- `UltraContext` for per-session persistence and optional daily context
- `codex`, `claude`, and `openclaw` ingestion
- Decoupled `daemon` + `ink` TUI client (TUI auto-starts daemon when needed)

## Run

1. Start the state store locally (Redis-compatible):

```bash
docker run --rm -p 6379:6379 redis:7
```

2. Configure variables:

```bash
cp .env.example .env
```

3. Install dependencies and start the TUI app:

```bash
cd apps/ultracontext
npm install
npm run start
```

By default, `npm run start` runs the TUI client and auto-connects to a daemon.
If no daemon is running for the same `host+engineer`, it starts one automatically.

Manual daemon mode:

```bash
npm run daemon
```

## Session Adapter Resume (UltraContext -> Codex/Claude Code)

For onboarding on a fresh machine: use the `Contexts` tab in the TUI to list contexts from UltraContext, pick one, and open the opposite agent automatically with a ready snapshot.

Adapter behavior:

- Context source `codex` -> target `Claude Code` (`claude --resume <session_id>`)
- Context source `claude` -> target `Codex` (`codex resume <session_id>`)

If a local session file is missing, the app materializes it from UltraContext messages before resuming.

## State Store Keys

- `uc:ingestor:offset:{source}:{fileId}` -> last processed offset
- `uc:ingestor:seen:{source}:{eventId}` -> event dedupe (TTL)
- `uc:ingestor:ctx:session:{source}:{host}:{engineer}:{session}` -> contextId
- `uc:ingestor:ctx:daily:{source}:{host}:{engineer}:{YYYY-MM-DD}` -> daily contextId
- `uc:ingestor:runtime:v1:{host}:{engineer}` -> daemon runtime snapshot for TUI client
- `uc:ingestor:logs:v1:{host}:{engineer}` -> recent daemon live activity feed

## Default Sources

- Codex: `~/.codex/sessions/**/*.jsonl`
- Claude Code: `~/.claude/projects/**/*.jsonl`
- OpenClaw: `~/.openclaw/agents/*/sessions/**/*.jsonl`

Globs and toggles are configurable via env:

- `INGEST_CODEX=true|false`
- `INGEST_CLAUDE=true|false`
- `INGEST_OPENCLAW=true|false`
- `CODEX_GLOB=...`
- `CLAUDE_GLOB=...`
- `OPENCLAW_GLOB=...`
- `CLAUDE_INCLUDE_SUBAGENTS=true|false` (default `false`)

## First-Run Bootstrap

On first run, the TUI asks how to bootstrap history ingestion:

- `New only (recommended)`: starts from current tail (no history flood)
- `Last 24h`: ingests only recent events
- `All`: full backfill

You can force mode via env:

- `INGESTOR_BOOTSTRAP_MODE=prompt|new_only|last_24h|all`
- `INGESTOR_BOOTSTRAP_RESET=true|false` (when `true`, ignores saved bootstrap choice and asks/applies again)

## Runtime Config Persistence

Settings changed in `Configs` are persisted in both:

- local file (default `~/.ultracontext/ingestor.config.json`)
- state store key scoped by host/engineer (`uc:ingestor:config:v1:{host}:{engineer}`)

The local JSON file is auto-created on first startup.

Configure file location with:

- `INGESTOR_CONFIG_FILE=...`

## App Modes

- `npm run start`: TUI client
- `npm run daemon`: headless daemon
- `npm run dev`: TUI client with `node --watch`
- `npm run daemon:dev`: daemon with `node --watch`

## Terminal UI (Client)

- `STATE_STORE_URL=redis://127.0.0.1:6379` (primary state store endpoint)
- `CACHE_URL=...` (legacy fallback)
- `REDIS_URL=...` (legacy fallback)
- `INGESTOR_UI_MODE=auto|pretty|plain`
- `INGESTOR_UI_REFRESH_MS=1200` (TUI refresh interval)
- `INGESTOR_UI_RECENT_LIMIT` (activity feed size; default scales with terminal height)
- `INGESTOR_LOG_APPENDS=true|false` (log each append event)
- `INGESTOR_INSTANCE_LOCK_TTL_SEC=45` (singleton lock TTL; prevents multiple daemons per `host+engineer`)
- Sounds:
- `INGESTOR_SOUND_ENABLED=true|false` (enable/disable all sounds)
- `INGESTOR_STARTUP_SOUND_ENABLED=true|false` (play sound on startup)
- `INGESTOR_CONTEXT_SOUND_ENABLED=true|false` (play sound on context creation)
- `INGESTOR_STARTUP_GREETING_FILE=./assets/sounds/hello_mf.mp3` (startup sound file)
- `INGESTOR_CONTEXT_SOUND_FILE=./assets/sounds/quack.mp3` (context-created sound file)
- Runtime TUI: `ink` + `react` (CLI React renderer)
- TUI menu: `Live`, `Contexts`, `Configs`
- Navigation model:
- Menu focus: `↑/↓` navigates menu items and previews the view, `Enter` or `→` focuses the selected view
- View focus: `↑/↓` navigates items in the active view, `Enter` performs the primary action, `←` goes back to menu
- `Configs` view: `Enter` toggles selected setting
- `Contexts` view: `r` refreshes contexts, `Enter` opens a target picker (`Claude Code` or `Codex`) and then runs adapter resume
- `RESUME_CONTEXT_LIMIT=1000` (how many contexts are loaded in `Contexts`)
- `RESUME_SOURCE_FILTER=all|codex|claude|openclaw` (which sources appear in `Contexts`)
- `RESUME_OPEN_TAB=true|false` (open a new terminal tab/window automatically on resume)
- `RESUME_TERMINAL=terminal|warp` (terminal app used when opening resume tab on macOS)
- `RESUME_SUMMARY_TAIL=14` (recent lines in local summary)
- `RESUME_OUTPUT_DIR=~/.codex/resume` (local snapshots generated from `Contexts`)
