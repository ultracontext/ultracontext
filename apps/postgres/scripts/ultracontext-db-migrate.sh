#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA_FILE="$POSTGRES_DIR/init.sql"

cd "$POSTGRES_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DB_USER="${POSTGRES_USER:-ultracontext}"
DB_NAME="${POSTGRES_DB:-ultracontext}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "Schema file not found: $SCHEMA_FILE"
  exit 1
fi

if ! docker compose ps --services --status running | grep -qx "postgres"; then
  echo "Starting postgres service..."
  docker compose up -d postgres
fi

echo "Applying schema to database '$DB_NAME' as user '$DB_USER'..."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SCHEMA_FILE"

echo "Migration complete."
