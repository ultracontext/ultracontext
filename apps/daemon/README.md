# UltraContext Daemon

Background ingestion service that syncs local agent sessions into UltraContext.

## Run

```bash
pnpm install
pnpm --filter ultracontext-daemon run start
```

Env setup (monorepo root):

```bash
cp .env.example .env
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
- Environment variables are loaded from monorepo root `.env` by default, with fallback to `apps/daemon/.env`.
- Use `DOTENV_CONFIG_PATH=/custom/path/.env` to override the env file location.
- Daemon uses local SQLite for offsets/dedupe/config cache (recommended in root `.env`: `ULTRACONTEXT_DB_FILE=~/.ultracontext/daemon.db`).
- Daemon exposes local WebSocket runtime state for TUI (recommended in root `.env`: `ULTRACONTEXT_DAEMON_INFO_FILE=~/.ultracontext/daemon.info`).
- Sound effects and resume UX now live in the TUI client.

## Main Env Vars

- `ULTRACONTEXT_API_KEY`
- `ULTRACONTEXT_BASE_URL`
- `ULTRACONTEXT_CONFIG_FILE` (recommended in root `.env`: `~/.ultracontext/config.json`)
- `ULTRACONTEXT_DB_FILE`
- `ULTRACONTEXT_LOCK_FILE`
- `ULTRACONTEXT_DAEMON_WS_HOST`
- `ULTRACONTEXT_DAEMON_WS_PORT`
- `ULTRACONTEXT_DAEMON_INFO_FILE` (fallback: `ULTRACONTEXT_DAEMON_WS_PORT_FILE`)
- `DAEMON_ENGINEER_ID`
- `DAEMON_HOST`
