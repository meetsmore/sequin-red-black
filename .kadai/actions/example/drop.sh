#!/bin/bash
# kadai:name Drop
# kadai:emoji 🗑️
# kadai:description Drop a pipeline's colored variant (usage: set PIPELINE and COLOR env vars)
# kadai:confirm true

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/srb"

PIPELINE="${PIPELINE:-}"
COLOR="${COLOR:-}"

if [ -z "$PIPELINE" ] || [ -z "$COLOR" ]; then
  echo "Usage: PIPELINE=jobs COLOR=red bunx kadai run example/drop"
  echo ""
  echo "Available pipelines: jobs, clients"
  echo "Available colors: red, black, blue, green, purple, orange, yellow"
  exit 1
fi

echo "=== Dropping ${PIPELINE}:${COLOR} ==="
bun run src/cli.ts online drop "$PIPELINE" "$COLOR" \
  --sequin-context srb-local \
  --sequin-url http://localhost:7376 \
  --sequin-token srb-dev-token-secret \
  --opensearch-url http://localhost:9200
