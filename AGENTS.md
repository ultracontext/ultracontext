# AGENTS.md

Agent-facing guide to this repo. Mirrors `CLAUDE.md` — read either; this one is
the canonical entry for non-Claude agents.

## What this is

UltraContext — version control for AI agent context. pnpm monorepo
(`pnpm-workspace.yaml`: `packages/*`, `apps/*`). Local-first: `npm i ultracontext`
installs the `uc` CLI **and** the JS SDK in one install.

## Monorepo map

### `packages/` — driver-free libraries

| Package | What it is |
|---|---|
| `@ultracontext/core` | Capability engine. IO-free context/key ops over a `StorageAdapter` port. No HTTP, no DB driver. Ops return `Result<T> = { ok:true, data } \| { ok:false, code, message }`. |
| `@ultracontext/storage` | `StorageAdapter` impls: `./drizzle`, `./supabase`, `./sqlite` (libsql; `createSqliteAdapter(url)`). |
| `@ultracontext/parsers` | Agent session parsers + writers + compat matrix. `.mjs`. |
| `@ultracontext/sync` | fs-first Mutagen sync orchestration: config IO under `~/.ultracontext`, pure mutagen parsers, injectable command runner. |

### `apps/` — runnable surfaces

| App | What it is |
|---|---|
| `api` | Hono REST API. **DO NOT MODIFY.** |
| `mcp-server` | Stdio MCP server. **DO NOT MODIFY.** |
| `js-sdk` | The SDK, published `@ultracontext/js`, `private:true`. Typed HTTP client. |
| `cli` | The `uc` binary, published as **`ultracontext`**. Imports `@ultracontext/js` + libs, bundles + re-exports the SDK on `.`. bins: `uc` + `ultracontext`. |
| `python-sdk` | httpx client (PyPI `ultracontext`). **DO NOT MODIFY.** |
| `postgres` | Local Postgres compose + `init.sql` + migrations. |
| `docs` | Mintlify MDX. |

Dependency direction: `cli → js-sdk → api`.

## Architecture decisions

- **Full TypeScript rebuild.** CLI is TS/ESM end-to-end: Commander
  (`@commander-js/extra-typings`) + `@clack/prompts` + `picocolors`.
- **Local-first context.** Verbs target a `ContextClient`
  (`add/get/update/delete/list`). Default `LocalContextClient` wraps
  `@ultracontext/core` ops over SQLite at `~/.ultracontext/uc.db`, resolving the
  default context per cwd/project. `RemoteContextClient` (`--remote`) uses the SDK.
- **fs-first Mutagen sync** via `@ultracontext/sync`; config in `~/.ultracontext`.
- **Config under `~/.ultracontext/`** (NOT XDG). Atomic writes (temp + rename).
  SQLite self-locks (WAL) — no file-lock library.

## Core ops (from `@ultracontext/core`)

`createContext` · `getContext` · `appendMessages` · `updateMessages` ·
`deleteContextPermanent` · `deleteMessages` · `deleteManyContexts` ·
`listContexts` · `getContextMessages` · `createKey` ·
`verifyKey`/`verifyKeyHash`/`hashToken`. All take a `StorageAdapter` +
`projectId`. All return `Result<T>`.

## `uc` command tree

- **Context** (client-agnostic): `uc add` · `get` · `update` · `delete` · `list`
- **Sync**: `uc sync init|start|stop|status|list` · `uc sync source list|add` · `uc sync event` (stub)
- **Utility**: `uc upgrade` · `uc doctor` · `uc init`
- **Introspection**: `uc commands --json` — machine-readable command tree

Global flags: `--json`, `--remote`.

## Pipe-awareness

`--json` OR non-TTY stdout → machine JSON. Data → **stdout**; status/logs →
**stderr**. Stable string error codes. Exit `1` on error, `130` on cancel.

## Build / test / dev

```bash
pnpm install

pnpm --filter ultracontext run build            # tsdown → dist (uc bin + SDK)
pnpm --filter ultracontext run test             # CLI tests (112)
pnpm --filter ultracontext run check            # tsc --noEmit

# regression guard — keep green
pnpm --filter @ultracontext/core run test       # 158
pnpm --filter @ultracontext/storage run test    # 2
pnpm --filter @ultracontext/sync run test       # 33
pnpm --filter ultracontext-api run test         # 23

pnpm check                                      # all package checks

# single test file
node --import tsx --test apps/cli/lib/config.test.ts
```

Tests: `node:test` via `tsx`. libsql `:memory:` does NOT share tables across
connections — use **temp SQLite files** in fixtures. TDD is mandatory: RED
(failing test) → GREEN (implement).

## Style (per package)

| Where | Indent | Quotes | Files | Module |
|---|---|---|---|---|
| core, storage, sync, cli, js-sdk, api | 4 | single | kebab-case | TS/ESM |
| parsers | 2 | double | kebab-case | `.mjs` |

One short semantic comment atop each logical block + a blank line between blocks.

## Conventions

- **Commits**: Conventional Commits (`feat(cli):`, `fix(api):`). NEVER add
  `Co-Authored-By` lines.
- **Branch**: `feat/uc-cli`. Don't push, open PRs, or touch `main`.
- **Do not modify**: `apps/api`, `apps/mcp-server`, `apps/python-sdk` source.
