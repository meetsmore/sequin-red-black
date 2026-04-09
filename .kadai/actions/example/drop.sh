#!/bin/bash
# kadai:name Drop
# kadai:emoji 🗑️
# kadai:description Drop a pipeline's colored variant
# kadai:confirm true

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/srb"

if [ -z "${PIPELINE:-}" ]; then
  printf "Pipeline (jobs, clients): "
  read -r PIPELINE
fi

if [ -z "${COLOR:-}" ]; then
  printf "Color (red, black, blue, green, purple, orange, yellow): "
  read -r COLOR
fi

echo "=== Dropping ${PIPELINE}:${COLOR} ==="
bun run src/cli.ts online drop "$PIPELINE" "$COLOR" \
  --sequin-context srb-local \
  --sequin-url http://localhost:7376 \
  --sequin-token srb-dev-token-secret \
  --opensearch-url http://localhost:9200
