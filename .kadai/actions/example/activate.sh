#!/bin/bash
# kadai:name Activate
# kadai:emoji 🔄
# kadai:description Swap alias to a pipeline's color (usage: set PIPELINE and COLOR env vars)
# kadai:confirm true

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/srb"

PIPELINE="${PIPELINE:-}"
COLOR="${COLOR:-}"

if [ -z "$PIPELINE" ] || [ -z "$COLOR" ]; then
  echo "Usage: PIPELINE=jobs COLOR=black bunx kadai run example/activate"
  echo ""
  echo "Available pipelines: jobs, clients"
  echo "Available colors: red, black, blue, green, purple, orange, yellow"
  exit 1
fi

echo "=== Activating ${PIPELINE} → ${COLOR} ==="
bun run src/cli.ts online activate "$PIPELINE" "$COLOR" \
  --sequin-context srb-local \
  --sequin-url http://localhost:7376 \
  --sequin-token srb-dev-token-secret \
  --opensearch-url http://localhost:9200
