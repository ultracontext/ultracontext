# Repository Guidelines

## Project Structure & Module Organization
This repository is a `pnpm` monorepo (`pnpm-workspace.yaml`) with apps in `apps/*` and shared packages in `packages/*`.
- `apps/api`: Context API (Hono + Drizzle, TypeScript)
- `apps/daemon`: background ingestion service (Node ESM)
- `apps/tui`: terminal dashboard (Ink/React)
- `apps/js-sdk`: JavaScript/TypeScript SDK + CLI (`ultracontext`)
- `apps/python-sdk`: Python SDK
- `apps/postgres`: local PostgreSQL + schema (`init.sql`)
- `apps/docs`: Mintlify docs
- `packages/protocol`: shared protocol types/utilities

## Build, Test, and Development Commands
- `pnpm install`: install workspace dependencies.
- `pnpm ultracontext:db:up` / `pnpm ultracontext:db:down`: start/stop local Postgres.
- `pnpm ultracontext:db:migrate`: apply DB schema from `apps/postgres/init.sql`.
- `pnpm ultracontext:api`: run API locally (`apps/api`).
- `pnpm dev:daemon` and `pnpm dev:tui`: run Hub components in watch mode.
- `pnpm --filter ultracontext run build`: build JS SDK package.
- `pnpm check`: run package-level checks where defined.

## Coding Style & Naming Conventions
No single repo-wide formatter config is checked in, so match the local style of the package/file you edit.
- `apps/api` TypeScript commonly uses 4-space indentation and single quotes.
- `apps/daemon`, `apps/tui`, and `apps/js-sdk` commonly use 2-space indentation and double quotes.
- Keep naming consistent with surrounding code: API modules are mostly kebab-case (for example `context-chain.ts`), while TUI React components use PascalCase (for example `DaemonTui.mjs`).

## Testing Guidelines
- API tests use Node’s built-in runner: `pnpm --filter ultracontext-api run test` (or `test:watch`).
- Python SDK dev tooling is defined in `apps/python-sdk/pyproject.toml` (`pytest`, `pytest-asyncio`, `mypy`).
- Add tests with `*.test.*` or `*.spec.*` naming near changed code or in a `tests/` folder.
- No explicit coverage gate is configured; include meaningful tests for every bug fix/behavior change.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (for example `feat(api): add fork endpoint`, `fix(cli): handle missing env`).
- For large changes, open an issue first to align on approach.
- Keep PRs focused to one feature/fix and target `main`.
- In PR descriptions, include scope, affected packages, and commands run locally (for example `pnpm check`, package tests).

## Security & Configuration Tips
- Copy `.env.example` to `.env` (root), plus app-specific env examples as needed.
- Do not commit secrets; `.env*` files are ignored except documented examples.
- If local Postgres state drifts across versions, use `pnpm ultracontext:db:reset`.
