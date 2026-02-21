#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing root .env file at $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

BASE_URL="${ULTRACONTEXT_BASE_URL:-http://127.0.0.1:8787}"
ADMIN_KEY="${ULTRACONTEXT_ADMIN_KEY:-}"
KEY_NAME="${1:-local-dev}"

if [[ -z "$ADMIN_KEY" ]]; then
  echo "Missing ULTRACONTEXT_ADMIN_KEY in $ENV_FILE"
  exit 1
fi

echo "Requesting API key from $BASE_URL/v1/keys ..."
response="$(curl -fsS \
  -X POST "$BASE_URL/v1/keys" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$KEY_NAME\"}")"

api_key="$(printf '%s' "$response" | node -e "let raw=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { raw += chunk; }); process.stdin.on('end', () => { const data = JSON.parse(raw || '{}'); if (!data.key) process.exit(2); process.stdout.write(String(data.key)); });")" || {
  echo "Failed to parse API response: $response"
  exit 1
}

tmp_file="$(mktemp)"
awk -v key="$api_key" '
  BEGIN { replaced = 0 }
  /^ULTRACONTEXT_API_KEY=/ {
    print "ULTRACONTEXT_API_KEY=" key
    replaced = 1
    next
  }
  { print }
  END {
    if (!replaced) print "ULTRACONTEXT_API_KEY=" key
  }
' "$ENV_FILE" > "$tmp_file"
mv "$tmp_file" "$ENV_FILE"

echo "Updated ULTRACONTEXT_API_KEY in $ENV_FILE"
echo "New key prefix: ${api_key:0:12}"
