# UltraContext Local Postgres

Local PostgreSQL setup used by the monorepo scripts (`pnpm ultracontext:db:*`).

## Start and stop

```bash
pnpm ultracontext:db:up
pnpm ultracontext:db:down
```

## Reset

```bash
pnpm ultracontext:db:reset
```

## Apply schema

```bash
pnpm ultracontext:db:migrate
```

The schema lives in `init.sql`. By default, the database listens on host port `5433`.
Copy `.env.example` to `.env` in this directory to override image, credentials, and port.

If your Docker volume was initialized with a different major PostgreSQL version, run `pnpm ultracontext:db:reset` (or remove the old `postgres_data` volume) before starting again.
