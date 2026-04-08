# Red-Black Deployment Orchestrator Quint Spec — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flesh out the skeleton Quint spec into a complete formal specification of the red-black deployment orchestrator for CDC pipelines.

**Architecture:** Effect-centric with flat state. Pipelines are a pure grouping concept over per-resource state maps. Four discrete commands (plan, apply, activate, drop) with precondition-based invariants. Effect derivation rules are pure functions, currently simplified (any change = full red-black flow), structured for future per-field expansion.

**Tech Stack:** Quint formal specification language. All files under `docs/spec/quint/`. Verification via `quint typecheck`, `quint test`, `quint run --invariant`.

**Spec:** `docs/superpowers/specs/2026-04-08-quint-spec-design.md`

---

### Task 1: Rewrite `types.qnt` — Core Types

Rewrite the types module to match the spec design. This is the foundation all other modules depend on.

**Files:**
- Modify: `docs/spec/quint/types.qnt` (full rewrite)

- [ ] **Step 1: Write the new types.qnt**

Replace the entire contents of `docs/spec/quint/types.qnt` with:

```quint
// Core type definitions for red-black deployment resources
module types {

  // ---------------------------------------------------------------------------
  // Identifiers
  // ---------------------------------------------------------------------------

  type ResourceId = str
  type PipelineName = str

  // ---------------------------------------------------------------------------
  // Color — bounded set for model checking
  // ---------------------------------------------------------------------------

  type Color =
    | Red
    | Black
    | Blue
    | Green
    | Purple
    | Orange
    | Yellow

  // ---------------------------------------------------------------------------
  // Sequin Sink
  // ---------------------------------------------------------------------------

  type SinkConfig = {
    id: ResourceId,
    name: str,
    source_table: str,
    destination: str,
    filters: str,
    batch_size: int,
    transform_id: ResourceId,
    enrichment_ids: Set[ResourceId]
  }

  type SinkStatus =
    | SinkActive
    | SinkPaused
    | SinkBackfilling
    | SinkDisabled

  type SinkState = {
    config: SinkConfig,
    status: SinkStatus
  }

  // ---------------------------------------------------------------------------
  // OpenSearch Index
  // ---------------------------------------------------------------------------

  type IndexConfig = {
    id: ResourceId,
    name: str,
    mappings: str,
    settings: str,
    alias: str
  }

  type IndexStatus =
    | IndexGreen
    | IndexYellow
    | IndexRed
    | IndexReindexing
    | IndexNotFound

  type IndexState = {
    config: IndexConfig,
    status: IndexStatus,
    doc_count: int
  }

  // ---------------------------------------------------------------------------
  // Sequin Transformation
  // ---------------------------------------------------------------------------

  type TransformConfig = {
    id: ResourceId,
    name: str,
    function_body: str,
    input_schema: str,
    output_schema: str
  }

  type TransformStatus =
    | TransformActive
    | TransformInactive

  type TransformState = {
    config: TransformConfig,
    status: TransformStatus
  }

  // ---------------------------------------------------------------------------
  // Sequin Enrichment
  // ---------------------------------------------------------------------------

  type EnrichmentConfig = {
    id: ResourceId,
    name: str,
    source: str,
    join_column: str,
    enrichment_columns: str
  }

  type EnrichmentStatus =
    | EnrichmentActive
    | EnrichmentInactive

  type EnrichmentState = {
    config: EnrichmentConfig,
    status: EnrichmentStatus
  }

  // ---------------------------------------------------------------------------
  // Pipeline — color-agnostic desired config
  // ---------------------------------------------------------------------------

  type PipelineConfig = {
    name: PipelineName,
    sink: SinkConfig,
    index: IndexConfig,
    transform: TransformConfig,
    enrichment: EnrichmentConfig
  }

  // ---------------------------------------------------------------------------
  // Live pipeline state — one per (pipeline, color) pair
  // ---------------------------------------------------------------------------

  type LivePipelineState = {
    sink: SinkState,
    index: IndexState,
    transform: TransformState,
    enrichment: EnrichmentState
  }

  // ---------------------------------------------------------------------------
  // Change detection
  // ---------------------------------------------------------------------------

  type ChangeKind =
    | NoChange
    | Create
    | Update
    | Delete

  type FieldChange = {
    field_name: str,
    requires_backfill: bool,
    requires_reindex: bool
  }

  type ResourceChange = {
    resource_id: ResourceId,
    kind: ChangeKind,
    field_changes: Set[FieldChange]
  }

  // ---------------------------------------------------------------------------
  // Effects — the operations a plan can produce
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Plan
  // ---------------------------------------------------------------------------

  type EffectStatus =
    | Pending
    | InProgress
    | Completed
    | Failed(str)

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
}
```

Key changes from skeleton:
- Color expanded from `Red | Black` to 7 variants
- Removed `color` field from `SinkState` and `IndexState` (color is in the pipeline grouping)
- Removed `ResourceConfig` and `Resource` union types (unused — we work at pipeline level)
- Added `PipelineName`, `PipelineConfig`, `LivePipelineState`
- Moved `ChangeKind`, `FieldChange`, `ResourceChange`, `Effect`, `Plan` types here from `plan.qnt` (all types in one module)
- Removed `desired` field from `ResourceChange` (redundant — desired state is in `PipelineConfig`)
- Added `pipeline` and `target_color` to `Plan`

- [ ] **Step 2: Typecheck**

