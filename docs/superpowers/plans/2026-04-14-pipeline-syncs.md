# Pipeline Syncs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sync support to the Quint spec so subordinate webhook sinks follow their parent pipeline's color lifecycle.

**Architecture:** Extend `PipelineConfig` and `LivePipelineState` with a `syncs: List[...]` field. Effect generation emits extra Create/Delete effects for sync resources. Commands, invariants, and tests updated to handle syncs. No new state variables, no new effect variants.

**Tech Stack:** Quint 0.32.0 specification language. Verification via `quint typecheck`, `quint test`, `quint run` (invariants/witnesses).

**Verification command:** `bunx kadai run quint/check` (runs typecheck, tests, invariants, witnesses).

---

### Task 1: Add SyncConfig and LiveSyncState types

**Files:**
- Modify: `docs/spec/quint/types.qnt`

- [ ] **Step 1: Add SyncConfig type after PipelineConfig**

Add between the `PipelineConfig` section and `LivePipelineState` section:

```quint
  // ---------------------------------------------------------------------------
  // Sync — subordinate webhook sink that follows its parent pipeline's lifecycle
  // ---------------------------------------------------------------------------

  type SyncConfig = {
    name: str,
    sink: SinkConfig,
    transform: TransformConfig,
    enrichment: EnrichmentConfig
  }
```

- [ ] **Step 2: Add LiveSyncState type after LivePipelineState**

Add after `LivePipelineState`:

```quint
  type LiveSyncState = {
    sink: SinkState,
    transform: TransformState,
    enrichment: EnrichmentState
  }
```

- [ ] **Step 3: Add `syncs` field to PipelineConfig**

Change PipelineConfig from:

```quint
  type PipelineConfig = {
    name: PipelineName,
    sink: SinkConfig,
    index: IndexConfig,
    transform: TransformConfig,
    enrichment: EnrichmentConfig
  }
```

to:

```quint
  type PipelineConfig = {
    name: PipelineName,
    sink: SinkConfig,
    index: IndexConfig,
    transform: TransformConfig,
    enrichment: EnrichmentConfig,
    syncs: List[SyncConfig]
  }
```

- [ ] **Step 4: Add `syncs` field to LivePipelineState**

Change LivePipelineState from:

```quint
  type LivePipelineState = {
    sink: SinkState,
    index: IndexState,
    transform: TransformState,
    enrichment: EnrichmentState
  }
```

to:

```quint
  type LivePipelineState = {
    sink: SinkState,
    index: IndexState,
    transform: TransformState,
    enrichment: EnrichmentState,
    syncs: List[LiveSyncState]
  }
```

- [ ] **Step 5: Commit**

```bash
git add docs/spec/quint/types.qnt
git commit -m "spec: add SyncConfig and LiveSyncState types"
```

---

### Task 2: Fix all existing fixtures and test data to include `syncs`

Every place that constructs a `PipelineConfig` or `LivePipelineState` literal must now include `syncs`. This task fixes them all so the spec typechecks again before we add any new behavior.

**Files:**
- Modify: `docs/spec/quint/commands.qnt`
- Modify: `docs/spec/quint/commands_test.qnt`

- [ ] **Step 1: Fix `cmd_apply` in-place update branch**

In `commands.qnt`, the in-place update branch in `cmd_apply` constructs a `LivePipelineState` via spread (`{ ...existing, sink: ... }`). Since we added `syncs` to the type and we're using spread, the existing syncs will be preserved. No code change needed here — spread copies all fields including the new `syncs` field.

Verify the same is true for `backfill_completes` and `reindex_completes` — they also use spread on `LivePipelineState`. No changes needed.

- [ ] **Step 2: Fix `cmd_apply` new-color branch**

In `commands.qnt` inside `cmd_apply`, the new-color branch constructs a `LivePipelineState` literal. Add `syncs: List()`:

Change:

