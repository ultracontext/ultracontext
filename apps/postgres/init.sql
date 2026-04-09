CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_id TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  name TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nodes (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parent_id TEXT,
  prev_id TEXT,
  context_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_project_type_context
  ON nodes (project_id, type, context_id);

CREATE INDEX IF NOT EXISTS idx_nodes_context
  ON nodes (context_id);

CREATE INDEX IF NOT EXISTS idx_nodes_prev
  ON nodes (prev_id);

CREATE INDEX IF NOT EXISTS idx_nodes_created_at
  ON nodes (created_at);

CREATE INDEX IF NOT EXISTS idx_nodes_metadata
  ON nodes USING GIN (metadata);

CREATE INDEX IF NOT EXISTS idx_api_keys_project_id
  ON api_keys (project_id);

CREATE OR REPLACE VIEW project_activity_daily AS
WITH node_activity AS (
  SELECT
    n.project_id,
    p.name AS project_name,
    DATE_TRUNC('day', n.created_at) AS activity_day,
    COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown') AS source,
    COUNT(*) AS node_count,
    COUNT(*) FILTER (WHERE n.type <> 'context') AS message_count,
    COUNT(*) FILTER (WHERE n.type = 'context') AS context_count,
    COUNT(*) FILTER (WHERE n.type = 'context' AND n.context_id IS NULL) AS root_context_count,
    MIN(n.created_at) AS first_event_at,
    MAX(n.created_at) AS last_event_at
  FROM nodes n
  JOIN projects p ON p.id = n.project_id
  GROUP BY
    n.project_id,
    p.name,
    DATE_TRUNC('day', n.created_at),
    COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown')
)
SELECT
  na.project_id,
  na.project_name,
  na.activity_day,
  na.source,
  na.node_count,
  na.message_count,
  na.context_count,
  na.root_context_count,
  na.first_event_at,
  na.last_event_at,
  MAX(ak.last_used_at) AS latest_api_key_last_used_at,
  COUNT(DISTINCT ak.id) FILTER (WHERE ak.last_used_at IS NOT NULL) AS active_api_keys
FROM node_activity na
LEFT JOIN api_keys ak ON ak.project_id = na.project_id
GROUP BY
  na.project_id,
  na.project_name,
  na.activity_day,
  na.source,
  na.node_count,
  na.message_count,
  na.context_count,
  na.root_context_count,
  na.first_event_at,
  na.last_event_at;

CREATE OR REPLACE VIEW project_activity_weekly AS
SELECT
  project_id,
  project_name,
  DATE_TRUNC('week', activity_day) AS activity_week,
  source,
  COUNT(*) AS active_days,
  SUM(node_count) AS node_count,
  SUM(message_count) AS message_count,
  SUM(context_count) AS context_count,
  SUM(root_context_count) AS root_context_count,
  MIN(first_event_at) AS first_event_at,
  MAX(last_event_at) AS last_event_at,
  MAX(latest_api_key_last_used_at) AS latest_api_key_last_used_at,
  MAX(active_api_keys) AS active_api_keys
FROM project_activity_daily
GROUP BY
  project_id,
  project_name,
  DATE_TRUNC('week', activity_day),
  source;