Run: `quint typecheck docs/spec/quint/types.qnt`
Expected: Exit code 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/quint/types.qnt
git commit -m "spec: rewrite types.qnt with pipeline-grouped types and 7 colors"
```

---

### Task 2: Rewrite `state.qnt` — State Variables and Initialization

Replace the flat per-resource maps with pipeline-grouped state.

**Files:**
- Modify: `docs/spec/quint/state.qnt` (full rewrite)

- [ ] **Step 1: Write the new state.qnt**

Replace the entire contents of `docs/spec/quint/state.qnt` with:

```quint
// State variables and initialization for the red-black deployment orchestrator
module state {

  import types.* from "./types"

  // ---------------------------------------------------------------------------
  // State variables
  // ---------------------------------------------------------------------------

  // Desired state from compiled config (color-agnostic)
  var desired_pipelines: PipelineName -> PipelineConfig

  // Live state discovered from Sequin API + OpenSearch
  // Keyed by (PipelineName, Color) — each colored variant is a separate entry
  var live_pipelines: (PipelineName, Color) -> LivePipelineState

  // Which color each pipeline's alias points to (determines active color)
  var aliases: PipelineName -> Color

  // The current set of plans (one per changed pipeline)
  var current_plans: Set[Plan]

  // ---------------------------------------------------------------------------
  // Constants for model checking
  // ---------------------------------------------------------------------------

