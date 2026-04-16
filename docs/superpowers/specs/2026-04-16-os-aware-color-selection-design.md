# OpenSearch-Aware Color Selection

## Problem

State discovery is entirely Sequin-driven. It iterates exported Sequin sinks to build live state. When OpenSearch has pre-existing indices (e.g. from pgsync) but Sequin has no sinks, the planner sees zero live state, generates "create" plans targeting the first color (red), and crashes when that color's index already exists in OpenSearch.

This is a migration scenario: pgsync manages `jobs_red` (with alias `jobs` → `jobs_red`), and srb needs to deploy alongside it without conflicting.

## Design

### New State Variable: `os_indices`

Add a 5th state variable to `state.qnt`:

```quint
// OpenSearch indices that exist but are NOT managed by Sequin.
// Represents "foreign" indices that occupy a color slot.
var os_indices: Set[(PipelineName, Color)]
```

This is a simple set of `(pipeline, color)` pairs. No `LivePipelineState` because there's no sink/transform/enrichment — just "this color is taken in OpenSearch."

### New Action: `discover_os_index`

Models discovering a foreign OS index during state discovery:

```quint
action discover_os_index(pipeline: PipelineName, color: Color): bool = all {
  os_indices' = os_indices.union(Set((pipeline, color))),
  desired_pipelines' = desired_pipelines,
  live_pipelines' = live_pipelines,
  aliases' = aliases,
  current_plans' = current_plans,
}
```

### Changes to `pick_target_color`

Signature gains `os_indices` parameter. Available colors must not appear in either `live_pipelines` or `os_indices`:

```quint
pure def pick_target_color(
  pipeline: PipelineName,
  live: (PipelineName, Color) -> LivePipelineState,
  os_indices: Set[(PipelineName, Color)],
  all_colors: Set[Color]
): Color =
  val available = all_colors.filter(c =>
    not((pipeline, c).in(live.keys())) and not((pipeline, c).in(os_indices))
  )
  available.fold(Red, (acc, c) => c)
```

Similarly update `available_colors` in `state.qnt`.

### `pipeline_change_kind` Unchanged

A pipeline with foreign OS indices but no Sequin sinks is still `Create`. srb is creating its first *managed* variant. The OS indices only constrain which color it picks.

### Changes to `cmd_drop`

`cmd_drop` must handle dropping foreign OS indices (the old pgsync index after migration). The existing `never_drop_active` invariant protects against dropping a color the alias points to — this applies equally to foreign indices. You must `activate` the new Sequin-managed color before dropping the old pgsync one.

```quint
action cmd_drop(pipeline: PipelineName, color: Color): bool = all {
  // Precondition: color exists in EITHER live_pipelines or os_indices
  or { (pipeline, color).in(live_pipelines.keys()), (pipeline, color).in(os_indices) },
  // Precondition: not dropping the active color (applies to both managed and foreign)
  if (pipeline.in(aliases.keys())) aliases.get(pipeline) != color else true,
  // Remove from whichever set it belongs to
  live_pipelines' = live_pipelines.keys().exclude(Set((pipeline, color))).mapBy(k => live_pipelines.get(k)),
  os_indices' = os_indices.exclude(Set((pipeline, color))),
  desired_pipelines' = desired_pipelines,
  aliases' = aliases,
  current_plans' = current_plans,
}
```

### Changes to `generate_plans`

Passes `os_indices` through to `pick_target_color`. Plan generation logic itself is unchanged.

### All Other Actions

Every action gains `os_indices' = os_indices` (identity assignment). Actions affected:
- `init` (adds `os_indices' = Set()`)
- `cmd_plan`, `cmd_apply`, `cmd_activate`, `cmd_backfill`
- `backfill_completes`, `reindex_completes`
- `load_desired_config`, `discover_live_state`, `discover_alias`

### `step` Action

Adds a new branch for `discover_os_index` so the model checker can explore states with foreign indices.

### New Invariants

**OS and live state are disjoint:**
```quint
val os_live_disjoint: bool =
  os_indices.forall(k => not(k.in(live_pipelines.keys())))
```

**Plans never target a color occupied by a foreign OS index:**
```quint
val never_target_occupied_os_color: bool =
  current_plans.forall(p =>
    not((p.pipeline, p.target_color).in(os_indices))
  )
```

### New Tests

1. **`test_pick_target_color_skips_os_indices`** — Pure function test. When `os_indices` contains `(jobs, Red)`, `pick_target_color` returns a color other than Red.

2. **`test_drop_foreign_os_index`** — `cmd_drop` on a color in `os_indices` removes it, making the color available again.

3. **`test_e2e_migration_from_pgsync`** — Core scenario: `jobs_red` exists as foreign OS index, alias `jobs` → `jobs_red`. Load config, apply picks different color, backfill, activate new color, drop old foreign index.

4. **`test_e2e_migration_multi_pipeline`** — Multiple pipelines with foreign OS indices at different colors. Each picks a non-conflicting color.

5. **Invariant checking via `step`** — `os_live_disjoint` and `never_target_occupied_os_color` hold across all reachable states.

## Implementation Notes (post-spec)

After the Quint spec is updated and passes, the TypeScript implementation follows:

- `discoverLiveState` gains an OpenSearch scan: list all indices matching `{pipeline}_{color}` pattern, subtract those already in Sequin-managed `live_pipelines`, populate `os_indices` (returned as `occupiedColors` in `LiveState`)
- `pickTargetColor` in `plan.ts` takes the occupied set
- `formatPlans` emits warnings for unmanaged OS indices
- `cmd_drop` executor handles deleting an index that has no Sequin sink
