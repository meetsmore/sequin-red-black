# Pipeline Syncs: Subordinate Webhook Sinks in the Red-Black Lifecycle

## Problem

SRB manages primary CDC pipelines (Postgres table -> Sequin elasticsearch sink -> OpenSearch index). Each pipeline owns one index and follows the red-black color lifecycle.

In practice, OpenSearch indexes are denormalized. When a related table changes (e.g., an `Address` row updates), the corresponding documents in the `jobs` index must be updated via `_update_by_query`. These secondary webhook sinks ("syncs") must participate in the same color lifecycle as their parent pipeline:

- When `jobs_black` is created, `address_to_jobs_black` must also be created, targeting `jobs_black`
- Both colors run in parallel between activate and drop (old color's syncs keep running for quick rollback)
- When `jobs_red` is dropped, all `*_to_jobs_red` syncs are dropped too

Currently SRB has no concept of syncs. Each pipeline is exactly 1 sink + 1 index + 1 transform + 1 enrichment.

## Design

### Approach: Syncs as subordinate resources inside PipelineConfig

Syncs are modeled as a list inside `PipelineConfig` and `LivePipelineState`. They share their parent pipeline's color and lifecycle. No new state variables, no new effect variants, no new commands.

Rejected alternatives:
- **Syncs as separate pipelines with a parent reference** - clutters state maps, parent-child relationship is implicit and easy to violate, planner needs special-case logic to coordinate colors
- **Syncs in a separate state variable** - every Quint action must assign all state variables, increasing surface area for no benefit since syncs are always subordinate

### Quint Spec Changes

#### types.qnt

New types:

```quint
type SyncConfig = {
  name: str,
  sink: SinkConfig,
  transform: TransformConfig,
  enrichment: EnrichmentConfig
}

type LiveSyncState = {
  sink: SinkState,
  transform: TransformState,
  enrichment: EnrichmentState
}
```

Extended types:

```quint
type PipelineConfig = {
  name: PipelineName,
  sink: SinkConfig,
  index: IndexConfig,
  transform: TransformConfig,
  enrichment: EnrichmentConfig,
  syncs: List[SyncConfig]           // NEW
}

type LivePipelineState = {
  sink: SinkState,
  index: IndexState,
  transform: TransformState,
  enrichment: EnrichmentState,
  syncs: List[LiveSyncState]        // NEW
}
```

No new Effect variants. Syncs use the same `CreateSink`, `CreateTransform`, `CreateEnrichment`, `DeleteSink`, `DeleteTransform`, `DeleteEnrichment` effects as primary resources.

#### effects.qnt

New sync change detection:

```quint
pure def sync_has_changes(desired: SyncConfig, live: LiveSyncState): bool =
  or {
    sink_config_changed(desired.sink, live.sink.config),
    transform_config_changed(desired.transform, live.transform.config),
    enrichment_config_changed(desired.enrichment, live.enrichment.config),
  }
```

`pipeline_has_changes` extended to check syncs. A pipeline has changes if any primary resource changed, OR if syncs were added/removed, OR if any existing sync's config changed:

```quint
pure def pipeline_has_changes(desired: PipelineConfig, live: LivePipelineState): bool =
  or {
    sink_config_changed(desired.sink, live.sink.config),
    index_config_changed(desired.index, live.index.config),
    transform_config_changed(desired.transform, live.transform.config),
    enrichment_config_changed(desired.enrichment, live.enrichment.config),
    desired.syncs.length() != live.syncs.length(),
    desired.syncs.indices().exists(i =>
      i < live.syncs.length() and sync_has_changes(desired.syncs[i], live.syncs[i])
    ),
  }
```

`needs_backfill` is NOT affected by sync changes. Syncs don't change the primary index's document content from the primary table's perspective. The primary sink doesn't need to re-backfill when only syncs change.

However, sync changes DO require a new color variant — you can't update a webhook path in place while the old color's syncs must keep running. This is handled by `pipeline_has_changes` returning true (which prevents the `NoChange` early return in `plan_for_pipeline`), causing the planner to take the "create new color" path via `effects_for_create`. The primary sink gets a fresh backfill as part of the new color, even though only syncs changed. This is acceptable because creating a new color always means a clean slate.

`effects_for_create` extended to emit sync effects after primary effects:

```quint
pure def effects_for_create(
  pipeline: PipelineName,
  desired: PipelineConfig,
  target_color: Color
): List[PlannedEffect] =
  // Primary resources (order 1-5)
  List(
    { effect: CreateIndex(desired.index), status: Pending, depends_on: Set(), order: 1 },
    { effect: CreateTransform(desired.transform), status: Pending, depends_on: Set(), order: 2 },
    { effect: CreateEnrichment(desired.enrichment), status: Pending, depends_on: Set(), order: 3 },
    { effect: CreateSink(desired.sink), status: Pending, depends_on: Set(1, 2, 3), order: 4 },
    { effect: TriggerBackfill(desired.sink.id), status: Pending, depends_on: Set(4), order: 5 },
  ).concat(
    // Sync resources — each sync needs transform + enrichment + sink
    // Sync sinks depend on the index (order 1) since they target it via webhook
    desired.syncs.foldl(List(), (acc, sync) =>
      val base = 5 + acc.length()
      acc.concat(List(
        { effect: CreateTransform(sync.transform), status: Pending, depends_on: Set(), order: base + 1 },
        { effect: CreateEnrichment(sync.enrichment), status: Pending, depends_on: Set(), order: base + 2 },
        { effect: CreateSink(sync.sink), status: Pending, depends_on: Set(1, base + 1, base + 2), order: base + 3 },
      ))
    )
  )
```

`effects_for_delete_color` extended similarly — delete all sync sinks, then sync transforms/enrichments, before deleting the primary resources and index.

`effects_for_reindex` extended to include sync effects (same as create, syncs target the new colored index).

#### commands.qnt

`cmd_apply` — when creating a new colored variant, populate sync live states:

```quint
// Inside the "new color" branch of cmd_apply:
acc.put((p.pipeline, p.target_color), {
  sink: { config: cfg.sink, lifecycle: SinkActive, backfilling: not(skip_backfill) },
  index: { config: cfg.index, status: IndexGreen, doc_count: 0 },
  transform: { config: cfg.transform, status: TransformActive },
  enrichment: { config: cfg.enrichment, status: EnrichmentActive },
  syncs: cfg.syncs.foldl(List(), (acc, sync) =>
    acc.append({
      sink: { config: sync.sink, lifecycle: SinkActive, backfilling: false },
      transform: { config: sync.transform, status: TransformActive },
      enrichment: { config: sync.enrichment, status: EnrichmentActive },
    })
  ),
})
```

Syncs don't backfill. They react to live changes via webhook; they don't replay history.

`cmd_activate` — unchanged. Activate swaps the alias only. Both colors' syncs keep running (old targets old index, new targets new index). This enables quick rollback.

`cmd_drop` — unchanged. Drop removes `(pipeline, color)` from `live_pipelines`, which includes syncs since they're part of `LivePipelineState`. The executor handles deleting actual sync resources via the effects.

`cmd_backfill` — unchanged. Backfill targets the primary sink only.

#### Invariants

`no_partial_pipelines` extended to check sync resource IDs:

```quint
val no_partial_pipelines: bool =
  live_pipelines.keys().forall(k =>
    val lp = live_pipelines.get(k)
    and {
      lp.sink.config.id != Sid(""),
      lp.index.config.id != Iid(""),
      lp.transform.config.id != Tid(""),
      lp.enrichment.config.id != Eid(""),
      lp.syncs.indices().forall(i => and {
        lp.syncs[i].sink.config.id != Sid(""),
        lp.syncs[i].transform.config.id != Tid(""),
        lp.syncs[i].enrichment.config.id != Eid(""),
      }),
    }
  )
```

#### state.qnt

No changes to state variables. `live_pipelines` carries syncs inside `LivePipelineState`. Actions `load_desired_config` and `discover_live_state` work unchanged since they take full `PipelineConfig` / `LivePipelineState` values.

#### commands_test.qnt

Existing fixtures gain `syncs: List()` to remain valid. New test fixtures and tests added for:

- Pipeline with syncs detected as Create
- Sync-only change triggers new color variant
- Sync-only change does NOT trigger primary backfill
- Effects for create include sync effects with correct ordering/dependencies
- Effects for delete include sync cleanup
- Drop removes syncs alongside primary resources
- Invariant `no_partial_pipelines` catches missing sync IDs

### Directory Convention (Implementation Detail, Not Spec)

Syncs are grouped under their target index pipeline, not their source table:

```
indexes/
  jobs/
    index.ts, sink.yaml, transform.yaml, enrichment.yaml
    syncs/
      address_to_jobs/
        sink.yaml, transform.yaml, enrichment.yaml
      contact_to_jobs/
        sink.yaml, transform.yaml, enrichment.yaml
      ...
  clients/
    syncs/
      address_to_clients/
      contact_to_clients/
```

The `_to_X` naming convention encodes the target, so `address_to_jobs` belongs under `jobs/syncs/`.

### What This Design Does NOT Cover

- **TypeScript implementation changes** (loader, planner, executor, yaml-gen) — those follow the spec and will be in the implementation plan
- **Meetsone workflow changes** — the meetsone PR already has the directory restructuring in progress; sync support will complete it
- **SRB yaml-gen production hardening** (configurable database name, auth) — separate concern, tracked separately