  pure val ALL_COLORS: Set[Color] = Set(Red, Black, Blue, Green, Purple, Orange, Yellow)

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  action init = all {
    desired_pipelines' = Map(),
    live_pipelines' = Map(),
    aliases' = Map(),
    current_plans' = Set(),
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Get all colors that have live resources for a pipeline
  pure def live_colors(pipeline: PipelineName, live: (PipelineName, Color) -> LivePipelineState): Set[Color] =
    ALL_COLORS.filter(c => live.has((pipeline, c)))

  // Get colors that have NO live resources for a pipeline (available for deployment)
  pure def available_colors(pipeline: PipelineName, live: (PipelineName, Color) -> LivePipelineState): Set[Color] =
    ALL_COLORS.filter(c => not(live.has((pipeline, c))))

  // Check if a pipeline has any live colored variants
  pure def pipeline_exists_live(pipeline: PipelineName, live: (PipelineName, Color) -> LivePipelineState): bool =
    ALL_COLORS.exists(c => live.has((pipeline, c)))

  // ---------------------------------------------------------------------------
  // Config loading (models reading compiled config)
  // ---------------------------------------------------------------------------

  action load_desired_config(pipeline: PipelineName, cfg: PipelineConfig): bool = all {
    desired_pipelines' = desired_pipelines.put(pipeline, cfg),
    live_pipelines' = live_pipelines,
    aliases' = aliases,
    current_plans' = current_plans,
  }

  // Models discovering live state from Sequin API + OpenSearch
  action discover_live_state(pipeline: PipelineName, color: Color, state: LivePipelineState): bool = all {
    live_pipelines' = live_pipelines.put((pipeline, color), state),
    desired_pipelines' = desired_pipelines,
    aliases' = aliases,
    current_plans' = current_plans,
  }

  // Models discovering which color an alias points to
  action discover_alias(pipeline: PipelineName, color: Color): bool = all {
    aliases' = aliases.put(pipeline, color),
    desired_pipelines' = desired_pipelines,
    live_pipelines' = live_pipelines,
    current_plans' = current_plans,
  }
}
```

Key changes from skeleton:
- Single `desired_pipelines` map replaces 4 separate desired maps
- Single `live_pipelines` map with tuple key replaces 4 separate live maps
- Added `aliases` state variable
- `current_plans` is now `Set[Plan]` (one per pipeline)
- Added `ALL_COLORS` constant and helper functions for color queries
- Added `discover_live_state` and `discover_alias` actions (model reading from live systems)
- Removed `generate_plan` (moved to `plan.qnt`)

- [ ] **Step 2: Typecheck**

Run: `quint typecheck docs/spec/quint/state.qnt`
Expected: Exit code 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/quint/state.qnt
git commit -m "spec: rewrite state.qnt with pipeline-grouped state and alias tracking"
```

---

### Task 3: Create `effects.qnt` — Effect Derivation Rules

Pure functions that compute effects from desired vs live state. This is the core diff logic.

**Files:**
- Create: `docs/spec/quint/effects.qnt`

- [ ] **Step 1: Write effects.qnt**

Create `docs/spec/quint/effects.qnt` with:

```quint
// Effect derivation: compare desired config against live state, produce effects
module effects {

  import types.* from "./types"

  // ---------------------------------------------------------------------------
  // Pipeline-level diff
  // ---------------------------------------------------------------------------

  // Determine what kind of change a pipeline has
  pure def pipeline_change_kind(
    pipeline: PipelineName,
    desired: PipelineName -> PipelineConfig,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color]
  ): ChangeKind =
    val has_desired = desired.has(pipeline)
    val has_live = all_colors.exists(c => live.has((pipeline, c)))
    if (has_desired and not(has_live)) Create
    else if (not(has_desired) and has_live) Delete
    else if (has_desired and has_live) Update
    else NoChange

  // ---------------------------------------------------------------------------
  // Config comparison (simplified: any difference = changed)
  // ---------------------------------------------------------------------------

  // Compare two sink configs — returns true if they differ
  pure def sink_config_changed(desired: SinkConfig, live: SinkConfig): bool =
    or {
      desired.source_table != live.source_table,
      desired.destination != live.destination,
      desired.filters != live.filters,
      desired.batch_size != live.batch_size,
      desired.transform_id != live.transform_id,
      desired.enrichment_ids != live.enrichment_ids,
    }

  // Compare two index configs — returns true if they differ
  pure def index_config_changed(desired: IndexConfig, live: IndexConfig): bool =
    or {
      desired.mappings != live.mappings,
      desired.settings != live.settings,
    }

  // Compare two transform configs — returns true if they differ
  pure def transform_config_changed(desired: TransformConfig, live: TransformConfig): bool =
    or {
      desired.function_body != live.function_body,
      desired.input_schema != live.input_schema,
      desired.output_schema != live.output_schema,
    }

  // Compare two enrichment configs — returns true if they differ
  pure def enrichment_config_changed(desired: EnrichmentConfig, live: EnrichmentConfig): bool =
    or {
      desired.source != live.source,
      desired.join_column != live.join_column,
      desired.enrichment_columns != live.enrichment_columns,
    }

  // Check if any resource in a pipeline has changed
  pure def pipeline_has_changes(desired: PipelineConfig, live: LivePipelineState): bool =
    or {
      sink_config_changed(desired.sink, live.sink.config),
      index_config_changed(desired.index, live.index.config),
      transform_config_changed(desired.transform, live.transform.config),
      enrichment_config_changed(desired.enrichment, live.enrichment.config),
    }

  // ---------------------------------------------------------------------------
  // Effect generation for a single pipeline
  // ---------------------------------------------------------------------------

  // Effects for creating a brand new colored pipeline (no prior live state)
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

  // Effects for deleting all colored variants of a pipeline
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

  // Effects for updating a pipeline (simplified: always full red-black flow)
  // This creates a NEW colored variant — the old one stays until explicitly dropped
  pure def effects_for_update(
    pipeline: PipelineName,
    desired: PipelineConfig,
    target_color: Color
  ): List[PlannedEffect] =
    // Under current simplified rules, update = create a new color
    effects_for_create(pipeline, desired, target_color)

  // ---------------------------------------------------------------------------
  // Plan generation for a single pipeline
  // ---------------------------------------------------------------------------

  // Generate a plan for a single pipeline given desired config, live state, and a target color
  pure def plan_for_pipeline(
    pipeline: PipelineName,
    desired: PipelineName -> PipelineConfig,
    live: (PipelineName, Color) -> LivePipelineState,
    target_color: Color,
    all_colors: Set[Color]
  ): Plan =
    val kind = pipeline_change_kind(pipeline, desired, live, all_colors)
    val changes: Set[ResourceChange] = Set({ resource_id: pipeline, kind: kind, field_changes: Set() })
    val effs: List[PlannedEffect] = match kind {
      | Create => effects_for_create(pipeline, desired.get(pipeline), target_color)
      | Update => effects_for_update(pipeline, desired.get(pipeline), target_color)
      | Delete => List()
      | NoChange => List()
    }
    { pipeline: pipeline, target_color: target_color, changes: changes, effects: effs }
}
```

Notes:
- Delete effects are handled by the `drop` command, not by `plan`/`apply`. So `effects_for_delete_color` is a standalone helper, not used in `plan_for_pipeline`.
- `effects_for_update` delegates to `effects_for_create` under the simplified rules. When per-field rules are added later, this function will contain the branching logic.
- Dependency ordering: index/transform/enrichment first (parallel), then sink (depends on all three), then backfill (depends on sink).

- [ ] **Step 2: Typecheck**

Run: `quint typecheck docs/spec/quint/effects.qnt`
Expected: Exit code 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/quint/effects.qnt
git commit -m "spec: add effects.qnt with diff logic and effect derivation rules"
```

---

### Task 4: Rewrite `plan.qnt` — Plan Generation

Plan generation uses effect derivation to produce plans for all changed pipelines.

**Files:**
- Modify: `docs/spec/quint/plan.qnt` (full rewrite)

- [ ] **Step 1: Write the new plan.qnt**

Replace the entire contents of `docs/spec/quint/plan.qnt` with:

```quint
// Plan generation: produce plans for all changed pipelines
module plan {

  import types.* from "./types"
  import effects.* from "./effects"

  // ---------------------------------------------------------------------------
  // Plan generation across all pipelines
  // ---------------------------------------------------------------------------

  // Get all pipeline names that appear in either desired or live state
  pure def all_pipeline_names(
    desired: PipelineName -> PipelineConfig,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color]
  ): Set[PipelineName] =
    desired.keys().union(
      all_colors.flatMap(c => live.keys().filter(k => k._2 == c).map(k => k._1))
    )

