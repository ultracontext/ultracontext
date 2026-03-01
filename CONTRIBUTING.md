# Contributing

Thanks for your interest in contributing to UltraContext!

## Setup

```bash
git clone https://github.com/ultracontext/ultracontext.git
cd ultracontext
pnpm install
```

### Run the Context API locally

```bash
# start PostgreSQL
pnpm ultracontext:db:up

# apply schema
pnpm ultracontext:db:migrate

# generate a dev API key
pnpm ultracontext:key:local

# start the API
pnpm ultracontext:api
```

### Run the Context Hub locally

```bash
pnpm dev:daemon    # start ingestor
pnpm dev:tui       # start TUI dashboard
```

## Monorepo structure

| Directory | What it is |
|-----------|-----------|
| `apps/api` | Context API (Hono + Drizzle) |
| `apps/js-sdk` | Node.js SDK + CLI (`ultracontext` npm package) |
| `apps/python-sdk` | Python SDK |
| `apps/daemon` | Ingestor (dev mode) |
| `apps/tui` | TUI dashboard (dev mode) |
| `apps/postgres` | Docker Compose + schema for local PostgreSQL |
| `apps/docs` | Documentation (Mintlify) |

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org):

```
feat(api): add new endpoint
fix(cli): resolve startup crash
docs: update quickstart guide
refactor(tui): simplify layout logic
```

## Before opening a PR

1. Open an issue first for large changes — let's discuss the approach before writing code.
2. Keep PRs focused — one feature or fix per PR.
3. Target the `dev` branch, not `main`.

## Need help?

Open an issue or reach out on [Discord](https://discord.gg/ultracontext).