```quint
        acc.put((p.pipeline, p.target_color), {
          sink: { config: cfg.sink, lifecycle: SinkActive, backfilling: if (is_reindex) false else not(skip_backfill) },
          index: { config: cfg.index, status: if (is_reindex) IndexReindexing else IndexGreen, doc_count: 0 },
          transform: { config: cfg.transform, status: TransformActive },
          enrichment: { config: cfg.enrichment, status: EnrichmentActive },
        })
```

to:

```quint
        acc.put((p.pipeline, p.target_color), {
          sink: { config: cfg.sink, lifecycle: SinkActive, backfilling: if (is_reindex) false else not(skip_backfill) },
          index: { config: cfg.index, status: if (is_reindex) IndexReindexing else IndexGreen, doc_count: 0 },
          transform: { config: cfg.transform, status: TransformActive },
          enrichment: { config: cfg.enrichment, status: EnrichmentActive },
          syncs: cfg.syncs.foldl(List(), (a, sync) =>
            a.append({
              sink: { config: sync.sink, lifecycle: SinkActive, backfilling: false },
              transform: { config: sync.transform, status: TransformActive },
              enrichment: { config: sync.enrichment, status: EnrichmentActive },
            })
          ),
        })
```

- [ ] **Step 3: Fix `load_desired_config` fixture in `step` action**

In `commands.qnt`, the `step` action constructs a `PipelineConfig` literal for model checking. Add `syncs: List()`:

Change the `load_desired_config` call inside `step` to include:

```quint
    nondet name = Set("jobs", "clients", "users").oneOf()
    load_desired_config(name, {
      name: name,
      sink: { id: Sid(name), name: name, source_table: name, destination: "opensearch", filters: "", batch_size: 100, transform_id: Tid(name), enrichment_ids: Set(Eid(name)) },
      index: { id: Iid(name), name: name, mappings: "{}", settings: "{}", alias: name },
      transform: { id: Tid(name), name: name, function_body: "identity", input_schema: "{}", output_schema: "{}" },
      enrichment: { id: Eid(name), name: name, source: name, join_column: "id", enrichment_columns: "name" },
      syncs: List(),
    }),
```

- [ ] **Step 4: Fix test fixtures in `commands_test.qnt`**

Add `syncs: List()` to `fixture_pipeline_config`:

```quint
  pure val fixture_pipeline_config: PipelineConfig = {
    name: "jobs",
    sink: fixture_sink_config,
    index: fixture_index_config,
    transform: fixture_transform_config,
    enrichment: fixture_enrichment_config,
    syncs: List(),
  }
```

Add `syncs: List()` to `fixture_live_state`:

```quint
  pure val fixture_live_state: LivePipelineState = {
    sink: { config: fixture_sink_config, lifecycle: SinkActive, backfilling: false },
    index: { config: fixture_index_config, status: IndexGreen, doc_count: 1000 },
    transform: { config: fixture_transform_config, status: TransformActive },
    enrichment: { config: fixture_enrichment_config, status: EnrichmentActive },
    syncs: List(),
  }
```

Add `syncs: List()` to `fixture_clients_config`:

```quint
  pure val fixture_clients_config: PipelineConfig = {
    name: "clients",
    sink: fixture_clients_sink,
    index: fixture_clients_index,
    transform: fixture_clients_transform,
    enrichment: fixture_clients_enrichment,
    syncs: List(),
  }
```

- [ ] **Step 5: Run typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

Expected: typechecks successfully with no errors.

- [ ] **Step 6: Run existing tests**

Run: `quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_`

Expected: all existing tests pass (no behavioral changes yet).

- [ ] **Step 7: Commit**

```bash
git add docs/spec/quint/commands.qnt docs/spec/quint/commands_test.qnt
git commit -m "spec: add syncs: List() to all existing fixtures and commands"
```

---

### Task 3: Add sync change detection to effects

**Files:**
- Modify: `docs/spec/quint/effects.qnt`

- [ ] **Step 1: Add `sync_has_changes` function**

Add after `enrichment_config_changed`:

```quint
  // Compare a sync's config against its live state
  pure def sync_has_changes(desired: SyncConfig, live: LiveSyncState): bool =
    or {
      sink_config_changed(desired.sink, live.sink.config),
      transform_config_changed(desired.transform, live.transform.config),
      enrichment_config_changed(desired.enrichment, live.enrichment.config),
    }
```

- [ ] **Step 2: Extend `pipeline_has_changes` to check syncs**

Change:

```quint
  pure def pipeline_has_changes(desired: PipelineConfig, live: LivePipelineState): bool =
    or {
      sink_config_changed(desired.sink, live.sink.config),
      index_config_changed(desired.index, live.index.config),
      transform_config_changed(desired.transform, live.transform.config),
      enrichment_config_changed(desired.enrichment, live.enrichment.config),
    }
```

to:

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

- [ ] **Step 3: Run typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

Expected: typechecks successfully.

- [ ] **Step 4: Commit**

```bash
git add docs/spec/quint/effects.qnt
git commit -m "spec: add sync change detection to pipeline_has_changes"
```

---

### Task 4: Extend effect generation to include sync effects

**Files:**
- Modify: `docs/spec/quint/effects.qnt`

- [ ] **Step 1: Extend `effects_for_create` to include sync effects**

Change:

```quint
  pure def effects_for_create(
    pipeline: PipelineName,
    desired: PipelineConfig,
    target_color: Color
  ): List[PlannedEffect] =
    List(
      { effect: CreateIndex(desired.index), status: Pending, depends_on: Set(), order: 1 },
      { effect: CreateTransform(desired.transform), status: Pending, depends_on: Set(), order: 2 },
      { effect: CreateEnrichment(desired.enrichment), status: Pending, depends_on: Set(), order: 3 },
      { effect: CreateSink(desired.sink), status: Pending, depends_on: Set(1, 2, 3), order: 4 },
      { effect: TriggerBackfill(desired.sink.id), status: Pending, depends_on: Set(4), order: 5 },
    )
```

to:

```quint
  pure def effects_for_create(
    pipeline: PipelineName,
    desired: PipelineConfig,
    target_color: Color
  ): List[PlannedEffect] =
    val primary = List(
      { effect: CreateIndex(desired.index), status: Pending, depends_on: Set(), order: 1 },
      { effect: CreateTransform(desired.transform), status: Pending, depends_on: Set(), order: 2 },
      { effect: CreateEnrichment(desired.enrichment), status: Pending, depends_on: Set(), order: 3 },
      { effect: CreateSink(desired.sink), status: Pending, depends_on: Set(1, 2, 3), order: 4 },
      { effect: TriggerBackfill(desired.sink.id), status: Pending, depends_on: Set(4), order: 5 },
    )
    val sync_effects = desired.syncs.foldl(List(), (acc, sync) =>
      val base = 5 + acc.length()
      acc.concat(List(
        { effect: CreateTransform(sync.transform), status: Pending, depends_on: Set(), order: base + 1 },
        { effect: CreateEnrichment(sync.enrichment), status: Pending, depends_on: Set(), order: base + 2 },
        { effect: CreateSink(sync.sink), status: Pending, depends_on: Set(1, base + 1, base + 2), order: base + 3 },
      ))
    )
    primary.concat(sync_effects)
```

- [ ] **Step 2: Extend `effects_for_delete_color` to include sync effects**

Change:

```quint
  pure def effects_for_delete_color(
    pipeline: PipelineName,
    live: LivePipelineState,
    color: Color
  ): List[PlannedEffect] =
    List(
      { effect: DeleteSink(live.sink.config.id), status: Pending, depends_on: Set(), order: 1 },
      { effect: DeleteTransform(live.transform.config.id), status: Pending, depends_on: Set(1), order: 2 },
      { effect: DeleteEnrichment(live.enrichment.config.id), status: Pending, depends_on: Set(1), order: 3 },
      { effect: DeleteIndex(live.index.config.id), status: Pending, depends_on: Set(1, 2, 3), order: 4 },
    )
```