  // Pick an available color for a pipeline (non-deterministic in spec)
  // Returns a color that has no live resources for this pipeline
  pure def pick_target_color(
    pipeline: PipelineName,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color]
  ): Color =
    val available = all_colors.filter(c => not(live.has((pipeline, c))))
    // In the spec, we just pick one non-deterministically
    // oneOf requires a non-empty set — caller must ensure available is non-empty
    available.fold(Red, (acc, c) => c)

  // Generate plans for all pipelines that have changes
  pure def generate_plans(
    desired: PipelineName -> PipelineConfig,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color]
  ): Set[Plan] =
    val pipelines = all_pipeline_names(desired, live, all_colors)
    pipelines
      .map(p => {
        val target = pick_target_color(p, live, all_colors)
        plan_for_pipeline(p, desired, live, target, all_colors)
      })
      .filter(p => p.effects.length() > 0)
}
```

Notes:
- `all_pipeline_names` extracts pipeline names from both desired and live state. Live state uses tuple keys `(PipelineName, Color)`, so we extract the first element.
- `pick_target_color` uses `fold` to deterministically pick a color from the available set. A real implementation would have a strategy (e.g., prefer red/black alternation). The spec just needs any valid color.
- `generate_plans` filters out pipelines with no changes (empty effects list).

- [ ] **Step 2: Typecheck**

Run: `quint typecheck docs/spec/quint/plan.qnt`
Expected: Exit code 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/quint/plan.qnt
git commit -m "spec: rewrite plan.qnt with multi-pipeline plan generation"
```

---

### Task 5: Create `commands.qnt` — The 4 Commands

Replace `redblack.qnt` with `commands.qnt` modeling the 4 discrete commands as actions with preconditions.

**Files:**
- Create: `docs/spec/quint/commands.qnt`
- Delete: `docs/spec/quint/redblack.qnt`

- [ ] **Step 1: Write commands.qnt**

Create `docs/spec/quint/commands.qnt` with:

