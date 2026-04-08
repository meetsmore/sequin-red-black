# Red-Black Deployment Orchestrator — Quint Spec Design

## Overview

Formal specification for a stateless tool that manages red-black deployments of CDC pipelines (Postgres → Sequin → OpenSearch). The tool reads per-pipeline config directories, compiles them into a Sequin config, compares against live state from Sequin API and OpenSearch, and produces a terraform-style plan of effects.

## Core Concepts

### Pipeline

A CDC pipeline (e.g., "jobs", "clients") captures changes from a Postgres table and lands them in an OpenSearch index, with transforms and enrichments along the way.

### Colored Variant

A pipeline has one or more **colored variants** (e.g., `jobs_red`, `jobs_black`). Each variant is a fixed bundle of exactly 4 resources:
- **Sink** (Sequin) — captures CDC changes
- **Index** (OpenSearch) — stores the data
- **Transform** (Sequin) — shapes data for the index
- **Enrichment** (Sequin) — joins additional data

Usually at most 2 colors are active, though a 3rd (e.g., `purple`) may exist for testing. Resources either exist or don't — no "disabled" state.

### Active Color

Determined by which colored index the root OpenSearch alias points to. E.g., alias `jobs` → `jobs_red` means red is active for the `jobs` pipeline. Each pipeline can have a different active color.

### Statelessness

The tool stores no state. All state is derived from live Sequin API + OpenSearch queries. Any metadata the tool needs is stored as annotations on Sequin resources.

## User Workflow

### Config Authoring

Users write per-pipeline config directories (`jobs/`, `clients/`), defining mapping, transform, enrichment, and sink settings. Configs are color-agnostic — users never think about colors.

### Compile (Separate Step)

A pure `compile` function merges per-pipeline config directories into one compiled Sequin config file. This is a prerequisite to all other commands but is modeled separately — plan/apply/etc. receive the compiled config as input.

### The 4 Commands

Executed as separate GitHub Actions with potentially long gaps between them (manual testing may occur between steps):

1. **`plan`** — Diff compiled config vs live state. Output: list of effects grouped by pipeline. Pure computation, no side effects.
2. **`apply`** — Same code path as `plan` (generates the plan), then executes the effects. Create new colored index, sink, transform, enrichment. Trigger backfill. Sequin config push is atomic (one compiled file). OpenSearch index creation is per-index.
3. **`activate <pipeline> <color>`** — Swap the root alias to point to the specified colored index. Takes color as argument to support scenarios with >2 colors available. Per-pipeline operation.
4. **`drop <pipeline> <color>`** — Delete all resources for that pipeline+color. Per-pipeline+color operation.

## Effect Derivation Rules

### Current Simplification

For now, **any change to any resource in a pipeline triggers the full red-black flow**:
1. Create new colored index
2. Create sink, transform, enrichment pointing at new color
3. Trigger backfill

There is no "update in place" path. Every change is a new color deployment.

### Future Expansion

The spec is structured to support per-field, per-change-kind (add/update/delete) effect rules later. For example, a future rule might say "mapping field removal only requires an OpenSearch update, no backfill." The effect types remain granular to support this:

- CreateSink, CreateIndex, CreateTransform, CreateEnrichment
- DeleteSink, DeleteIndex, DeleteTransform, DeleteEnrichment
- TriggerBackfill
- TriggerReindex
- SwapAlias

Even though current rules always produce the same set of effects, keeping granular types avoids restructuring when rules are refined.

### Pipeline-Level Changes

- **New pipeline** (exists in desired, no live state) → Create all resources for a new color + backfill
- **Pipeline removed** (no desired state, exists live) → Delete all resources for all colors

## State Model

### Desired State

Loaded from compiled config. Keyed by `PipelineName` (color-agnostic):

```
var desired_pipelines: PipelineName -> PipelineConfig
```

`PipelineConfig` bundles the color-agnostic settings: sink config, index config (mapping, settings), transform config, enrichment config.

### Live State

Discovered from Sequin API + OpenSearch. Keyed by `(PipelineName, Color)`:

```
var live_pipelines: (PipelineName, Color) -> LivePipelineState
```

`LivePipelineState` contains the live state of all 4 resources in a colored group.

### Alias State

Tracks which color each pipeline's alias points to:

```
var aliases: PipelineName -> Color
```

## Type Design

### Color (7 variants)

```quint
type Color = Red | Black | Blue | Green | Purple | Orange | Yellow
```

Bounded set for model checking. 7 is sufficient.

### Resource Types

