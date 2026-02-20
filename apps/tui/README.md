# UltraContext TUI

Terminal client for the UltraContext daemon.

## Run

```bash
pnpm install
pnpm --filter ultracontext-tui run start
```

Env setup (monorepo root):

```bash
cp .env.example .env
```

## Notes

- This package opens the TUI client and connects to daemon local WebSocket runtime state from `apps/daemon` (discovery via `~/.ultracontext/daemon.info`).
- Environment variables are loaded from monorepo root `.env` by default, with fallback to `apps/tui/.env` and `apps/daemon/.env`.
- Use `DOTENV_CONFIG_PATH=/custom/path/.env` to override the env file location.
- TUI does not auto-start the daemon.
- If daemon is offline, TUI shows: `pnpm --filter ultracontext-daemon run start`.
- Startup/duck sounds are emitted by the TUI (not by the daemon).
- Resume flow is fully handled by the TUI.