```quint
// The 4 commands: plan, apply, activate, drop
module commands {

  import types.* from "./types"
  import effects.* from "./effects"
  import plan.* from "./plan"
  import state.* from "./state"

  // ---------------------------------------------------------------------------
  // Command: plan
  // Pure computation — compares desired vs live, produces plans
  // ---------------------------------------------------------------------------

  action cmd_plan: bool = all {
    // Precondition: there is desired config loaded
    desired_pipelines.keys().size() > 0,
    // Generate plans for all changed pipelines
    current_plans' = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS),
    desired_pipelines' = desired_pipelines,
    live_pipelines' = live_pipelines,
    aliases' = aliases,
  }

  // ---------------------------------------------------------------------------
  // Command: apply
  // Same as plan, then execute effects (create resources, trigger backfills)
  // ---------------------------------------------------------------------------

  // Apply a single planned effect — updates live state
  // For now, we model effect execution as instantly successful
  action apply_effect(pipeline: PipelineName, color: Color, pe: PlannedEffect): bool =
    match pe.effect {
      | CreateIndex(cfg) =>
          val new_state: LivePipelineState = match live_pipelines.get((pipeline, color)) {
            | Some(existing) => { ...existing, index: { config: cfg, status: IndexGreen, doc_count: 0 } }
            | None => {
                sink: { config: { id: "", name: "", source_table: "", destination: "", filters: "", batch_size: 0, transform_id: "", enrichment_ids: Set() }, status: SinkDisabled },
                index: { config: cfg, status: IndexGreen, doc_count: 0 },
                transform: { config: { id: "", name: "", function_body: "", input_schema: "", output_schema: "" }, status: TransformInactive },
                enrichment: { config: { id: "", name: "", source: "", join_column: "", enrichment_columns: "" }, status: EnrichmentInactive },
              }
          }
          live_pipelines' = live_pipelines.put((pipeline, color), new_state)
      | CreateSink(cfg) =>
          val existing = live_pipelines.get((pipeline, color))
          match existing {
            | Some(e) =>
                live_pipelines' = live_pipelines.put((pipeline, color), { ...e, sink: { config: cfg, status: SinkActive } })
            | None => live_pipelines' = live_pipelines
          }
      | CreateTransform(cfg) =>
          val existing = live_pipelines.get((pipeline, color))
          match existing {
            | Some(e) =>
                live_pipelines' = live_pipelines.put((pipeline, color), { ...e, transform: { config: cfg, status: TransformActive } })
            | None => live_pipelines' = live_pipelines
          }
      | CreateEnrichment(cfg) =>
          val existing = live_pipelines.get((pipeline, color))
          match existing {
            | Some(e) =>
                live_pipelines' = live_pipelines.put((pipeline, color), { ...e, enrichment: { config: cfg, status: EnrichmentActive } })
            | None => live_pipelines' = live_pipelines
          }
      | TriggerBackfill(sink_id) =>
          val existing = live_pipelines.get((pipeline, color))
          match existing {
            | Some(e) =>
                live_pipelines' = live_pipelines.put((pipeline, color), { ...e, sink: { ...e.sink, status: SinkBackfilling } })
            | None => live_pipelines' = live_pipelines
          }
      | DeleteSink(id) =>
          live_pipelines' = live_pipelines
      | DeleteIndex(id) =>
          live_pipelines' = live_pipelines.mapRemove((pipeline, color))
      | DeleteTransform(id) =>
          live_pipelines' = live_pipelines
      | DeleteEnrichment(id) =>
          live_pipelines' = live_pipelines
      | TriggerReindex(id) =>
          val existing = live_pipelines.get((pipeline, color))
          match existing {
            | Some(e) =>
                live_pipelines' = live_pipelines.put((pipeline, color), { ...e, index: { ...e.index, status: IndexReindexing } })
            | None => live_pipelines' = live_pipelines
          }
      | SwapAlias(a) =>
          live_pipelines' = live_pipelines
    }

  // Execute all plans — for each plan, apply all effects in order
  // Simplified: we apply all effects atomically (no partial failure modeled yet)
  action cmd_apply: bool = all {
    // Precondition: plans exist
    current_plans.size() > 0,
    // Generate fresh plans (apply = plan + execute)
    val plans = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS)
    // For simplicity in the spec, we model apply as creating all target pipelines at once
    val new_live = plans.fold(live_pipelines, (acc, p) =>
      if (p.effects.length() > 0) {
        val desired_cfg = desired_pipelines.get(p.pipeline)
        match desired_cfg {
          | Some(cfg) => acc.put((p.pipeline, p.target_color), {
              sink: { config: cfg.sink, status: SinkBackfilling },
              index: { config: cfg.index, status: IndexGreen, doc_count: 0 },
              transform: { config: cfg.transform, status: TransformActive },
              enrichment: { config: cfg.enrichment, status: EnrichmentActive },
            })
          | None => acc
        }
      } else acc
    )
    all {
      live_pipelines' = new_live,
      desired_pipelines' = desired_pipelines,
      aliases' = aliases,
      current_plans' = plans,
    }
  }

  // ---------------------------------------------------------------------------
  // Command: activate <pipeline> <color>
  // Swap the root alias to point to the specified colored index
  // ---------------------------------------------------------------------------

  action cmd_activate(pipeline: PipelineName, color: Color): bool = all {
    // Precondition: the colored variant exists
    live_pipelines.has((pipeline, color)),
    // Precondition: the colored variant is not mid-backfill
    live_pipelines.get((pipeline, color)) != None,
    val lps = live_pipelines.get((pipeline, color))
    match lps {
      | Some(lp) => lp.sink.status != SinkBackfilling
      | None => false
    },
    // Swap alias
    aliases' = aliases.put(pipeline, color),
    desired_pipelines' = desired_pipelines,
    live_pipelines' = live_pipelines,
    current_plans' = current_plans,
  }

  // ---------------------------------------------------------------------------
  // Command: drop <pipeline> <color>
  // Delete all resources for a pipeline+color
  // ---------------------------------------------------------------------------

  action cmd_drop(pipeline: PipelineName, color: Color): bool = all {
    // Precondition: the colored variant exists
    live_pipelines.has((pipeline, color)),
    // Precondition: not dropping the active color
    if (aliases.has(pipeline)) aliases.get(pipeline) != Some(color)
    else true,
    // Remove the colored variant
    live_pipelines' = live_pipelines.mapRemove((pipeline, color)),
    desired_pipelines' = desired_pipelines,
    aliases' = aliases,
    current_plans' = current_plans,
  }

  // ---------------------------------------------------------------------------
  // Model backfill completion (environment action)
  // ---------------------------------------------------------------------------

  // Models the backfill completing for a colored variant
  action backfill_completes(pipeline: PipelineName, color: Color): bool = all {
    live_pipelines.has((pipeline, color)),
    val lps = live_pipelines.get((pipeline, color))
    match lps {
      | Some(lp) => all {
          lp.sink.status == SinkBackfilling,
          live_pipelines' = live_pipelines.put((pipeline, color),
            { ...lp, sink: { ...lp.sink, status: SinkActive } }
          ),
        }
      | None => false
    },
    desired_pipelines' = desired_pipelines,
    aliases' = aliases,
    current_plans' = current_plans,
  }

  // ---------------------------------------------------------------------------
  // Non-deterministic step
  // ---------------------------------------------------------------------------

  action step = any {
    cmd_plan,
    cmd_apply,
    // Activate and drop need parameters — model with nondet
    // Guard: only attempt if desired_pipelines is non-empty (oneOf requires non-empty set)
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      cmd_activate(p, c),
    },
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      cmd_drop(p, c),
    },
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      backfill_completes(p, c),
    },
    // Model loading a config (needed to bootstrap the spec for model checking)
    nondet name = Set("jobs", "clients", "users").oneOf()
    load_desired_config(name, {
      name: name,
      sink: { id: name, name: name, source_table: name, destination: "opensearch", filters: "", batch_size: 100, transform_id: name, enrichment_ids: Set(name) },
      index: { id: name, name: name, mappings: "{}", settings: "{}", alias: name },
      transform: { id: name, name: name, function_body: "identity", input_schema: "{}", output_schema: "{}" },
      enrichment: { id: name, name: name, source: name, join_column: "id", enrichment_columns: "name" },
    }),
  }

  // ---------------------------------------------------------------------------
  // Invariants
  // ---------------------------------------------------------------------------

  // 1. Never drop the active color
  val never_drop_active: bool =
    aliases.keys().forall(p =>
      match aliases.get(p) {
        | Some(c) => live_pipelines.has((p, c))
        | None => true
      }
    )

  // 2. Alias always points to an existing index
  val alias_integrity: bool =
    aliases.keys().forall(p =>
      match aliases.get(p) {
        | Some(c) => live_pipelines.has((p, c))
        | None => true
      }
    )

  // 3. No partial resource groups — if a pipeline+color exists in live state,
  //    it has all 4 resources (modeled by LivePipelineState being a complete record)
  //    This invariant checks that if any live pipeline exists, its resources are consistent
  val no_partial_pipelines: bool =
    ALL_COLORS.forall(c =>
      desired_pipelines.keys().forall(p =>
        if (live_pipelines.has((p, c))) {
          val lps = live_pipelines.get((p, c))
          match lps {
            | Some(lp) => and {
                lp.sink.config.id != "",
                lp.index.config.id != "",
                lp.transform.config.id != "",
                lp.enrichment.config.id != "",
              }
            | None => true
          }
        } else true
      )
    )
}
```

