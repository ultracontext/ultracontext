# AGENTS.md

Agent-facing guide to this repo. Mirrors `CLAUDE.md` — read either; this one is
the canonical entry for non-Claude agents.

## What this is

UltraContext — the context toolkit for AI agents. pnpm monorepo
(`pnpm-workspace.yaml`: `packages/*`, `apps/*`). Local-first: `npm i ultracontext`
installs the `uc` CLI **and** the JS SDK in one install.

## Monorepo map

### `packages/` — driver-free libraries

| Package | What it is |
|---|---|
| `@ultracontext/core` | Capability engine. IO-free context/key ops over a `StorageAdapter` port. No HTTP, no DB driver. Ops return `Result<T> = { ok:true, data } \| { ok:false, code, message }`. |
| `@ultracontext/storage` | `StorageAdapter` impls: `./drizzle`, `./supabase`, `./sqlite` (node/bun libsql or bun:sqlite; `createSqliteAdapter(url)`), `./sqlite-browser` (sql.js + IndexedDB). Pure adapter class in `sqlite/adapter.ts` (browser-safe); node/bun drivers in `sqlite/index.ts`. |
| `@ultracontext/parsers` | Agent session parsers + writers + compat matrix. `.mjs`. |
| `@ultracontext/mirror` | fs-first Mutagen mirror orchestration: config IO under `~/.ultracontext`, pure mutagen parsers, injectable command runner. |

### `apps/` — runnable surfaces

| App | What it is |
|---|---|
| `api` | Hono REST API. **DO NOT MODIFY.** |
| `mcp-server` | Stdio MCP server. **DO NOT MODIFY.** |
| `js-sdk` | The SDK, published `@ultracontext/js`, `private:true`. Typed HTTP client. |
| `cli` | The `uc` binary, published as **`ultracontext`**. Imports `@ultracontext/js` + libs, bundles + exports the **unified `UltraContext` SDK** on `.`. bins: `uc` + `ultracontext`. |
| `python-sdk` | `UltraContext`/`AsyncUltraContext` (PyPI `ultracontext`). **Local-by-default**: local mode drives the bundled `uc` binary, httpx for remote. API client = DO NOT MODIFY; the local backend (`_local.py`) is editable. |
| `postgres` | Local Postgres compose + `init.sql` + migrations. |
| `docs` | Mintlify MDX. |

Dependency direction: `cli → js-sdk → api`. The `.` export is the unified
`UltraContext` SDK (`apps/cli/lib/sdk/ultracontext.ts`), shadowing the
`@ultracontext/js` class.

## Unified SDK (local-by-default)

`npm i ultracontext` / `pip install ultracontext` give a local-first SDK — no
server, no api key — backed by a local SQLite file (`./ultracontext.db`, cwd
app-specific, NOT `~/.ultracontext/uc.db`). Pass an `apiKey` (or `mode:'remote'`)
to use the hosted API. Same object, one config switch. Selection rule (identical
both langs): `mode ?? (apiKey ? 'remote' : 'local')` — explicit `mode` wins. JS
runs `@ultracontext/core` in-process; Python shells out to the bundled `uc`
binary. Local errors throw (remote parity). Runs everywhere: Node/Bun (SQLite
file), browser (sql.js + IndexedDB, wasm lazy so remote-only apps pay zero bytes;
`wasmUrl` for offline bundles), edge (remote — local throws a clear error). The
CLI's `.` ships conditional exports (`node`/`bun` → full build; `default` → browser).

## Architecture decisions

- **Full TypeScript rebuild.** CLI is TS/ESM end-to-end: Commander
  (`@commander-js/extra-typings`) + `@clack/prompts` + `picocolors`.
- **Local-first context.** Verbs target a `ContextClient`
  (`add/get/update/delete/list`). Default `LocalContextClient` wraps
  `@ultracontext/core` ops over SQLite at `~/.ultracontext/uc.db`, resolving the
  default context per cwd/project. `RemoteContextClient` (`--remote`) uses the SDK.
- **fs-first Mutagen mirror** via `@ultracontext/mirror`; config in `~/.ultracontext`.
- **Config under `~/.ultracontext/`** (NOT XDG). Atomic writes (temp + rename).
  SQLite self-locks (WAL) — no file-lock library.

## Core ops (from `@ultracontext/core`)

`createContext` · `getContext` · `appendMessages` · `updateMessages` ·
`deleteContextPermanent` · `deleteMessages` · `deleteManyContexts` ·
`listContexts` · `getContextMessages` · `createKey` ·
`verifyKey`/`verifyKeyHash`/`hashToken`. All take a `StorageAdapter` +
`projectId`. All return `Result<T>`.

## `uc` command tree

- **Context group** (client-agnostic, alias `ctx`): `uc context create|append|get|update|delete|list`
- **Mirror**: `uc mirror start|stop|status|list|reset` · `uc mirror source list|add|remove|enable|disable`
- **Events**: `uc event emit|tail|status|flush` · `uc event commit --from-stdin` (hub side, ssh transport target)
- **Utility**: `uc update` · `uc doctor` · `uc init`
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
pnpm --filter @ultracontext/mirror run test     # 33
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
- **Do not modify**: `apps/api`, `apps/mcp-server`. In `apps/python-sdk`, the
  remote/API client stays DO NOT MODIFY; only its local backend (`_local.py`) is editable.
