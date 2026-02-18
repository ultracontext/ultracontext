# UltraContext Daemon

Background ingestion service that syncs local agent sessions into UltraContext.

## Run

```bash
cd apps/daemon
npm install
npm run start
```

Development mode:

```bash
npm run dev
```

## Notes

- This package runs the daemon process only.
- TUI client lives in `apps/tui`.
- Both daemon and TUI share the same Redis backend and UltraContext credentials via env vars.

## Main Env Vars

- `ULTRACONTEXT_API_KEY`
- `ULTRACONTEXT_BASE_URL`
- `REDIS_URL` (primary)
- `STATE_STORE_URL` (legacy fallback)
- `CACHE_URL` (legacy fallback)
- `DAEMON_ENGINEER_ID`
- `DAEMON_HOST`