Retain existing config/state types from skeleton (`SinkConfig`, `IndexConfig`, `TransformConfig`, `EnrichmentConfig` and corresponding state types) with one change: remove `color` field from `SinkState` and `IndexState` — color is determined by the `ColoredPipeline` grouping, not stored per-resource.

### Pipeline Types

```quint
type PipelineName = str

type PipelineConfig = {
  name: PipelineName,
  sink: SinkConfig,
  index: IndexConfig,
  transform: TransformConfig,
  enrichment: EnrichmentConfig
}

type LivePipelineState = {
  sink: SinkState,
  index: IndexState,
  transform: TransformState,
  enrichment: EnrichmentState
}
```

### Change Detection

```quint
type ChangeKind = NoChange | Create | Delete | Update

type FieldChange = {
  field_name: str,
  requires_backfill: bool,
  requires_reindex: bool
}

type ResourceChange = {
  resource_id: ResourceId,
  kind: ChangeKind,
  desired: ResourceConfig,
  field_changes: Set[FieldChange]
}
```

Retained from skeleton. `FieldChange` flags are unused under current simplified rules but present for future expansion.

### Effects

```quint
type Effect =
  | CreateSink(SinkConfig)
  | CreateIndex(IndexConfig)
  | CreateTransform(TransformConfig)
  | CreateEnrichment(EnrichmentConfig)
  | DeleteSink(ResourceId)
  | DeleteIndex(ResourceId)
  | DeleteTransform(ResourceId)
  | DeleteEnrichment(ResourceId)
  | TriggerBackfill(ResourceId)
  | TriggerReindex(ResourceId)
  | SwapAlias({ pipeline: PipelineName, color: Color })
```

Update variants (`UpdateSink`, etc.) removed for now since all changes go through the full red-black flow. Can be re-added when per-field rules distinguish in-place updates.

### Plan

```quint
type EffectStatus = Pending | InProgress | Completed | Failed(str)

type PlannedEffect = {
  effect: Effect,
  status: EffectStatus,
  depends_on: Set[int],
  order: int
}

type Plan = {
  pipeline: PipelineName,
  target_color: Color,
  changes: Set[ResourceChange],
  effects: List[PlannedEffect]
}
```

Plan is per-pipeline. A full plan output is a `Set[Plan]` (one per changed pipeline). The `apply` command operates on the full set — Sequin resource creation is pushed as one atomic config, while OpenSearch index creation happens per-index.

### Target Color Selection

When planning a new deployment for a pipeline, the tool picks the target color by selecting a color that has no live resources for that pipeline. If multiple colors are unused, the choice is non-deterministic in the spec (the implementation can use any strategy — e.g., prefer red/black alternation).

## Module Structure

| File | Purpose |
|------|---------|
| `types.qnt` | All types: Color, resource configs/states, PipelineConfig, LivePipelineState, effects, plan |
| `effects.qnt` | Effect derivation rules: desired x live → effects. Pure functions only. |
| `state.qnt` | State variables (desired_pipelines, live_pipelines, aliases), init, config loading |
| `plan.qnt` | Plan generation: calls effect derivation, structures results |
| `commands.qnt` | The 4 commands as actions: plan, apply, activate, drop. Preconditions and invariants. |
| `srb.qnt` | Compile function (pure): per-pipeline configs → compiled config. Separate concern. |

### Key Changes from Skeleton

- `redblack.qnt` → `commands.qnt`: The continuous phase state machine becomes 4 discrete commands with precondition checks. No phase variable — the tool is stateless and re-derives "where am I" from live state each time.
- New `effects.qnt`: Splits effect derivation from plan structure.
- `srb.qnt`: Becomes the compile module.
- State model: Flat per-resource maps replaced with pipeline-grouped maps.

## Invariants

Safety properties the spec should verify:

1. **Never drop active color**: `drop(pipeline, color)` requires `aliases.get(pipeline) != color`
2. **Never activate un-backfilled color**: `activate(pipeline)` requires the target color's sink status is not `SinkBackfilling`
3. **Apply before activate**: Can't swap alias to a color that has no live resources
4. **Alias integrity**: Alias always points to an existing index
5. **Atomic Sequin push**: All Sequin resource changes in an `apply` are bundled into one config push
6. **Partial resources should not be possible for a pipeline**: If an index is deleted by `srb`, then the transform, sink, enrichment should also be deleted.

## Testing Strategy

- **Witnesses**: Demonstrate valid deployment flows (create → backfill → activate → drop)
- **Invariant checks**: Verify safety properties hold across all reachable states
- **Scenario tests**: Multi-pipeline deployments, concurrent color existence, rollback (activate back to old color before dropping)
