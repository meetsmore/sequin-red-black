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

  pure val fixture_sink_config: SinkConfig = {
    id: Sid("jobs_sink"),
    name: "jobs_sink",
    source_table: "jobs",
    destination: "opensearch",
    filters: "",
    batch_size: 100,
    transform_id: Tid("jobs_transform"),
    enrichment_ids: Set(Eid("jobs_enrichment")),
  }

  pure val fixture_index_config: IndexConfig = {
    id: Iid("jobs_index"),
    name: "jobs",
    mappings: "{ title: text, status: keyword }",
    settings: "{ shards: 1 }",
    alias: "jobs",
  }

  pure val fixture_transform_config: TransformConfig = {
    id: Tid("jobs_transform"),
    name: "jobs_transform",
    function_body: "fn(row) => row",
    input_schema: "{ title: string }",
    output_schema: "{ title: string }",
  }

  pure val fixture_enrichment_config: EnrichmentConfig = {
    id: Eid("jobs_enrichment"),
    name: "jobs_enrichment",
    source: "companies",
    join_column: "company_id",
    enrichment_columns: "company_name",
  }

  pure val fixture_pipeline_config: PipelineConfig = {
    name: "jobs",
    sink: fixture_sink_config,
    index: fixture_index_config,
    transform: fixture_transform_config,
    enrichment: fixture_enrichment_config,
    syncs: List(),
  }

  pure val fixture_live_state: LivePipelineState = {
    sink: { config: fixture_sink_config, lifecycle: SinkActive, backfilling: false },
    index: { config: fixture_index_config, status: IndexGreen, doc_count: 1000 },
    transform: { config: fixture_transform_config, status: TransformActive },
    enrichment: { config: fixture_enrichment_config, status: EnrichmentActive },
    syncs: List(),
  }

  // A second pipeline for multi-pipeline tests
  pure val fixture_clients_sink: SinkConfig = {
    id: Sid("clients_sink"),
    name: "clients_sink",
    source_table: "clients",
    destination: "opensearch",
    filters: "",
    batch_size: 200,
    transform_id: Tid("clients_transform"),
    enrichment_ids: Set(Eid("clients_enrichment")),
  }

  pure val fixture_clients_index: IndexConfig = {
    id: Iid("clients_index"),
    name: "clients",
    mappings: "{ name: text, email: keyword }",
    settings: "{ shards: 1 }",
    alias: "clients",
  }

  pure val fixture_clients_transform: TransformConfig = {
    id: Tid("clients_transform"),
    name: "clients_transform",
    function_body: "fn(row) => row",
    input_schema: "{ name: string }",
    output_schema: "{ name: string }",
  }

  pure val fixture_clients_enrichment: EnrichmentConfig = {
    id: Eid("clients_enrichment"),
    name: "clients_enrichment",
    source: "accounts",
    join_column: "account_id",
    enrichment_columns: "account_name",
  }

  pure val fixture_clients_config: PipelineConfig = {
    name: "clients",
    sink: fixture_clients_sink,
    index: fixture_clients_index,
    transform: fixture_clients_transform,
    enrichment: fixture_clients_enrichment,
    syncs: List(),
  }

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

  // ---------------------------------------------------------------------------
  // Helpers for extracting deployed color from live state
  // ---------------------------------------------------------------------------

  // Get the single deployed color for a pipeline (assumes exactly one exists)
  pure def deployed_color_for(pipeline: PipelineName, live: (PipelineName, Color) -> LivePipelineState): Color =
    ALL_COLORS.filter(c => (pipeline, c).in(live.keys())).fold(Red, (acc, c) => c)

  // ---------------------------------------------------------------------------
  // Pure function tests
  // ---------------------------------------------------------------------------

  // Test: new pipeline detected as Create
  run test_pipeline_change_kind_create = {
    val desired: PipelineName -> PipelineConfig = Map("jobs" -> fixture_pipeline_config)
    val live: (PipelineName, Color) -> LivePipelineState = Map()
    val kind = pipeline_change_kind("jobs", desired, live, ALL_COLORS)
    assert(kind == Create)
  }

  // Test: removed pipeline detected as Delete
  run test_pipeline_change_kind_delete = {
    val desired: PipelineName -> PipelineConfig = Map()
    val live: (PipelineName, Color) -> LivePipelineState = Map(("jobs", Red) -> fixture_live_state)
    val kind = pipeline_change_kind("jobs", desired, live, ALL_COLORS)
    assert(kind == Delete)
  }

  // Test: existing pipeline detected as Update
  run test_pipeline_change_kind_update = {
    val desired: PipelineName -> PipelineConfig = Map("jobs" -> fixture_pipeline_config)
    val live: (PipelineName, Color) -> LivePipelineState = Map(("jobs", Red) -> fixture_live_state)
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
    val modified = { ...fixture_sink_config, filters: "status = active" }
    assert(sink_config_changed(modified, fixture_sink_config))
  }

  // Test: config comparison detects no change
  run test_sink_config_no_change = {
    assert(not(sink_config_changed(fixture_sink_config, fixture_sink_config)))
  }

  // Test: effects for create produces correct number of effects
  run test_effects_for_create_count = {
    val effs = effects_for_create("jobs", fixture_pipeline_config, Red)
    assert(effs.length() == 5)
  }

  // Test: effects for create has backfill as last effect
  run test_effects_for_create_ends_with_backfill = {
    val effs = effects_for_create("jobs", fixture_pipeline_config, Red)
    val last = effs[4]
    match last.effect {
      | TriggerBackfill(_) => assert(true)
      | _ => assert(false)
    }
  }

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

  // Test: effects_for_delete_color with syncs includes 7 effects (3 sync + 4 primary)
  run test_effects_for_delete_with_sync_count = {
    val effs = effects_for_delete_color("jobs", fixture_live_with_sync, Red)
    // 3 sync deletes (sink, transform, enrichment) + 4 primary deletes (sink, transform, enrichment, index)
    assert(effs.length() == 7)
  }

  // Test: sync-only change does NOT trigger needs_backfill
  run test_sync_only_change_no_backfill = {
    // Same primary config, different sync count
    assert(not(needs_backfill(fixture_pipeline_with_sync, fixture_live_with_sync)))
  }

  // Test: plan generation produces a plan for a new pipeline
  run test_generate_plans_new_pipeline = {
    val desired: PipelineName -> PipelineConfig = Map("jobs" -> fixture_pipeline_config)
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

  // Test: full deployment flow — load config, plan, apply
  run test_full_deployment_flow = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_plan)
      .then(cmd_apply(false))
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

  // Test: activate after backfill completes
  run test_activate_after_backfill = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val deployed_keys = live_pipelines.keys()
        val deployed_key = deployed_keys.fold(("", Red), (acc, k) => k)
        backfill_completes(deployed_key._1, deployed_key._2)
      )
      .then(
        val deployed_keys = live_pipelines.keys()
        val deployed_key = deployed_keys.fold(("", Red), (acc, k) => k)
        cmd_activate(deployed_key._1, deployed_key._2)
      )
      .then(all {
        assert("jobs".in(aliases.keys())),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
  }

  // ===========================================================================
  // End-to-end scenario tests
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Scenario 1: Fresh setup from nothing
  // We just deployed Sequin and want to set up a single pipeline against
  // existing OpenSearch. Load config → apply → verify resources created for
  // exactly one color → backfill → activate → verify alias set.
  // ---------------------------------------------------------------------------

  run test_e2e_fresh_setup_single_pipeline = {
    init
      // User writes config for "jobs" pipeline
      .then(load_desired_config("jobs", fixture_pipeline_config))
      // Plan: should produce exactly 1 plan with Create effects
      .then(cmd_plan)
      .then(all {
        assert(current_plans.size() == 1),
        // The plan should be for "jobs"
        assert(current_plans.forall(p => p.pipeline == "jobs")),
        // The plan should have 5 effects (index, transform, enrichment, sink, backfill)
        assert(current_plans.forall(p => p.effects.length() == 5)),
        // The change kind should be Create
        assert(current_plans.forall(p => p.changes.forall(c => c.kind == Create))),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
      // Apply: creates resources and starts backfill
      .then(cmd_apply(false))
      .then(all {
        // Exactly one colored variant should exist
        assert(live_pipelines.keys().size() == 1),
        // The sink should be active + backfilling
        assert(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).sink.lifecycle == SinkActive),
        assert(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).sink.backfilling),
        // Index should be green with 0 docs (fresh)
        assert(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).index.status == IndexGreen),
        assert(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).index.doc_count == 0),
        // Transform and enrichment should be active
        assert(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).transform.status == TransformActive),
        assert(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).enrichment.status == EnrichmentActive),
        // No alias yet (haven't activated)
        assert(not("jobs".in(aliases.keys()))),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
      // Backfill completes
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(all {
        // Sink should no longer be backfilling
        assert(not(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).sink.backfilling)),
        assert(live_pipelines.get(("jobs", deployed_color_for("jobs", live_pipelines))).sink.lifecycle == SinkActive),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
      // Activate: point alias to the new color
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        all {
          // Alias should be set
          assert("jobs".in(aliases.keys())),
          // Alias should point to our deployed color
          assert(aliases.get("jobs") == color),
          // Still exactly one live variant
          assert(live_pipelines.keys().size() == 1),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 2: Fresh setup with multiple pipelines
  // Two pipelines (jobs + clients) provisioned at once.
  // ---------------------------------------------------------------------------

  run test_e2e_fresh_setup_multi_pipeline = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(load_desired_config("clients", fixture_clients_config))
      // Apply both at once
      .then(cmd_apply(false))
      .then(
        val jobs_color = deployed_color_for("jobs", live_pipelines)
        val clients_color = deployed_color_for("clients", live_pipelines)
        all {
          // Should have 2 live colored variants (one per pipeline)
          assert(live_pipelines.keys().size() == 2),
          // Both should be backfilling
          assert(live_pipelines.get(("jobs", jobs_color)).sink.backfilling),
          assert(live_pipelines.get(("clients", clients_color)).sink.backfilling),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Complete backfills and activate independently
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      .then(
        val clients_color = deployed_color_for("clients", live_pipelines)
        all {
          // Jobs is active, clients still backfilling
          assert("jobs".in(aliases.keys())),
          assert(not("clients".in(aliases.keys()))),
          assert(live_pipelines.get(("clients", clients_color)).sink.backfilling),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      .then(
        val color = deployed_color_for("clients", live_pipelines)
        backfill_completes("clients", color)
      )
      .then(
        val color = deployed_color_for("clients", live_pipelines)
        cmd_activate("clients", color)
      )
      .then(all {
        // Both active
        assert("jobs".in(aliases.keys())),
        assert("clients".in(aliases.keys())),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
  }

  // ---------------------------------------------------------------------------
  // Scenario 3: Change a transform on an existing pipeline
  // Pipeline "jobs" is live on Red. User changes the transform function.
  // Apply creates a new color, backfill, activate new, drop old.
  // ---------------------------------------------------------------------------

  run test_e2e_update_transform = {
    init
      // Setup: jobs is live on Red (simulate by loading + apply + backfill + activate)
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      // Now change the transform
      .then(
        val updated_transform = { ...fixture_transform_config, function_body: "fn(row) => { ...row, extra: true }" }
        val updated_config = { ...fixture_pipeline_config, transform: updated_transform }
        load_desired_config("jobs", updated_config)
      )
      // Apply: should create a NEW colored variant (different from current)
      .then(cmd_apply(false))
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val old_color = aliases.get("jobs")
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        all {
          // Should now have 2 colored variants for jobs
          assert(jobs_colors.size() == 2),
          // The new color should be backfilling
          assert(live_pipelines.get(("jobs", new_color)).sink.backfilling),
          // The old color should NOT be backfilling (it's the active one)
          assert(not(live_pipelines.get(("jobs", old_color)).sink.backfilling)),
          // The new color should have the updated transform
          assert(live_pipelines.get(("jobs", new_color)).transform.config.function_body == "fn(row) => { ...row, extra: true }"),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Backfill the new color
      .then(
        val old_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        backfill_completes("jobs", new_color)
      )
      // Activate the new color
      .then(
        val old_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        cmd_activate("jobs", new_color)
      )
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val active_color = aliases.get("jobs")
        all {
          // Alias should now point to new color
          assert(jobs_colors.size() == 2),
          // Verify the active color has the new transform
          assert(live_pipelines.get(("jobs", active_color)).transform.config.function_body == "fn(row) => { ...row, extra: true }"),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Drop the old color
      .then(
        val active_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val old_color = jobs_colors.exclude(Set(active_color)).fold(Red, (acc, c) => c)
        cmd_drop("jobs", old_color)
      )
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        all {
          // Only one color should remain
          assert(jobs_colors.size() == 1),
          // And it should be the active one
          assert(aliases.get("jobs").in(jobs_colors)),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 4: Change index mappings — uses reindex path (not backfill)
  // Only index config changed, so documents are already correct. Reindex copies
  // them to a new index with the new schema. Minutes instead of hours.
  // ---------------------------------------------------------------------------

  run test_e2e_update_mappings = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      // Change mappings: add an "owner" field
      .then(
        val updated_index = { ...fixture_index_config, mappings: "{ title: text, status: keyword, owner: keyword }" }
        val updated_config = { ...fixture_pipeline_config, index: updated_index }
        load_desired_config("jobs", updated_config)
      )
      // Plan to verify effects — should use TriggerReindex, not TriggerBackfill
      .then(cmd_plan)
      .then(all {
        assert(current_plans.size() == 1),
        // Should produce 5 effects (index, transform, enrichment, sink, reindex)
        assert(current_plans.forall(p => p.effects.length() == 5)),
        // Last effect should be TriggerReindex, not TriggerBackfill
        assert(current_plans.forall(p => match p.effects[4].effect {
          | TriggerReindex(_) => true
          | _ => false
        })),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
      // Apply
      .then(cmd_apply(false))
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val old_color = aliases.get("jobs")
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        all {
          // Two colors now
          assert(jobs_colors.size() == 2),
          // New color has updated mappings
          assert(live_pipelines.get(("jobs", new_color)).index.config.mappings == "{ title: text, status: keyword, owner: keyword }"),
          // Old color still has original mappings
          assert(live_pipelines.get(("jobs", old_color)).index.config.mappings == "{ title: text, status: keyword }"),
          // Reindex path: index starts as IndexReindexing (not Green)
          assert(live_pipelines.get(("jobs", new_color)).index.status == IndexReindexing),
          // Reindex path: sink is NOT backfilling (data comes from reindex, not Sequin)
          assert(not(live_pipelines.get(("jobs", new_color)).sink.backfilling)),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 4b: Full reindex flow — reindex completes, activate, drop old
  // ---------------------------------------------------------------------------

  run test_e2e_reindex_full_cycle = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      // Change only mappings
      .then(
        val updated_index = { ...fixture_index_config, mappings: "{ title: text, status: keyword, owner: keyword }" }
        val updated_config = { ...fixture_pipeline_config, index: updated_index }
        load_desired_config("jobs", updated_config)
      )
      .then(cmd_apply(false))
      // Reindex completes
      .then(
        val old_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        reindex_completes("jobs", new_color)
      )
      .then(
        val old_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        all {
          // Index should now be green
          assert(live_pipelines.get(("jobs", new_color)).index.status == IndexGreen),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Activate the new color
      .then(
        val old_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        cmd_activate("jobs", new_color)
      )
      .then(
        val active_color = aliases.get("jobs")
        all {
          // Active color should have new mappings
          assert(live_pipelines.get(("jobs", active_color)).index.config.mappings == "{ title: text, status: keyword, owner: keyword }"),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Drop old color
      .then(
        val active_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val old_color = jobs_colors.exclude(Set(active_color)).fold(Red, (acc, c) => c)
        cmd_drop("jobs", old_color)
      )
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        all {
          assert(jobs_colors.size() == 1),
          assert(aliases.get("jobs").in(jobs_colors)),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 4c: Change only batch_size — in-place update, no new color
  // Operational fields don't affect document content, so the existing sink
  // is updated directly. No backfill, no reindex, no new color.
  // ---------------------------------------------------------------------------

  run test_e2e_in_place_batch_size_update = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      // Change only batch_size (operational, no data impact)
      .then(
        val updated_sink = { ...fixture_sink_config, batch_size: 500 }
        val updated_config = { ...fixture_pipeline_config, sink: updated_sink }
        load_desired_config("jobs", updated_config)
      )
      // Plan should produce an UpdateSink effect
      .then(cmd_plan)
      .then(all {
        assert(current_plans.size() == 1),
        // Only 1 effect: UpdateSink (not 5 for full red-black)
        assert(current_plans.forall(p => p.effects.length() == 1)),
        // The effect should be UpdateSink
        assert(current_plans.forall(p => match p.effects[0].effect {
          | UpdateSink(_) => true
          | _ => false
        })),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
      // Apply: should update existing sink in place, no new color
      .then(cmd_apply(false))
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val color = deployed_color_for("jobs", live_pipelines)
        all {
          // Still only one color (no new color created)
          assert(jobs_colors.size() == 1),
          // Sink config updated with new batch_size
          assert(live_pipelines.get(("jobs", color)).sink.config.batch_size == 500),
          // Sink is NOT backfilling
          assert(not(live_pipelines.get(("jobs", color)).sink.backfilling)),
          // Index unchanged
          assert(live_pipelines.get(("jobs", color)).index.status == IndexGreen),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 5: Change enrichment config
  // Pipeline exists, user changes the enrichment join column.
  // ---------------------------------------------------------------------------

  run test_e2e_update_enrichment = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      // Change enrichment: different join column
      .then(
        val updated_enrichment = { ...fixture_enrichment_config, join_column: "org_id" }
        val updated_config = { ...fixture_pipeline_config, enrichment: updated_enrichment }
        load_desired_config("jobs", updated_config)
      )
      .then(cmd_apply(false))
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val old_color = aliases.get("jobs")
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        all {
          assert(jobs_colors.size() == 2),
          // New color has updated enrichment
          assert(live_pipelines.get(("jobs", new_color)).enrichment.config.join_column == "org_id"),
          // Old color has original
          assert(live_pipelines.get(("jobs", old_color)).enrichment.config.join_column == "company_id"),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 6: No-op — config unchanged, plan produces no effects
  // ---------------------------------------------------------------------------

  run test_e2e_no_changes_no_plan = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      // Re-load the same config (no changes)
      .then(load_desired_config("jobs", fixture_pipeline_config))
      // Plan: field-level diff detects no changes, so no plans with effects
      .then(cmd_plan)
      .then(all {
        // No plans generated (field-level diff sees configs match)
        assert(current_plans.size() == 0),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
  }

  // ---------------------------------------------------------------------------
  // Scenario 7: Multiple pipelines, only one changes
  // Both "jobs" and "clients" are live. Only "clients" transform changes.
  // Apply should create a new color for clients but leave jobs alone.
  // ---------------------------------------------------------------------------

  run test_e2e_multi_pipeline_partial_change = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(load_desired_config("clients", fixture_clients_config))
      .then(cmd_apply(false))
      // Complete backfills and activate both
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("clients", live_pipelines)
        backfill_completes("clients", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      .then(
        val color = deployed_color_for("clients", live_pipelines)
        cmd_activate("clients", color)
      )
      // Change only clients transform
      .then(
        val updated_transform = { ...fixture_clients_transform, function_body: "fn(row) => { ...row, full_name: row.name }" }
        val updated_config = { ...fixture_clients_config, transform: updated_transform }
        load_desired_config("clients", updated_config)
      )
      .then(cmd_apply(false))
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val clients_colors = ALL_COLORS.filter(c => ("clients", c).in(live_pipelines.keys()))
        all {
          // Field-level diff: only clients changed, jobs stays at 1 color
          assert(jobs_colors.size() == 1),
          assert(clients_colors.size() == 2),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 8: Rollback — activate back to old color after discovering
  // issues with the new one.
  // ---------------------------------------------------------------------------

  run test_e2e_rollback_to_old_color = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply(false))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      // Deploy a change (new transform)
      .then(
        val updated_transform = { ...fixture_transform_config, function_body: "fn(row) => broken(row)" }
        val updated_config = { ...fixture_pipeline_config, transform: updated_transform }
        load_desired_config("jobs", updated_config)
      )
      .then(cmd_apply(false))
      .then(
        val old_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        backfill_completes("jobs", new_color)
      )
      .then(
        // Activate the new color
        val old_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val new_color = jobs_colors.exclude(Set(old_color)).fold(Red, (acc, c) => c)
        cmd_activate("jobs", new_color)
      )
      // Oh no, the new transform is broken! Rollback to old color
      .then(
        // The old color still exists (we haven't dropped it)
        val active_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val old_color = jobs_colors.exclude(Set(active_color)).fold(Red, (acc, c) => c)
        cmd_activate("jobs", old_color)
      )
      .then(
        val active_color = aliases.get("jobs")
        all {
          // Should be back on old color with original transform
          assert(live_pipelines.get(("jobs", active_color)).transform.config.function_body == "fn(row) => row"),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Now drop the bad color
      .then(
        val active_color = aliases.get("jobs")
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        val bad_color = jobs_colors.exclude(Set(active_color)).fold(Red, (acc, c) => c)
        cmd_drop("jobs", bad_color)
      )
      .then(
        val jobs_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
        all {
          // Only original color remains
          assert(jobs_colors.size() == 1),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
  }

  // ---------------------------------------------------------------------------
  // Scenario 9: Apply with skip_backfill — user manages backfills manually
  // ---------------------------------------------------------------------------

  run test_e2e_skip_backfill_then_manual = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      // Apply with skip_backfill=true
      .then(cmd_apply(true))
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        val lp = live_pipelines.get(("jobs", color))
        all {
          // Sink should NOT be backfilling (we skipped it)
          assert(not(lp.sink.backfilling)),
          assert(lp.sink.lifecycle == SinkActive),
          // Plan should still contain TriggerBackfill effect (for visibility)
          assert(current_plans.forall(p => p.effects.length() == 5)),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // User can activate immediately (no backfill in progress)
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      .then(all {
        assert("jobs".in(aliases.keys())),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
  }

  // ---------------------------------------------------------------------------
  // Scenario 10: Skip backfill, then manually trigger backfills one by one
  // Two pipelines, user runs backfills sequentially to avoid overloading Sequin
  // ---------------------------------------------------------------------------

  run test_e2e_skip_backfill_manual_sequential = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(load_desired_config("clients", fixture_clients_config))
      // Apply both with skip_backfill
      .then(cmd_apply(true))
      .then(
        val jobs_color = deployed_color_for("jobs", live_pipelines)
        val clients_color = deployed_color_for("clients", live_pipelines)
        all {
          // Neither should be backfilling
          assert(not(live_pipelines.get(("jobs", jobs_color)).sink.backfilling)),
          assert(not(live_pipelines.get(("clients", clients_color)).sink.backfilling)),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Manually backfill jobs first
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_backfill("jobs", color)
      )
      .then(
        val jobs_color = deployed_color_for("jobs", live_pipelines)
        val clients_color = deployed_color_for("clients", live_pipelines)
        all {
          // Jobs is now backfilling, clients is not
          assert(live_pipelines.get(("jobs", jobs_color)).sink.backfilling),
          assert(not(live_pipelines.get(("clients", clients_color)).sink.backfilling)),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Jobs backfill completes
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        backfill_completes("jobs", color)
      )
      // Now backfill clients
      .then(
        val color = deployed_color_for("clients", live_pipelines)
        cmd_backfill("clients", color)
      )
      .then(
        val clients_color = deployed_color_for("clients", live_pipelines)
        all {
          assert(live_pipelines.get(("clients", clients_color)).sink.backfilling),
          desired_pipelines' = desired_pipelines,
          live_pipelines' = live_pipelines,
          aliases' = aliases,
          current_plans' = current_plans,
        }
      )
      // Clients backfill completes
      .then(
        val color = deployed_color_for("clients", live_pipelines)
        backfill_completes("clients", color)
      )
      // Now activate both
      .then(
        val color = deployed_color_for("jobs", live_pipelines)
        cmd_activate("jobs", color)
      )
      .then(
        val color = deployed_color_for("clients", live_pipelines)
        cmd_activate("clients", color)
      )
      .then(all {
        assert("jobs".in(aliases.keys())),
        assert("clients".in(aliases.keys())),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
      })
  }

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
}
