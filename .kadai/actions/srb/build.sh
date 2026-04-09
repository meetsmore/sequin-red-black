#!/bin/bash
# kadai:name Build
# kadai:emoji 📦
# kadai:description Compile srb into a single self-contained binary

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/srb"

echo "=== Building srb ==="
bun build --compile --target=bun src/cli.ts --outfile srb

echo ""
ls -lh srb
echo ""
echo "Binary ready: srb/srb"
