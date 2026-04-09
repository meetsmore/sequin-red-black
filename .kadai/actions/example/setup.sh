#!/bin/bash
# kadai:name Setup Example
# kadai:emoji 🏗️
# kadai:description Start Docker stack, wait for health, compile config, and launch webapp

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== Starting Docker stack ==="
docker compose -f example/docker-compose.yml up -d

echo ""
echo "=== Waiting for services ==="
for i in $(seq 1 60); do
  os=$(curl -sf http://localhost:9200/_cluster/health 2>/dev/null | grep -o '"status":"[^"]*"' || echo "not ready")
  seq=$(curl -sf http://localhost:7376/health 2>/dev/null && echo " ok" || echo "not ready")
  if [[ "$os" == *"green"* || "$os" == *"yellow"* ]] && [[ "$seq" == *"ok"* ]]; then
    echo "All services healthy!"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Timed out waiting for services"
    exit 1
  fi
  printf "."
  sleep 2
done

echo ""
echo "=== Ensuring sequin context ==="
if ! sequin context ls 2>&1 | grep -q "srb-local"; then
  sequin context add srb-local --hostname localhost:7376 --no-tls --api-token srb-dev-token-secret --set-default <<< "n" || true
fi

echo ""
echo "=== Compiling srb config ==="
cd srb
bun run src/cli.ts offline compile --indexes ../example/indexes --out /tmp/srb-example-compiled.json

echo ""
echo "=== Starting webapp ==="
echo "Launching webapp at http://localhost:3000"
cd ../example/webapp
bun install --silent 2>/dev/null || true
bun run server.ts &
WEBAPP_PID=$!
echo "Webapp PID: $WEBAPP_PID"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Services:"
echo "  Sequin:     http://localhost:7376"
echo "  OpenSearch:  http://localhost:9200"
echo "  Postgres:    localhost:7377"
echo "  Webapp:      http://localhost:3000"
echo ""
echo "Next steps:"
echo "  bunx kadai run example/plan    # See what srb would do"
echo "  bunx kadai run example/apply   # Apply the config"
