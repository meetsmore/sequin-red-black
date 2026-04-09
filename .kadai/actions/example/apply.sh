#!/bin/bash
# kadai:name Apply
# kadai:emoji 🚀
# kadai:description Run srb apply against the example stack
# kadai:confirm true

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/srb"

# Compile first (in case configs changed)
bun run src/cli.ts offline compile --indexes ../example/indexes --out /tmp/srb-example-compiled.json

echo ""
echo "=== Apply ==="
bun run src/cli.ts online apply \
  --compiled /tmp/srb-example-compiled.json \
  --sequin-context srb-local \
  --sequin-url http://localhost:7376 \
  --sequin-token srb-dev-token-secret \
  --opensearch-url http://localhost:9200 \
  --auto-approve