to:

```quint
  pure def effects_for_delete_color(
    pipeline: PipelineName,
    live: LivePipelineState,
    color: Color
  ): List[PlannedEffect] =
    // Delete sync sinks first (they depend on the index)
    val sync_deletes = live.syncs.foldl(List(), (acc, sync) =>
      val base = acc.length()
      acc.concat(List(
        { effect: DeleteSink(sync.sink.config.id), status: Pending, depends_on: Set(), order: base + 1 },
        { effect: DeleteTransform(sync.transform.config.id), status: Pending, depends_on: Set(base + 1), order: base + 2 },
        { effect: DeleteEnrichment(sync.enrichment.config.id), status: Pending, depends_on: Set(base + 1), order: base + 3 },
      ))
    )
    val p_base = sync_deletes.length()
    val primary_deletes = List(
      { effect: DeleteSink(live.sink.config.id), status: Pending, depends_on: Set(), order: p_base + 1 },
      { effect: DeleteTransform(live.transform.config.id), status: Pending, depends_on: Set(p_base + 1), order: p_base + 2 },
      { effect: DeleteEnrichment(live.enrichment.config.id), status: Pending, depends_on: Set(p_base + 1), order: p_base + 3 },
      { effect: DeleteIndex(live.index.config.id), status: Pending, depends_on: Set(p_base + 1, p_base + 2, p_base + 3), order: p_base + 4 },
    )
    sync_deletes.concat(primary_deletes)
```

- [ ] **Step 3: Extend `effects_for_reindex` to include sync effects**

Change:

```quint
  pure def effects_for_reindex(
    pipeline: PipelineName,
    desired: PipelineConfig,
    source_index: IndexId,
    target_color: Color
  ): List[PlannedEffect] =
    List(
      { effect: CreateIndex(desired.index), status: Pending, depends_on: Set(), order: 1 },
      { effect: CreateTransform(desired.transform), status: Pending, depends_on: Set(), order: 2 },
      { effect: CreateEnrichment(desired.enrichment), status: Pending, depends_on: Set(), order: 3 },
      { effect: CreateSink(desired.sink), status: Pending, depends_on: Set(1, 2, 3), order: 4 },
      { effect: TriggerReindex({ source: source_index, target: desired.index.id }), status: Pending, depends_on: Set(1, 4), order: 5 },
    )
```

to:

```quint
  pure def effects_for_reindex(
    pipeline: PipelineName,
    desired: PipelineConfig,
    source_index: IndexId,
    target_color: Color
  ): List[PlannedEffect] =
    val primary = List(
      { effect: CreateIndex(desired.index), status: Pending, depends_on: Set(), order: 1 },
      { effect: CreateTransform(desired.transform), status: Pending, depends_on: Set(), order: 2 },
      { effect: CreateEnrichment(desired.enrichment), status: Pending, depends_on: Set(), order: 3 },
      { effect: CreateSink(desired.sink), status: Pending, depends_on: Set(1, 2, 3), order: 4 },
      { effect: TriggerReindex({ source: source_index, target: desired.index.id }), status: Pending, depends_on: Set(1, 4), order: 5 },
    )
    val sync_effects = desired.syncs.foldl(List(), (acc, sync) =>
      val base = 5 + acc.length()
      acc.concat(List(
        { effect: CreateTransform(sync.transform), status: Pending, depends_on: Set(), order: base + 1 },
        { effect: CreateEnrichment(sync.enrichment), status: Pending, depends_on: Set(), order: base + 2 },
        { effect: CreateSink(sync.sink), status: Pending, depends_on: Set(1, base + 1, base + 2), order: base + 3 },
      ))
    )
    primary.concat(sync_effects)
```

- [ ] **Step 4: Run typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

Expected: typechecks successfully.

- [ ] **Step 5: Run existing tests**

Run: `quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_`

Expected: all existing tests still pass (they all use `syncs: List()` so no sync effects are generated).

- [ ] **Step 6: Commit**

