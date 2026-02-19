# Repository Guidelines

## Project Structure & Module Organization
This repository is a small monorepo organized under `apps/`:
- `apps/daemon`: Node.js daemon that ingests local agent activity (`src/*.mjs`, assets in `assets/`).
- `apps/tui`: terminal UI client for daemon state (`src/index.mjs`).
- `apps/js-sdk`: TypeScript SDK (`src/index.ts`, build output in `dist/`).
- `apps/python-sdk`: Python SDK package (`ultracontext/`).
- `apps/redis`: local Redis service (`docker-compose.yml`) for daemon/TUI state.

Keep changes scoped to the relevant app and update that app’s README when behavior changes.

## Build, Test, and Development Commands
- `cd apps/daemon && npm run start`: run daemon once.
- `cd apps/daemon && npm run dev`: run daemon in watch mode.
- `cd apps/daemon && npm run check`: syntax-check daemon modules.
- `cd apps/tui && npm run start`: launch TUI client.
- `cd apps/tui && npm run check`: syntax-check TUI entrypoint.
- `cd apps/js-sdk && npm run build`: compile TypeScript to `dist/`.
- `cd apps/python-sdk && python -m pip install -e '.[dev]'`: install SDK with dev tools.
- `cd apps/python-sdk && mypy ultracontext`: run strict Python type checks.
- `cd apps/redis && docker compose up -d`: start local Redis.

## Coding Style & Naming Conventions
Follow existing style per package:
- `apps/daemon` and `apps/tui`: ESM `.mjs`, mostly 2-space indentation, `camelCase` functions.
- `apps/js-sdk`: TypeScript with explicit exported types, 4-space indentation, `PascalCase` for types/classes.
- `apps/python-sdk`: PEP 8 style, 4-space indentation, `snake_case` modules/functions.

Name commits and symbols clearly by domain (`daemon`, `tui`, `js-sdk`, `python-sdk`).

## Testing Guidelines
There is no committed first-party test suite yet. Minimum validation before PR:
- Run package checks (`npm run check`, `npm run build`, `mypy ultracontext`).
- Manually verify affected runtime flow (daemon ingestion, TUI rendering, SDK request path).

When adding tests, keep them package-local and use explicit names like `test_<feature>.py` or `<feature>.test.ts`.

## Commit & Pull Request Guidelines
Use Conventional Commit style seen in history, for example:
- `feat(ultracontext): ...`
- `refactor(daemon): ...`
- `docs: ...`

For PRs, include:
- concise summary and touched app(s),
- linked issue (if applicable),
- env/config changes (for example `ULTRACONTEXT_API_KEY`, `REDIS_URL`),
- terminal screenshots or short recordings for TUI-visible changes,
- commands you ran to verify behavior.

## Security & Configuration Tips
Never commit secrets. Use `apps/daemon/.env.example` as a template, and keep local credentials in untracked `.env` files.
