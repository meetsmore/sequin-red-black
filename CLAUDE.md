# Red-Black Deployment Orchestrator (srb)

Stateless tool that manages red-black deployments of CDC pipelines (Postgres -> Sequin -> OpenSearch). Formally specified in Quint, implemented in TypeScript/Bun.

## Project structure

```
srb/                             # TypeScript/Bun CLI implementation
  src/
    config/                      # Types, color utils, config loader
    planner/                     # Pure diff logic (effects.ts, plan.ts)
    executor/                    # Execute effects via Sequin CLI/API + OpenSearch
    sequin/                      # Sequin CLI wrapper, API client, YAML generator
    opensearch/                  # OpenSearch REST client
    state/                       # Live state discovery
    offline/                     # srb offline compile
    online/                      # srb online {plan,apply,activate,backfill,drop}
    cli.ts                       # Commander entry point
  test/
    unit/                        # Pure planner tests (no network)
    harness/                     # Docker stack, helpers, API clients
    e2e/                         # E2E tests against real Sequin + OpenSearch
docs/spec/quint/
  types.qnt                      # All types: colors, resource configs/states, effects, plans
  state.qnt                      # State variables, init, config loading, helpers
  effects.qnt                    # Pure diff logic: desired vs live -> effects
  plan.qnt                       # Multi-pipeline plan generation
  commands.qnt                   # The 5 commands, invariants, witnesses, step action
  commands_test.qnt              # 22 tests: unit, integration, e2e scenarios
example/                         # Example deployment (Docker + webapp)
  indexes/                       # Per-pipeline config (jobs, clients)
  docker-compose.yml             # Postgres, Redis, Sequin, OpenSearch
  webapp/                        # Demo frontend + API server
```

## Key concepts

- **Pipeline**: A CDC flow (e.g., "jobs", "clients") from Postgres to OpenSearch
- **Colored variant**: A pipeline deployed at a specific color (e.g., jobs_red, jobs_black). Bundles exactly {sink, index, transform, enrichment}
- **Colors**: 7 available (Red, Black, Blue, Green, Purple, Orange, Yellow). Usually 2 active, occasionally 3 for testing
- **Stateless**: The tool stores no state. All state is derived from live Sequin API + OpenSearch queries. Active color determined by which index the root alias points to

## Commands

1. `srb offline compile` -- load per-pipeline configs, output compiled.json
2. `srb online plan` -- diff compiled config vs live state, output effects (exit 0 = no changes, exit 2 = changes pending)
3. `srb online apply [--skip-backfill] [--auto-approve]` -- plan + execute
4. `srb online backfill <pipeline> <color>` -- manually trigger a backfill
5. `srb online activate <pipeline> <color>` -- swap alias to point to specified color (idempotent)
6. `srb online drop <pipeline> <color>` -- delete all resources for a pipeline+color

## External dependencies

- **Sequin CLI** (`sequin config plan/apply/export`) -- declarative resource management for sinks, transforms, enrichments
- **Sequin REST API** -- imperative operations (trigger backfill, query sink status)
- **OpenSearch REST API** -- index CRUD, alias management, reindex

## Running

```bash
# Example stack
bunx kadai run example/setup     # Docker + webapp + compile
bunx kadai run example/plan      # See what srb would do
bunx kadai run example/apply     # Apply config
PIPELINE=jobs COLOR=red bunx kadai run example/activate   # Swap alias
PIPELINE=jobs COLOR=red bunx kadai run example/drop       # Drop color

# Tests
cd srb
bun test                         # All tests (unit + E2E, needs test Docker stack)
bun test test/unit/              # Unit tests only (no network)
make test-stack-up               # Start test Docker stack
bun test test/e2e/               # E2E tests (needs test stack running)
make test-stack-down             # Stop test Docker stack

# Development
cd srb && bun run typecheck      # TypeScript typecheck
bunx kadai run quint/check       # Quint typecheck + tests + invariants
```

## Spec-first rule

Any implementation change that introduces new invariants, behaviors, or constraints NOT already documented in the Quint specs (`docs/spec/quint/`) MUST update the Quint specs first. The specs are the source of truth — implementation follows the spec, never the other way around.

## Quint commands

```bash
# Typecheck (run after every change)
quint typecheck docs/spec/quint/commands.qnt

# Run all tests (always use --match to avoid running builtins)
quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_

# Run a specific test
quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_e2e_fresh_setup

# Check invariants (SATISFIED = good)
quint run docs/spec/quint/commands.qnt --main=commands --invariant=never_drop_active --max-steps=50 --max-samples=100

# Check witnesses (VIOLATED = good, means state is reachable)
quint run docs/spec/quint/commands.qnt --main=commands --invariant=witness_pipeline_deployed --max-steps=50 --max-samples=100

# Debug a failing test
quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_name --verbosity=3
```

## Quint language gotchas for this codebase

- **Map membership**: `key.in(map.keys())` -- NOT `map.has(key)` (doesn't exist in 0.32.0)
- **Map remove**: `map.keys().exclude(Set(key)).mapBy(k => map.get(k))` -- no `mapRemove` available
- **val scoping in `all {}`**: `val` bindings don't flow across commas. Move `val` before the `all {}`:
  ```quint
  // WRONG:
  .then(all { val x = foo(), assert(x == 1), ... })
  // RIGHT:
  .then(val x = foo() all { assert(x == 1), ... })
  ```
- **Typed IDs**: Resource IDs use newtype wrappers (`Sid`, `Iid`, `Tid`, `Eid`). Construct with e.g. `Sid("my_sink")`. The typechecker enforces you can't pass a SinkId where an IndexId is expected
- **Sink status**: Two orthogonal dimensions -- `lifecycle: SinkLifecycle` (Active/Paused/Disabled, exclusive) and `backfilling: bool` (independent). A sink can be Active+backfilling or Paused+backfilling, but never Disabled+backfilling
- **Test fixtures**: Prefixed `fixture_` not `test_` to avoid `--match=test_` running them as tests
- **Every action must assign all 4 state vars**: `desired_pipelines'`, `live_pipelines'`, `aliases'`, `current_plans'`