```bash
git add docs/spec/quint/effects.qnt
git commit -m "spec: extend effect generation to create/delete sync resources"
```

---

### Task 5: Extend `no_partial_pipelines` invariant

**Files:**
- Modify: `docs/spec/quint/commands.qnt`

- [ ] **Step 1: Update `no_partial_pipelines` to check sync IDs**

Change:

```quint
  val no_partial_pipelines: bool =
    live_pipelines.keys().forall(k =>
      val lp = live_pipelines.get(k)
      and {
        lp.sink.config.id != Sid(""),
        lp.index.config.id != Iid(""),
        lp.transform.config.id != Tid(""),
        lp.enrichment.config.id != Eid(""),
      }
    )
```

to:

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

- [ ] **Step 2: Run typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

Expected: typechecks successfully.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/quint/commands.qnt
git commit -m "spec: extend no_partial_pipelines invariant to check sync IDs"
```

---

### Task 6: Add sync test fixtures and tests

**Files:**
- Modify: `docs/spec/quint/commands_test.qnt`

- [ ] **Step 1: Add sync fixture configs**

Add after the existing `fixture_clients_config`:

```quint
  // ---------------------------------------------------------------------------
  // Sync fixtures (address_to_jobs — webhook sink targeting jobs index)
  // ---------------------------------------------------------------------------

  pure val fixture_sync_sink_config: SinkConfig = {
    id: Sid("address_to_jobs_sink"),
    name: "address_to_jobs_sink",
    source_table: "addresses",
    destination: "opensearch/_update_by_query",
    filters: "",
    batch_size: 1,
    transform_id: Tid("address_to_jobs_transform"),
    enrichment_ids: Set(Eid("address_to_jobs_enrichment")),
  }

  pure val fixture_sync_transform_config: TransformConfig = {
    id: Tid("address_to_jobs_transform"),
    name: "address_to_jobs_transform",
    function_body: "fn(row) => update_query(row)",
    input_schema: "{ address: string }",
    output_schema: "{ query: string }",
  }

  pure val fixture_sync_enrichment_config: EnrichmentConfig = {
    id: Eid("address_to_jobs_enrichment"),
    name: "address_to_jobs_enrichment",
    source: "addresses",
    join_column: "id",
    enrichment_columns: "street",
  }

  pure val fixture_sync_config: SyncConfig = {
    name: "address_to_jobs",
    sink: fixture_sync_sink_config,
    transform: fixture_sync_transform_config,
    enrichment: fixture_sync_enrichment_config,
  }

  pure val fixture_live_sync_state: LiveSyncState = {
    sink: { config: fixture_sync_sink_config, lifecycle: SinkActive, backfilling: false },
    transform: { config: fixture_sync_transform_config, status: TransformActive },
    enrichment: { config: fixture_sync_enrichment_config, status: EnrichmentActive },
  }

  // Pipeline config WITH a sync
  pure val fixture_pipeline_with_sync: PipelineConfig = {
    name: "jobs",
    sink: fixture_sink_config,
    index: fixture_index_config,
    transform: fixture_transform_config,
    enrichment: fixture_enrichment_config,
    syncs: List(fixture_sync_config),
  }

  // Live state WITH a sync
  pure val fixture_live_with_sync: LivePipelineState = {
    sink: { config: fixture_sink_config, lifecycle: SinkActive, backfilling: false },
    index: { config: fixture_index_config, status: IndexGreen, doc_count: 1000 },
    transform: { config: fixture_transform_config, status: TransformActive },
    enrichment: { config: fixture_enrichment_config, status: EnrichmentActive },
    syncs: List(fixture_live_sync_state),
  }
