# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

UltraContext = git-like version control for AI agent context. pnpm monorepo with three layers:

1. **Context API** (`apps/api`) — REST API. Hono + Drizzle ORM + PostgreSQL. TypeScript.
2. **Context Hub** — local experience:
   - `apps/daemon` — background ingestion of agent sessions (Claude Code, Codex, OpenClaw). Node ESM + WebSocket server.
   - `apps/tui` — terminal dashboard. Ink/React 19 + WebSocket client.
3. **SDKs** — `apps/js-sdk` (TypeScript, published as `ultracontext` on npm, bundles CLI + daemon + TUI) and `apps/python-sdk` (httpx, published on PyPI).

Shared code lives in `packages/protocol` (WS message types, env resolution, constants).

### Storage adapter pattern

`apps/api/src/storage/` — pluggable backend via `StorageAdapter` interface. Drizzle (default, postgres.js driver) or Supabase. Selected by `DATABASE_PROVIDER` env var.

### Database schema

`apps/postgres/init.sql` — three tables: `projects`, `api_keys`, `nodes`. Nodes use JSONB for `content` and `metadata`, linked by `context_id`, `parent_id`, `prev_id`.

### Auth

Bearer token scheme. Token prefix (first 8 chars) used for lookup, full token hashed for verification. Two levels: API key (project-scoped) + admin key (system-wide).

## Commands

```bash
# Dependencies
pnpm install

# Database
pnpm ultracontext:db:up          # start local Postgres (port 5433)
pnpm ultracontext:db:down        # stop
pnpm ultracontext:db:reset       # reset with volumes
pnpm ultracontext:db:migrate     # apply schema from init.sql

# API
pnpm ultracontext:api            # run API locally (port 8787)

# Hub (watch mode)
pnpm dev:daemon
pnpm dev:tui

# Build JS SDK
pnpm --filter ultracontext run build

# Tests
pnpm --filter ultracontext-api run test        # API: Node built-in test runner
pnpm --filter ultracontext-api run test:watch   # API: watch mode
# Python SDK: pytest, pytest-asyncio, mypy (see pyproject.toml)

# Checks
pnpm check                       # run all package-level checks
```

## Coding Style

No repo-wide formatter. Match the local style of whatever package you edit:

| Package | Indent | Quotes | File naming |
|---------|--------|--------|-------------|
| `apps/api` (TS) | 4 spaces | single | kebab-case (`context-chain.ts`) |
| `apps/daemon`, `apps/tui`, `apps/js-sdk` | 2 spaces | double | PascalCase for React components, kebab-case otherwise |

## Conventions

- **Commits**: Conventional Commits with scope — `feat(api): ...`, `fix(tui): ...`
- **Tests**: `*.test.*` or `*.spec.*`, near changed code or in `tests/`
- **Env**: copy `.env.example` to `.env` at root + per-app. Never commit secrets.
- **PRs**: focused on one feature/fix, target `main`, include scope and affected packages
- **Docs** (`apps/docs`): Mintlify MDX, YAML frontmatter required, second-person voice, test code examples before publishing
