# UltraContext Daemon

Background ingestion service that syncs local agent sessions into UltraContext.

## Run

```bash
pnpm install
pnpm --filter ultracontext-daemon run start
```

`start` now launches in the background and returns control to the terminal.

Verbose mode (foreground with formatted logs):

```bash
pnpm --filter ultracontext-daemon run start:verbose
```

Status / stop:

```bash
pnpm --filter ultracontext-daemon run status
pnpm --filter ultracontext-daemon run stop
```

Development mode (watch):

```bash
pnpm --filter ultracontext-daemon run dev
```

## Notes

- This package runs the daemon process only (headless).
- TUI client lives in `apps/tui`.
- Daemon uses local SQLite for offsets/dedupe/config cache (`~/.ultracontext/daemon.db` by default).
- Daemon exposes local WebSocket runtime state for TUI (`~/.ultracontext/daemon.info` by default).
- Sound effects and resume UX now live in the TUI client.

## Main Env Vars

- `ULTRACONTEXT_API_KEY`
- `ULTRACONTEXT_BASE_URL`
- `ULTRACONTEXT_CONFIG_FILE` (default: `~/.ultracontext/config.json`)
- `ULTRACONTEXT_DB_FILE`
- `ULTRACONTEXT_LOCK_FILE`
- `ULTRACONTEXT_DAEMON_WS_HOST`
- `ULTRACONTEXT_DAEMON_WS_PORT`
- `ULTRACONTEXT_DAEMON_INFO_FILE` (fallback: `ULTRACONTEXT_DAEMON_WS_PORT_FILE`)
- `DAEMON_ENGINEER_ID`
- `DAEMON_HOST`