```

- [ ] **Step 2: Add test — sync change detection**

Add after the existing pure function tests:

```quint
  // ---------------------------------------------------------------------------
  // Sync tests
  // ---------------------------------------------------------------------------

  // Test: sync change detected
  run test_sync_has_changes_detects_difference = {
    val modified_sync = { ...fixture_sync_config, sink: { ...fixture_sync_sink_config, filters: "status = active" } }
    val modified_live = { ...fixture_live_sync_state, sink: { ...fixture_live_sync_state.sink, config: { ...fixture_sync_sink_config, filters: "" } } }
    assert(sync_has_changes(modified_sync, modified_live))
  }

  // Test: sync no change
  run test_sync_has_changes_no_change = {
    assert(not(sync_has_changes(fixture_sync_config, fixture_live_sync_state)))
  }

  // Test: pipeline with sync detected as changed when sync added
  run test_pipeline_has_changes_sync_added = {
    // desired has 1 sync, live has 0 syncs
    assert(pipeline_has_changes(fixture_pipeline_with_sync, fixture_live_state))
  }

  // Test: pipeline with sync detected as changed when sync config differs
  run test_pipeline_has_changes_sync_config_changed = {
    val modified_sync = { ...fixture_sync_config, sink: { ...fixture_sync_sink_config, filters: "new_filter" } }
    val desired = { ...fixture_pipeline_with_sync, syncs: List(modified_sync) }
    assert(pipeline_has_changes(desired, fixture_live_with_sync))
  }

  // Test: pipeline with sync has no changes when everything matches
  run test_pipeline_has_changes_sync_no_change = {
    assert(not(pipeline_has_changes(fixture_pipeline_with_sync, fixture_live_with_sync)))
  }
```

- [ ] **Step 3: Add test — effects for create includes sync effects**

```quint
  // Test: effects_for_create with syncs includes 8 effects (5 primary + 3 sync)
  run test_effects_for_create_with_sync_count = {
    val effs = effects_for_create("jobs", fixture_pipeline_with_sync, Red)
    // 5 primary (index, transform, enrichment, sink, backfill) + 3 sync (transform, enrichment, sink)
    assert(effs.length() == 8)
  }

  // Test: sync sink depends on index (order 1) and its own transform/enrichment
  run test_effects_for_create_with_sync_dependencies = {
    val effs = effects_for_create("jobs", fixture_pipeline_with_sync, Red)
    // Sync effects are at indices 5, 6, 7 (0-indexed)
    // Sync sink (index 7) should depend on index creation (order 1)
    val sync_sink = effs[7]
    assert(sync_sink.depends_on.contains(1))
  }
```

- [ ] **Step 4: Add test — effects for delete includes sync effects**

```quint
  // Test: effects_for_delete_color with syncs includes 7 effects (3 sync + 4 primary)
  run test_effects_for_delete_with_sync_count = {
    val effs = effects_for_delete_color("jobs", fixture_live_with_sync, Red)
    // 3 sync deletes (sink, transform, enrichment) + 4 primary deletes (sink, transform, enrichment, index)
    assert(effs.length() == 7)
  }
```

- [ ] **Step 5: Add test — sync-only change does NOT need backfill**

```quint
  // Test: sync-only change does NOT trigger needs_backfill
  run test_sync_only_change_no_backfill = {
    // Same primary config, different sync count
    assert(not(needs_backfill(fixture_pipeline_with_sync, fixture_live_with_sync)))
  }
