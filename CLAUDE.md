# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## What this is

UltraContext — version control for AI agent context. pnpm monorepo
(`pnpm-workspace.yaml`: `packages/*`, `apps/*`). The product is local-first:
`npm i ultracontext` installs the `uc` CLI **and** the JS SDK in one shot.

## Monorepo map

### `packages/` — driver-free libraries (the engine + adapters)

| Package | What it is |
|---|---|
| `@ultracontext/core` | Capability engine. IO-free context/key ops over a `StorageAdapter` port. No HTTP, no DB driver. Every op returns `Result<T>`. Exports `./testing`. |
| `@ultracontext/storage` | `StorageAdapter` implementations: `./drizzle` (postgres.js), `./supabase`, `./sqlite` (node/bun: libsql or bun:sqlite — `createSqliteAdapter(url)`), `./sqlite-browser` (sql.js + IndexedDB snapshot). The pure adapter class lives in `sqlite/adapter.ts` (driver-agnostic, browser-safe); node/bun driver code stays in `sqlite/index.ts`. |
| `@ultracontext/parsers` | Agent session parsers (Claude/Codex/OpenClaw/Cursor/Gemini) + writers + compat matrix. `.mjs`, 2-space. |
| `@ultracontext/sync` | fs-first Mutagen sync orchestration. Config IO (`~/.ultracontext`), pure mutagen parsers, injectable command runner, start/stop/status/source actions. |

### `apps/` — runnable surfaces

| App | What it is |
|---|---|
| `api` | Hono REST API (`createApp(options?)`; `server.ts` Node, `worker.ts` CF Workers). **DO NOT TOUCH.** |
| `mcp-server` | Stdio MCP server (`ultracontext-mcp-server`). **DO NOT TOUCH.** |
| `js-sdk` | The JS/TS SDK, published name `@ultracontext/js`, `private:true`. SDK source only — typed HTTP client for the hosted API. |
| `cli` | The `uc` binary, published as **`ultracontext`**. Imports `@ultracontext/js` + the libs, bundles them (tsdown), exports the **unified `UltraContext` SDK** on `.`. bins: `uc` **and** `ultracontext`. |
| `python-sdk` | `UltraContext`/`AsyncUltraContext` client (PyPI `ultracontext`). **Local-by-default**: drives the bundled `uc` binary in local mode; httpx for remote. API source = DO NOT TOUCH; the local backend (`_local.py`) is editable here. |
| `postgres` | Local Postgres compose + schema (`init.sql`) + migration scripts. |
| `docs` | Mintlify MDX. Second-person voice, YAML frontmatter. |

Dependency direction: `cli → js-sdk → api`. The `.` export is the unified
`UltraContext` SDK (`apps/cli/lib/sdk/ultracontext.ts`, shadowing the
`@ultracontext/js` class); the `uc` bin lives in `src/cli/`.

**Unified SDK (local-by-default).** `npm i ultracontext` / `pip install
ultracontext` give a local-first SDK — no server, no api key — backed by a
local SQLite file (`./ultracontext.db`, cwd app-specific, NOT `~/.ultracontext/uc.db`).
Pass an `apiKey` (or `mode:'remote'`) to use the hosted API. Same object, one
config switch. Selection rule (identical both langs): `mode ?? (apiKey ? 'remote'
: 'local')` — explicit `mode` wins. JS runs `@ultracontext/core` in-process;
Python shells out to the bundled `uc` binary. Local errors throw (remote parity).
Runs everywhere: Node/Bun (SQLite file), browser (sql.js + IndexedDB, wasm loads
lazily so remote-only apps pay zero bytes; `wasmUrl` config for offline bundles),
edge (remote — local mode throws a clear error). The CLI's `.` ships conditional
exports (`node`/`bun` → full build w/ libsql; `default` → browser build).

## Architecture decisions

- **Full TypeScript rebuild.** The CLI is TS/ESM end-to-end (no `.mjs` daemon/TUI).
  Commander (`@commander-js/extra-typings`) + `@clack/prompts` + `picocolors`.
