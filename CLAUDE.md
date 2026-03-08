# CLAUDE.md

## Architecture

UltraContext — version control for AI agent context. pnpm monorepo.

### Context API (`apps/api`)

REST API. Hono + TypeScript. Two entrypoints via `createApp(options?)`:

| Entrypoint | Runtime | Config | Storage | Cache |
|---|---|---|---|---|
| `server.ts` | Node.js | dotenv → `getApiConfig()` | Drizzle or Supabase | — |
| `worker.ts` | CF Workers | env bindings → `buildApiConfig(env)` | Supabase only | KV (optional) |

Key internals:
- **Storage** (`src/storage/`) — `StorageAdapter` interface. Drizzle (postgres.js) or Supabase. Selected by `DATABASE_PROVIDER`.
- **Auth** (`src/middleware/auth.ts`) — Bearer token. Prefix lookup + hash verification. Optional `KeyCache` for caching (KV on Workers).
- **Cache** (`src/cache/`) — `KeyCache` interface + `KvKeyCache` (CF KV). Injected via `AppOptions.keyCache`.
- **Config** (`src/config.ts`) — `buildApiConfig(env)` takes any plain object. `getApiConfig()` loads dotenv first.
- **Schema** (`apps/postgres/init.sql`) — tables: `projects`, `api_keys`, `nodes`. JSONB for `content`/`metadata`.

### Context Hub

- `apps/daemon` — background ingestion of agent sessions. Node ESM + WebSocket server.
- `apps/tui` — terminal dashboard. Ink/React 19 + WebSocket client.

### SDKs

- `apps/js-sdk` — published as `ultracontext` on npm. Bundles CLI + daemon + TUI.
- `apps/python-sdk` — httpx, published on PyPI.

### Shared

`packages/protocol` — WS message types, env resolution, constants.

## Commands

```bash
pnpm install                                    # deps
pnpm ultracontext:db:up                         # start local Postgres (5433)
pnpm ultracontext:db:down                       # stop
pnpm ultracontext:db:reset                      # reset with volumes
pnpm ultracontext:db:migrate                    # apply schema
pnpm ultracontext:api                           # run API (port 8787)
pnpm dev:daemon                                 # daemon watch mode
pnpm dev:tui                                    # TUI watch mode
pnpm --filter ultracontext run build            # build JS SDK
pnpm --filter ultracontext-api run test         # API tests (node --test)
pnpm --filter ultracontext-api run test:watch   # API tests watch
pnpm check                                      # all package checks
```

## Style

No repo-wide formatter. Match local style:

| Package | Indent | Quotes | Files |
|---|---|---|---|
| `apps/api` | 4 spaces | single | kebab-case |
| `apps/daemon`, `apps/tui`, `apps/js-sdk` | 2 spaces | double | kebab-case, PascalCase for React |

## Conventions

- **Commits**: Conventional Commits — `feat(api):`, `fix(tui):`
- **Tests**: `*.test.*` / `*.spec.*`, near changed code or `tests/`
- **Env**: `.env.example` → `.env`. Never commit secrets.
- **PRs**: one feature/fix, target `main`, include scope
- **Docs** (`apps/docs`): Mintlify MDX, YAML frontmatter, second-person voice