```

- [ ] **Step 6: Run typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

Expected: typechecks successfully.

- [ ] **Step 7: Run all tests**

Run: `quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_`

Expected: all tests pass, including the new sync tests.

- [ ] **Step 8: Commit**

```bash
git add docs/spec/quint/commands_test.qnt
git commit -m "spec: add sync test fixtures and unit tests"
```

---

### Task 7: Add sync e2e scenario test

**Files:**
- Modify: `docs/spec/quint/commands_test.qnt`

- [ ] **Step 1: Add e2e test for pipeline with syncs**

Add in the end-to-end scenario tests section:

```quint
  // ---------------------------------------------------------------------------
  // Scenario: Pipeline with syncs — full lifecycle
  // Deploy jobs pipeline with address_to_jobs sync, backfill, activate,
  // then update (new color), backfill again, activate new, drop old.
  // ---------------------------------------------------------------------------

  run test_e2e_pipeline_with_syncs = {
    init
      // Load config with sync
      .then(load_desired_config("jobs", fixture_pipeline_with_sync))
      // Apply: creates primary + sync resources
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        all {
          // One colored variant exists
          assert(live_pipelines.keys().size() == 1),
          // Primary sink is backfilling
          assert(live_pipelines.get(("jobs", color)).sink.backfilling),
          // Sync sink is NOT backfilling (syncs don't backfill)
          assert(not(live_pipelines.get(("jobs", color)).syncs[0].sink.backfilling)),
          // Sync sink is active
          assert(live_pipelines.get(("jobs", color)).syncs[0].sink.lifecycle == SinkActive),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Backfill completes, activate
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      .then(
        val color1 = aliases.get("jobs")
        all {
          assert("jobs".in(aliases.keys())),
          // Still 1 sync in the live state
          assert(live_pipelines.get(("jobs", color1)).syncs.length() == 1),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Now update the transform (triggers new color with fresh backfill)
      .then(
        val updated_config: PipelineConfig = {
          ...fixture_pipeline_with_sync,
          transform: { ...fixture_transform_config, function_body: "fn(row) => updated(row)" },
        }
        load_desired_config("jobs", updated_config)
      )
      .then(cmd_apply(false))
      .then(
        val color1 = aliases.get("jobs")
        all {
          // Now 2 colored variants exist (old + new)
          assert(live_pipelines.keys().size() == 2),
          // Old color still has its sync
          assert(live_pipelines.get(("jobs", color1)).syncs.length() == 1),
          // New color also has a sync
          val color2 = ALL_COLORS.filter(c => c != color1 and ("jobs", c).in(live_pipelines.keys())).fold(Red, (a, c) => c)
          assert(live_pipelines.get(("jobs", color2)).syncs.length() == 1),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Complete backfill on new color, activate it, drop old
      .then(
        val color1 = aliases.get("jobs")
        val color2 = ALL_COLORS.filter(c => c != color1 and ("jobs", c).in(live_pipelines.keys())).fold(Red, (a, c) => c)
        backfill_completes("jobs", color2)
      )
      .then(
        val color1 = aliases.get("jobs")
        val color2 = ALL_COLORS.filter(c => c != color1 and ("jobs", c).in(live_pipelines.keys())).fold(Red, (a, c) => c)
        cmd_activate("jobs", color2)
      )
      .then(
        val old_color = ALL_COLORS.filter(c => c != aliases.get("jobs") and ("jobs", c).in(live_pipelines.keys())).fold(Red, (a, c) => c)
        cmd_drop("jobs", old_color)
      )
      .then(all {
        // Only 1 colored variant remains (the new one)
        assert(live_pipelines.keys().size() == 1),
        // That variant has the sync
        val color = aliases.get("jobs")
        assert(live_pipelines.get(("jobs", color)).syncs.length() == 1),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
  }
```

- [ ] **Step 2: Run all tests**

Run: `quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_`

Expected: all tests pass including the new e2e scenario.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/quint/commands_test.qnt
git commit -m "spec: add e2e scenario test for pipeline with syncs"
```

---

### Task 8: Run full verification suite

**Files:** None (verification only)

- [ ] **Step 1: Run full quint check suite**

Run: `bunx kadai run quint/check`

This runs:
1. Typecheck
2. All tests (`--match=test_`)
3. Invariants: `never_drop_active`, `alias_integrity`, `no_partial_pipelines`, `disabled_not_backfilling`
4. Witnesses: `witness_pipeline_deployed`, `witness_alias_set`, `witness_backfill_completes`, `witness_full_cycle`

Expected: all checks pass.

- [ ] **Step 2: If any invariant/witness fails, debug and fix**

Use `--verbosity=3` for failing tests:

```bash
quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_failing_name --verbosity=3
```

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add docs/spec/quint/
git commit -m "spec: fix issues found during full verification"
```
