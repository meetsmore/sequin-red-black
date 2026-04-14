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
      sink_data_changed(desired, live),
      sink_operational_changed(desired, live),
    }

  // Sink fields that affect document content (need backfill if changed)
  pure def sink_data_changed(desired: SinkConfig, live: SinkConfig): bool =
    or {
      desired.source_table != live.source_table,
      desired.destination != live.destination,
      desired.filters != live.filters,
      desired.transform_id != live.transform_id, // TODO: If transform CODE doesnt change, no need for backfill, even if ID is different (i think this is modelled via `sequin plan` cli command, which will compare actual code).
      desired.enrichment_ids != live.enrichment_ids, // TODO: If enrichment CODE doesnt change, no need for backfill, even if ID is different (i think this is modelled via `sequin plan` cli command, which will compare actual code).
    }

  // Sink fields that are purely operational (can update in place).
  // batch_size is representative — other operational fields will be added here.
  pure def sink_operational_changed(desired: SinkConfig, live: SinkConfig): bool =
    desired.batch_size != live.batch_size

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

  // Compare a sync's config against its live state
  pure def sync_has_changes(desired: SyncConfig, live: LiveSyncState): bool =
    or {
      sink_config_changed(desired.sink, live.sink.config),
      transform_config_changed(desired.transform, live.transform.config),
      enrichment_config_changed(desired.enrichment, live.enrichment.config),
    }

  // Check if any resource in a pipeline has changed
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

  // Does this pipeline need a full backfill? True when document content must change:
  // transform, enrichment, or data-affecting sink fields changed.
  pure def needs_backfill(desired: PipelineConfig, live: LivePipelineState): bool =
    or {
      sink_data_changed(desired.sink, live.sink.config),
      transform_config_changed(desired.transform, live.transform.config),
      enrichment_config_changed(desired.enrichment, live.enrichment.config),
    }

  // Does this pipeline need a reindex? True when index schema changed but
  // document content is fine — just needs to be copied to a new index.
  pure def needs_reindex(desired: PipelineConfig, live: LivePipelineState): bool =
    and {
      index_config_changed(desired.index, live.index.config),
      not(needs_backfill(desired, live)),
    }

  // Does this pipeline have only operational changes? (e.g. batch_size)
  // No new color needed — update existing resources in place.
  pure def needs_in_place_update(desired: PipelineConfig, live: LivePipelineState): bool =
    and {
      pipeline_has_changes(desired, live),
      not(needs_backfill(desired, live)),
      not(needs_reindex(desired, live)),
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

  // Effects for deleting all colored variants of a pipeline
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

  // Effects for reindexing — only index config changed, documents are already correct.
  // Creates a new colored variant with a new index, then reindexes from the old index
  // instead of backfilling from Postgres. Reindex takes minutes vs hours for backfill.
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

  // Effects for in-place update — only operational fields changed (e.g. batch_size).
  // No new color, no backfill, no reindex. Just update the existing sink config.
  pure def effects_for_in_place_update(
    pipeline: PipelineName,
    desired: PipelineConfig,
    live: LivePipelineState
  ): List[PlannedEffect] =
    List(
      { effect: UpdateSink({ id: live.sink.config.id, config: desired.sink }), status: Pending, depends_on: Set(), order: 1 },
    )

  // Effects for updating a pipeline — three paths by escalation:
  // 1. Backfill (hours): document content must change (transform, enrichment, sink data fields)
  // 2. Reindex (minutes): only index schema changed, documents are correct
  // 3. In-place (seconds): only operational fields changed (e.g. batch_size)
  // Backfill subsumes reindex (new index is created as part of the new color).
  // Both backfill and reindex subsume in-place updates (new resources get desired config).
  pure def effects_for_update(
    pipeline: PipelineName,
    desired: PipelineConfig,
    live: LivePipelineState,
    target_color: Color
  ): List[PlannedEffect] =
    if (needs_backfill(desired, live))
      effects_for_create(pipeline, desired, target_color)
    else if (needs_reindex(desired, live))
      effects_for_reindex(pipeline, desired, live.index.config.id, target_color)
    else
      effects_for_in_place_update(pipeline, desired, live)

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
    // For Update, find a live color to compare against for field-level diff
    val live_color = all_colors.filter(c => (pipeline, c).in(live.keys())).fold(Red, (acc, c) => c)
    val effs: List[PlannedEffect] = match kind {
      | Create => effects_for_create(pipeline, desired.get(pipeline), target_color)
      | Update =>
          val live_state = live.get((pipeline, live_color))
          val cfg = desired.get(pipeline)
          if (not(pipeline_has_changes(cfg, live_state))) List()
          else effects_for_update(pipeline, cfg, live_state, target_color)
      | Delete => List()
      | NoChange => List()
    }
    val actual_kind = match kind {
      | Update => if (effs.length() == 0) NoChange else kind
      | _ => kind
    }
    val changes: Set[ResourceChange] = Set({ resource_id: pipeline, kind: actual_kind, field_changes: Set() })
    { pipeline: pipeline, target_color: target_color, changes: changes, effects: effs }
}
