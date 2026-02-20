# UltraContext API

HTTP API backed by PostgreSQL.

## Requirements

- Node.js 20+
- pnpm
- PostgreSQL database (local `apps/postgres` or managed)

## Setup

```bash
pnpm install
cp .env.example .env.local
```

Fill `.env.local`:

- `DATABASE_URL`
- `ULTRACONTEXT_ADMIN_KEY`
- `UC_TEST_API_KEY` (optional for manual tests)

## Database schema

Use the shared SQL schema at `../postgres/init.sql`.

## Project structure

- `src/app.ts`: app bootstrap and module wiring.
- `src/config.ts`: runtime config from environment variables.
- `src/middleware/`: auth and database middlewares.
- `src/routes/`: route modules (`root`, `keys`, `contexts`).
- `src/domain/`: core domain logic (ids, keys, context chain/version helpers).
- `src/db.ts`: Drizzle schema and client factory.
- `src/utils/`: shared request/utility helpers.

## Run

```bash
pnpm run dev
```
