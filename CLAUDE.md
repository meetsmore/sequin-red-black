# Red-Black Deployment Orchestrator (srb)

Quint formal specification for a stateless tool that manages red-black deployments of CDC pipelines (Postgres -> Sequin -> OpenSearch).

## Project structure

```
srb.qnt                      # Compile module: per-pipeline configs -> compiled Sequin config
docs/spec/quint/
  types.qnt                  # All types: colors, resource configs/states, effects, plans
  state.qnt                  # State variables, init, config loading, helpers
  effects.qnt                # Pure diff logic: desired vs live -> effects
  plan.qnt                   # Multi-pipeline plan generation
  commands.qnt               # The 5 commands, invariants, witnesses, step action
  commands_test.qnt          # 22 tests: unit, integration, e2e scenarios
docs/superpowers/
  specs/                     # Design spec
  plans/                     # Implementation plan
```

## Key concepts

- **Pipeline**: A CDC flow (e.g., "jobs", "clients") from Postgres to OpenSearch
- **Colored variant**: A pipeline deployed at a specific color (e.g., jobs_red, jobs_black). Bundles exactly {sink, index, transform, enrichment}
- **Colors**: 7 available (Red, Black, Blue, Green, Purple, Orange, Yellow). Usually 2 active, occasionally 3 for testing
- **Stateless**: The tool stores no state. All state is derived from live Sequin API + OpenSearch queries. Active color determined by which index the root alias points to

## Commands modeled in the spec

1. `cmd_plan` -- diff compiled config vs live state, output effects
2. `cmd_apply(skip_backfill)` -- plan + execute. When skip_backfill=true, sinks start without backfilling
3. `cmd_backfill(pipeline, color)` -- manually trigger a backfill (for when skip_backfill was used)
4. `cmd_activate(pipeline, color)` -- swap alias to point to specified color
5. `cmd_drop(pipeline, color)` -- delete all resources for a pipeline+color

## Effect derivation (current simplification)

Any change to any resource in a pipeline triggers the full red-black flow: create new colored index + sink + transform + enrichment, then backfill. No in-place updates. This will be refined later with per-field, per-change-kind rules.

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
