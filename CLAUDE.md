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

### Sync (`apps/sync`)

Single package for local ingestion + TUI dashboard. Two processes, JSON file IPC:
- **Daemon** (`daemon.mjs`) — background ingestion of agent sessions. Writes `status.json` each cycle.
- **TUI** (`tui.mjs`) — read-only terminal dashboard (Ink/React 19). Polls `status.json`.
- **IPC** — `config.json` (CLI→daemon), `status.json` (daemon→TUI). No WebSocket, no shared SQLite.

### SDKs

- `apps/js-sdk` — published as `ultracontext` on npm. Bundles CLI + sync.
- `apps/python-sdk` — httpx, published on PyPI.

## Commands

```bash
pnpm install                                    # deps
pnpm ultracontext:db:up                         # start local Postgres (5433)
pnpm ultracontext:db:down                       # stop
pnpm ultracontext:db:reset                      # reset with volumes
pnpm ultracontext:db:migrate                    # apply schema
pnpm ultracontext:api                           # run API (port 8787)
pnpm dev:sync                                   # sync watch mode (daemon + TUI)
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
| `apps/sync`, `apps/js-sdk` | 2 spaces | double | kebab-case, PascalCase for React |

## Conventions

- **Commits**: Conventional Commits — `feat(api):`, `fix(tui):`
- **Tests**: `*.test.*` / `*.spec.*`, near changed code or `tests/`
- **Env**: `.env.example` → `.env`. Never commit secrets.
- **PRs**: one feature/fix, target `main`, include scope
- **Docs** (`apps/docs`): Mintlify MDX, YAML frontmatter, second-person voice

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
