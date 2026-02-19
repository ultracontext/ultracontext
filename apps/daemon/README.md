# UltraContext Daemon

Background ingestion service that syncs local agent sessions into UltraContext.

## Run

```bash
pnpm install
pnpm --filter ultracontext-daemon run start
```

Development mode:

```bash
pnpm --filter ultracontext-daemon run dev
```

TUI mode:

```bash
pnpm --filter ultracontext-daemon run tui
```

## Notes

- This package runs the daemon process only.
- TUI client lives in `apps/tui`.
- Both daemon and TUI share the same Redis backend and UltraContext credentials via env vars.

## Main Env Vars

- `ULTRACONTEXT_API_KEY`
- `ULTRACONTEXT_BASE_URL`
- `ULTRACONTEXT_CONFIG_FILE` (default: `~/.ultracontext/config.json`)
- `REDIS_URL`
- `DAEMON_ENGINEER_ID`
- `DAEMON_HOST`
