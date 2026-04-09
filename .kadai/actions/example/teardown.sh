#!/bin/bash
# kadai:name Teardown
# kadai:emoji 💣
# kadai:description Stop Docker stack and remove all volumes
# kadai:confirm true

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== Stopping example stack ==="
docker compose -f example/docker-compose.yml down -v 2>/dev/null || true

echo "=== Stopping test stack ==="
docker compose -f srb/test/harness/docker-compose.yml down -v 2>/dev/null || true

echo "=== Cleaning temp files ==="
rm -f /tmp/srb-example-compiled.json /tmp/srb-test-compiled.json /tmp/srb-test-*.yml /tmp/srb-sequin-*.yaml

echo ""
echo "Done. All stacks stopped, volumes removed."