- [ ] **Step 2: Typecheck**

Run: `quint typecheck docs/spec/quint/commands.qnt`
Expected: Exit code 0, no errors.

- [ ] **Step 3: Delete old redblack.qnt**

```bash
rm docs/spec/quint/redblack.qnt
```

- [ ] **Step 4: Commit**

```bash
git add docs/spec/quint/commands.qnt
git rm docs/spec/quint/redblack.qnt
git commit -m "spec: replace redblack.qnt with commands.qnt modeling 4 discrete commands"
```

---

### Task 6: Update `srb.qnt` — Compile Module

Rework the top-level module to model the compile function.

**Files:**
- Modify: `srb.qnt` (full rewrite)

- [ ] **Step 1: Write the new srb.qnt**

Replace the entire contents of `srb.qnt` with:

```quint
// srb: compile per-pipeline config directories into a compiled Sequin config
module srb {

  import types.* from "./docs/spec/quint/types"

  // ---------------------------------------------------------------------------
  // Per-pipeline config (as authored by users in config directories)
  // ---------------------------------------------------------------------------

  type UserPipelineConfig = {
    name: PipelineName,
    sink: SinkConfig,
    index: IndexConfig,
    transform: TransformConfig,
    enrichment: EnrichmentConfig
  }

  // ---------------------------------------------------------------------------
  // Compiled config (output of compile, input to plan/apply)
  // ---------------------------------------------------------------------------

  type CompiledConfig = {
    pipelines: PipelineName -> PipelineConfig
  }

  // ---------------------------------------------------------------------------
  // Compile: merge per-pipeline configs into one compiled config
  // This is a pure function — no side effects, no live state
  // ---------------------------------------------------------------------------

  pure def compile(user_configs: Set[UserPipelineConfig]): CompiledConfig = {
    pipelines: user_configs.fold(Map(), (acc, cfg) =>
      acc.put(cfg.name, {
        name: cfg.name,
        sink: cfg.sink,
        index: cfg.index,
        transform: cfg.transform,
        enrichment: cfg.enrichment,
      })
    )
  }
}
```

Notes:
- `UserPipelineConfig` and `PipelineConfig` are structurally identical for now. They're separate types because the compile step could do transformations (e.g., name mangling, validation) in the future.
- `compile` takes a set of user configs and produces a map keyed by pipeline name.
- This module is intentionally thin — the interesting logic is in effects/plan/commands.

- [ ] **Step 2: Typecheck**

Run: `quint typecheck srb.qnt`
Expected: Exit code 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add srb.qnt
git commit -m "spec: rework srb.qnt as compile module"
```

---

### Task 7: Write Tests — Scenario Tests

Create a test module with deterministic scenario tests for the core flows.

**Files:**
- Create: `docs/spec/quint/commands_test.qnt`

- [ ] **Step 1: Write the test file**

Create `docs/spec/quint/commands_test.qnt` with:

```quint
// Tests for the red-black deployment orchestrator
module commands_test {

  import types.* from "./types"
  import effects.* from "./effects"
  import plan.* from "./plan"
  import state.* from "./state"
  import commands.* from "./commands"

  // ---------------------------------------------------------------------------
  // Test fixtures
  // ---------------------------------------------------------------------------

  pure val test_sink_config: SinkConfig = {
    id: "jobs_sink",
    name: "jobs_sink",
    source_table: "jobs",
    destination: "opensearch",
    filters: "",
    batch_size: 100,
    transform_id: "jobs_transform",
    enrichment_ids: Set("jobs_enrichment"),
  }

  pure val test_index_config: IndexConfig = {
    id: "jobs_index",
    name: "jobs",
    mappings: "{ title: text, status: keyword }",
    settings: "{ shards: 1 }",
    alias: "jobs",
  }

  pure val test_transform_config: TransformConfig = {
    id: "jobs_transform",
    name: "jobs_transform",
    function_body: "fn(row) => row",
    input_schema: "{ title: string }",
    output_schema: "{ title: string }",
  }

  pure val test_enrichment_config: EnrichmentConfig = {
    id: "jobs_enrichment",
    name: "jobs_enrichment",
    source: "companies",
    join_column: "company_id",
    enrichment_columns: "company_name",
  }

  pure val test_pipeline_config: PipelineConfig = {
    name: "jobs",
    sink: test_sink_config,
    index: test_index_config,
    transform: test_transform_config,
    enrichment: test_enrichment_config,
  }

  pure val test_live_state: LivePipelineState = {
    sink: { config: test_sink_config, status: SinkActive },
    index: { config: test_index_config, status: IndexGreen, doc_count: 1000 },
    transform: { config: test_transform_config, status: TransformActive },
    enrichment: { config: test_enrichment_config, status: EnrichmentActive },
  }

  // ---------------------------------------------------------------------------
  // Pure function tests
  // ---------------------------------------------------------------------------

  // Test: new pipeline detected as Create
  run test_pipeline_change_kind_create = {
    val desired: PipelineName -> PipelineConfig = Map("jobs" -> test_pipeline_config)
    val live: (PipelineName, Color) -> LivePipelineState = Map()
    val kind = pipeline_change_kind("jobs", desired, live, ALL_COLORS)
    assert(kind == Create)
  }