- **Local-first context.** Context verbs talk to a `ContextClient` interface
  (`add/get/update/delete/list`). `LocalContextClient` (default) wraps
  `@ultracontext/core` ops over a SQLite adapter at `~/.ultracontext/uc.db`,
  resolving the default context per cwd/project. `RemoteContextClient`
  (`--remote`, or config/env baseUrl+key) calls the hosted API via the SDK.
  Same interface → commands are client-agnostic.
- **fs-first Mutagen sync.** `uc sync` orchestrates Mutagen sessions over
  `@ultracontext/sync`; config lives in `~/.ultracontext`.
- **Config in `~/.ultracontext/`** (NOT XDG). Writes are atomic (temp + rename).
  SQLite self-locks via WAL — no file-lock library.

## `uc` command tree

- **Context verbs** (client-agnostic): `uc add` · `uc get` · `uc update` · `uc delete <id...>` (many ids → batch permanent delete, needs `--permanent`) · `uc list`
- **Sync** (`@ultracontext/sync`): `uc sync init|start|stop|status|list` · `uc sync source list|add` · `uc sync event` (stub)
- **Utility**: `uc upgrade` (self-update) · `uc doctor` (env health card) · `uc init` (onboarding)
- **Introspection**: `uc commands --json` (machine-readable tree for agents)

Global flags: `--json`, `--remote`.

## Pipe-awareness (load-bearing)

If `--json` OR stdout is not a TTY → emit machine JSON. Data → **stdout**;
spinners/status/logs → **stderr**. Stable string error codes. Exit `1` on
error, `130` on user cancel.

## Commands

```bash
pnpm install                                    # deps

# build + test the CLI
pnpm --filter ultracontext run build            # tsdown → dist (uc bin + SDK)
pnpm --filter ultracontext run test             # CLI tests (112)
pnpm --filter ultracontext run check            # tsc --noEmit

# library tests (regression guard — keep green)
pnpm --filter @ultracontext/core run test       # 158
pnpm --filter @ultracontext/storage run test    # 2  (uses temp SQLite files)
pnpm --filter @ultracontext/sync run test       # 33
pnpm --filter ultracontext-api run test         # 23

pnpm check                                      # all package checks

# local API + Postgres
pnpm ultracontext:db:up                         # local Postgres (5433)
pnpm ultracontext:db:migrate                    # apply schema
pnpm ultracontext:api                           # run API (port 8787)
pnpm ultracontext:key:local                     # dev API key

# single test file (node:test via tsx)
node --import tsx --test apps/cli/lib/config.test.ts

# Python SDK
cd apps/python-sdk && pytest
```

Tests use `node:test` (`import { describe, it } from 'node:test'`;
`import assert from 'node:assert/strict'`) run via `tsx`. libsql `:memory:`
does NOT share tables across connections — tests use **temp SQLite files**.

## TDD (mandatory)

Every new module is RED (failing test first) → GREEN (implement). The
regression-guard suites above must stay green at every step.

## Style (per package)

| Where | Indent | Quotes | Files | Module |
|---|---|---|---|---|
| `packages/core`, `packages/storage`, `packages/sync`, `apps/cli`, `apps/js-sdk`, `apps/api` | 4 | single | kebab-case | TS/ESM |
| `packages/parsers` | 2 | double | kebab-case | `.mjs` |

One short semantic comment atop each logical block + a blank line between blocks.

## Conventions

- **Commits**: Conventional Commits — `feat(cli):`, `fix(api):`. NEVER add
  `Co-Authored-By` lines (hard rule).
- **Branch**: work on `feat/uc-cli`. Do not push, open PRs, or touch `main`.
- **Tests**: `*.test.ts` near the code.
- **Env**: `.env.example` → `.env`. Never commit secrets.
- **Do not touch**: `apps/api`, `apps/mcp-server`. In `apps/python-sdk`, the
  remote/API client stays DO NOT TOUCH; only its local backend (`_local.py`) is editable.

## Skill routing

When a request matches an available skill, invoke it via the Skill tool FIRST.
Product ideas → office-hours · bugs/500s → investigate · ship/PR → ship ·
QA → qa · code review → review · docs → document-release · arch review →
plan-eng-review · design → design-consultation / design-review.
