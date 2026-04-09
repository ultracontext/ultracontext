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

## Built-in activity views

The shared schema now exposes two views for product measurement:

- `project_activity_daily`: per-project, per-day activity, broken out by `metadata.source`
- `project_activity_weekly`: weekly rollup of the same data

Both views expose:

- `project_id`, `project_name`
- `source`
- node, message, context, and root-context counts
- `first_event_at`, `last_event_at`
- `latest_api_key_last_used_at`
- `active_api_keys`

Example, top active projects in the last 8 weeks:

```sql
SELECT
  activity_week,
  source,
  project_name,
  active_days,
  node_count,
  message_count,
  context_count,
  root_context_count,
  latest_api_key_last_used_at
FROM project_activity_weekly
WHERE activity_week >= DATE_TRUNC('week', NOW()) - INTERVAL '8 weeks'
ORDER BY activity_week DESC, node_count DESC;
```

Example, OpenClaw wedge only:

```sql
SELECT
  activity_week,
  project_name,
  active_days,
  node_count,
  message_count,
  context_count
FROM project_activity_weekly
WHERE source = 'openclaw'
  AND activity_week >= DATE_TRUNC('week', NOW()) - INTERVAL '8 weeks'
ORDER BY activity_week DESC, node_count DESC;
```

Example, top active users to interview this week:

```sql
SELECT
  project_name,
  source,
  active_days,
  node_count,
  message_count,
  context_count,
  last_event_at,
  latest_api_key_last_used_at
FROM project_activity_weekly
WHERE activity_week = DATE_TRUNC('week', NOW())
ORDER BY node_count DESC, last_event_at DESC
LIMIT 20;
```

Example, stalled users to win back:

```sql
WITH current_week AS (
  SELECT project_id, source, node_count, last_event_at
  FROM project_activity_weekly
  WHERE activity_week = DATE_TRUNC('week', NOW())
), previous_4_weeks AS (
  SELECT
    project_id,
    source,
    SUM(node_count) AS node_count,
    MAX(last_event_at) AS last_event_at
  FROM project_activity_weekly
  WHERE activity_week >= DATE_TRUNC('week', NOW()) - INTERVAL '4 weeks'
    AND activity_week < DATE_TRUNC('week', NOW())
  GROUP BY project_id, source
)
SELECT
  p4.project_id,
  p4.source,
  p4.node_count AS prior_4w_nodes,
  p4.last_event_at AS prior_last_event_at,
  cw.last_event_at AS current_last_event_at
FROM previous_4_weeks p4
LEFT JOIN current_week cw
  ON cw.project_id = p4.project_id
 AND cw.source = p4.source
WHERE COALESCE(cw.node_count, 0) = 0
ORDER BY p4.node_count DESC, p4.last_event_at DESC
LIMIT 20;
```
