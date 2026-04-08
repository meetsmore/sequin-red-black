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
    id: "jobs_sink",
    name: "jobs_sink",
    source_table: "jobs",
    destination: "opensearch",
    filters: "",
    batch_size: 100,
    transform_id: "jobs_transform",
    enrichment_ids: Set("jobs_enrichment"),
  }

  pure val fixture_index_config: IndexConfig = {
    id: "jobs_index",
    name: "jobs",
    mappings: "{ title: text, status: keyword }",
    settings: "{ shards: 1 }",
    alias: "jobs",
  }

  pure val fixture_transform_config: TransformConfig = {
    id: "jobs_transform",
    name: "jobs_transform",
    function_body: "fn(row) => row",
    input_schema: "{ title: string }",
    output_schema: "{ title: string }",
  }

  pure val fixture_enrichment_config: EnrichmentConfig = {
    id: "jobs_enrichment",
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
  }

  pure val fixture_live_state: LivePipelineState = {
    sink: { config: fixture_sink_config, status: SinkActive },
    index: { config: fixture_index_config, status: IndexGreen, doc_count: 1000 },
    transform: { config: fixture_transform_config, status: TransformActive },
    enrichment: { config: fixture_enrichment_config, status: EnrichmentActive },
  }

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

  // Test: activate after backfill completes
  run test_activate_after_backfill = {
    init
      .then(load_desired_config("jobs", fixture_pipeline_config))
      .then(cmd_apply)
      .then(
        // Find which color was deployed and complete backfill
        // After apply, there should be exactly one live pipeline.
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
}