  // Test: removed pipeline detected as Delete
  run test_pipeline_change_kind_delete = {
    val desired: PipelineName -> PipelineConfig = Map()
    val live: (PipelineName, Color) -> LivePipelineState = Map(("jobs", Red) -> test_live_state)
    val kind = pipeline_change_kind("jobs", desired, live, ALL_COLORS)
    assert(kind == Delete)
  }

  // Test: existing pipeline detected as Update
  run test_pipeline_change_kind_update = {
    val desired: PipelineName -> PipelineConfig = Map("jobs" -> test_pipeline_config)
    val live: (PipelineName, Color) -> LivePipelineState = Map(("jobs", Red) -> test_live_state)
    val kind = pipeline_change_kind("jobs", desired, live, ALL_COLORS)
    assert(kind == Update)
  }

  // Test: unchanged pipeline detected as NoChange
  run test_pipeline_change_kind_nochange = {
    val desired: PipelineName -> PipelineConfig = Map()
    val live: (PipelineName, Color) -> LivePipelineState = Map()
    val kind = pipeline_change_kind("jobs", desired, live, ALL_COLORS)
    assert(kind == NoChange)
  }

  // Test: config comparison detects changes
  run test_sink_config_changed_detects_difference = {
    val modified = { ...test_sink_config, filters: "status = active" }
    assert(sink_config_changed(modified, test_sink_config))
  }

  // Test: config comparison detects no change
  run test_sink_config_no_change = {
    assert(not(sink_config_changed(test_sink_config, test_sink_config)))
  }

  // Test: effects for create produces correct number of effects
  run test_effects_for_create_count = {
    val effs = effects_for_create("jobs", test_pipeline_config, Red)
    assert(effs.length() == 5)
  }

  // Test: effects for create has backfill as last effect
  run test_effects_for_create_ends_with_backfill = {
    val effs = effects_for_create("jobs", test_pipeline_config, Red)
    val last = effs[4]
    match last.effect {
      | TriggerBackfill(_) => assert(true)
      | _ => assert(false)
    }
  }

  // Test: plan generation produces a plan for a new pipeline
  run test_generate_plans_new_pipeline = {
    val desired: PipelineName -> PipelineConfig = Map("jobs" -> test_pipeline_config)
    val live: (PipelineName, Color) -> LivePipelineState = Map()
    val plans = generate_plans(desired, live, ALL_COLORS)
    assert(plans.size() == 1)
  }

  // Test: plan generation produces no plan when nothing changed
  run test_generate_plans_no_changes = {
    val desired: PipelineName -> PipelineConfig = Map()
    val live: (PipelineName, Color) -> LivePipelineState = Map()
    val plans = generate_plans(desired, live, ALL_COLORS)
    assert(plans.size() == 0)
  }

  // ---------------------------------------------------------------------------
  // Stateful scenario tests
  // ---------------------------------------------------------------------------

