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
    val has_desired = pipeline.in(desired.keys())
    val has_live = all_colors.exists(c => (pipeline, c).in(live.keys()))
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
