# UltraContext API

HTTP API backed by PostgreSQL or Supabase.

## Requirements

- Node.js 20+
- pnpm
- Database backend:
  - PostgreSQL (local `apps/postgres` or managed), or
  - Supabase project (service role key)

## Setup

```bash
pnpm install
cp .env.example .env.local
```

Fill `.env.local`:

- `DATABASE_PROVIDER` (`postgres` or `supabase`)
- `ULTRACONTEXT_ADMIN_KEY`
- `UC_TEST_API_KEY` (optional for manual tests)

Provider-specific vars:

- if `DATABASE_PROVIDER=postgres`: set `DATABASE_URL`
- if `DATABASE_PROVIDER=supabase`: set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

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
