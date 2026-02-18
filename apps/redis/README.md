# UltraContext Redis

Local Redis service for daemon/TUI state and idempotency.

## Start

```bash
cd apps/redis
docker compose up -d
```

## Stop

```bash
cd apps/redis
docker compose down
```

## Daemon env

Use this in `apps/daemon/.env`:

```bash
REDIS_URL=redis://127.0.0.1:6379
```