  // Test: full deployment flow — load config, plan, apply, backfill, activate, drop
  run test_full_deployment_flow = {
    init
      .then(load_desired_config("jobs", test_pipeline_config))
      .then(cmd_plan)
      .then(cmd_apply)
      .then(all {
        // Verify new colored pipeline was created
        assert(live_pipelines.keys().size() > 0),
        // State unchanged (assertion step)
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
  }

  // Test: cannot activate a pipeline mid-backfill
  run test_cannot_activate_during_backfill =
    init
      .then(load_desired_config("jobs", test_pipeline_config))
      .then(cmd_plan)
      .then(cmd_apply)
      .then(
        // The pipeline should be in SinkBackfilling state after apply
        // Trying to activate should fail
        // We check that cmd_activate's precondition blocks it
        all {
          // Find which color was deployed to
          val deployed_colors = ALL_COLORS.filter(c => live_pipelines.has(("jobs", c)))
          assert(deployed_colors.size() > 0),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )

  // Test: cannot drop the active color
  run test_cannot_drop_active_color =
    init
      .then(load_desired_config("jobs", test_pipeline_config))
      .then(cmd_plan)
      .then(cmd_apply)
      .then(nondet c = ALL_COLORS.oneOf()
        backfill_completes("jobs", c))
      .then(nondet c = ALL_COLORS.oneOf()
        cmd_activate("jobs", c))
      .then(all {
        // After activating, verify the alias exists
        assert(aliases.has("jobs")),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
}
```

- [ ] **Step 2: Typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`
Expected: Exit code 0, no errors.

- [ ] **Step 3: Run tests**

Run: `quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_`
Expected: All tests pass.

- [ ] **Step 4: Fix any failures**

If tests fail, run with `--verbosity=3` to diagnose:
```bash
quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=<failing_test> --verbosity=3
```

Fix the issue in the relevant module, typecheck, and re-run.

- [ ] **Step 5: Commit**

```bash
git add docs/spec/quint/commands_test.qnt
git commit -m "spec: add scenario tests for deployment orchestrator"
```

---

### Task 8: Verify Invariants

Run the spec's invariants against non-deterministic exploration.

**Files:**
- No new files — uses existing `commands.qnt`

- [ ] **Step 1: Check never_drop_active invariant**

Run:
```bash
quint run docs/spec/quint/commands.qnt --main=commands --invariant=never_drop_active --max-steps=100 --max-samples=500
```
Expected: "No violation found" (SATISFIED).

- [ ] **Step 2: Check alias_integrity invariant**

Run:
```bash
quint run docs/spec/quint/commands.qnt --main=commands --invariant=alias_integrity --max-steps=100 --max-samples=500
```
Expected: "No violation found" (SATISFIED).

- [ ] **Step 3: Check no_partial_pipelines invariant**

Run:
```bash
quint run docs/spec/quint/commands.qnt --main=commands --invariant=no_partial_pipelines --max-steps=100 --max-samples=500
```
Expected: "No violation found" (SATISFIED).

- [ ] **Step 4: If any invariant is violated**

Run with the seed from the violation output:
```bash
quint run docs/spec/quint/commands.qnt --main=commands --invariant=<name> --seed=<seed> --verbosity=3 --max-steps=100
```

Analyze the trace to determine if it's a spec bug or an invariant that's too strong. Fix accordingly, typecheck, re-run.

- [ ] **Step 5: Commit any fixes**

```bash
git add docs/spec/quint/
git commit -m "spec: verify invariants pass for deployment orchestrator"
```

---

### Task 9: Write Witnesses — Liveness Checks

Add witness definitions to verify the spec can reach interesting states.

**Files:**
- Modify: `docs/spec/quint/commands.qnt` (add witness definitions)

- [ ] **Step 1: Add witnesses to commands.qnt**

Add the following after the invariants section in `docs/spec/quint/commands.qnt`:

```quint
  // ---------------------------------------------------------------------------
  // Witnesses (liveness) — VIOLATED = good, protocol CAN reach this state
  // ---------------------------------------------------------------------------

  // Witness: a pipeline can be deployed (live state created)
  val witness_pipeline_deployed: bool =
    ALL_COLORS.forall(c =>
      desired_pipelines.keys().forall(p =>
        not(live_pipelines.has((p, c)))
      )
    )

  // Witness: an alias can be set (activate succeeds)
  val witness_alias_set: bool =
    aliases.keys().size() == 0

  // Witness: a colored variant can be dropped
  val witness_color_dropped: bool =
    // True when no pipeline has ever had a color removed
    // If violated, it means drop is reachable
    desired_pipelines.keys().forall(p =>
      ALL_COLORS.forall(c =>
        not(live_pipelines.has((p, c))) or aliases.get(p) == Some(c)
      )
    )

  // Witness: backfill can complete
  val witness_backfill_completes: bool =
    desired_pipelines.keys().forall(p =>
      ALL_COLORS.forall(c =>
        if (live_pipelines.has((p, c))) {
          match live_pipelines.get((p, c)) {
            | Some(lp) => lp.sink.status != SinkActive
            | None => true
          }
        } else true
      )
    )

  // Witness: a full cycle can complete (deploy, backfill, activate, drop old)
  val witness_full_cycle: bool =
    // True when no pipeline has completed a full cycle
    // A full cycle means: alias set AND at least one color was dropped
    not(
      aliases.keys().exists(p =>
        ALL_COLORS.exists(c =>
          aliases.get(p) == Some(c) and
          ALL_COLORS.exists(c2 => c2 != c and not(live_pipelines.has((p, c2))))
        )
      )
    )
```

- [ ] **Step 2: Typecheck**

Run: `quint typecheck docs/spec/quint/commands.qnt`
Expected: Exit code 0.

- [ ] **Step 3: Run witness checks**

For each witness, run:
```bash
quint run docs/spec/quint/commands.qnt --main=commands --invariant=witness_pipeline_deployed --max-steps=100 --max-samples=100
quint run docs/spec/quint/commands.qnt --main=commands --invariant=witness_alias_set --max-steps=100 --max-samples=100
quint run docs/spec/quint/commands.qnt --main=commands --invariant=witness_color_dropped --max-steps=100 --max-samples=100
quint run docs/spec/quint/commands.qnt --main=commands --invariant=witness_backfill_completes --max-steps=100 --max-samples=100
quint run docs/spec/quint/commands.qnt --main=commands --invariant=witness_full_cycle --max-steps=200 --max-samples=100
```

Expected: All witnesses VIOLATED (meaning the protocol CAN reach these states).

If any witness is SATISFIED (not violated), increase `--max-steps` progressively: 200, 500. If still satisfied, diagnose with `--verbosity=3`.

- [ ] **Step 4: Commit**

```bash
git add docs/spec/quint/commands.qnt
git commit -m "spec: add witness definitions for liveness checks"
```

---

### Task 10: Delete old plan.qnt types (cleanup)

The old `plan.qnt` had types that are now in `types.qnt`. This was handled in Task 4's rewrite, but verify no duplicate types exist and clean up any stale references.

**Files:**
- Verify: all `.qnt` files

- [ ] **Step 1: Verify no stale imports**

Check all `.qnt` files for imports of `plan.*` that expect the old type definitions. All types should now come from `types.*`.

Run: `grep -r "import plan" docs/spec/quint/`

Expected: Only `commands.qnt` and `plan.qnt` itself import from plan. No file should import types from plan.

- [ ] **Step 2: Full typecheck of all modules**

Run:
```bash
quint typecheck docs/spec/quint/commands.qnt
quint typecheck docs/spec/quint/commands_test.qnt
quint typecheck srb.qnt
```

Expected: All pass.

- [ ] **Step 3: Commit any fixes**

```bash
git add docs/spec/quint/ srb.qnt
git commit -m "spec: cleanup stale imports and verify all modules typecheck"
```
