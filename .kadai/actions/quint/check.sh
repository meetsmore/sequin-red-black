#!/bin/bash
# kadai:name Check All
# kadai:emoji ✅
# kadai:description Run typecheck, tests, invariants, and witnesses

set -euo pipefail

SPEC="docs/spec/quint/commands.qnt"
TEST="docs/spec/quint/commands_test.qnt"

echo "=== Typecheck ==="
quint typecheck "$TEST"
echo "OK"

echo ""
echo "=== Tests ==="
quint test "$TEST" --main=commands_test --match=test_

echo ""
echo "=== Invariants (SATISFIED = good) ==="
for inv in never_drop_active alias_integrity no_partial_pipelines disabled_not_backfilling; do
  printf "%-30s " "$inv"
  output=$(quint run "$SPEC" --main=commands --invariant="$inv" --max-steps=50 --max-samples=100 2>&1)
  if echo "$output" | grep -q "No violation found"; then
    echo "SATISFIED"
  else
    echo "FAILED"
    echo "$output"
    exit 1
  fi
done

echo ""
echo "=== Witnesses (VIOLATED = good) ==="
for wit in witness_pipeline_deployed witness_alias_set witness_backfill_completes witness_full_cycle; do
  printf "%-30s " "$wit"
  output=$(quint run "$SPEC" --main=commands --invariant="$wit" --max-steps=50 --max-samples=100 2>&1 || true)
  if echo "$output" | grep -q "Found an issue"; then
    echo "VIOLATED (reachable)"
  else
    echo "FAILED (not reachable)"
    echo "$output"
    exit 1
  fi
done

echo ""
echo "All checks passed."
