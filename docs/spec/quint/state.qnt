// Live state and desired state modeling
module state {

  import types.* from "./types"
  import plan.* from "./plan"

  // ---------------------------------------------------------------------------
  // State variables
  // ---------------------------------------------------------------------------

  // The desired state from config files
  var desired_sinks: ResourceId -> SinkConfig
  var desired_indexes: ResourceId -> IndexConfig
  var desired_transforms: ResourceId -> TransformConfig
  var desired_enrichments: ResourceId -> EnrichmentConfig

  // The live state of deployed resources
  var live_sinks: ResourceId -> SinkState
  var live_indexes: ResourceId -> IndexState
  var live_transforms: ResourceId -> TransformState
  var live_enrichments: ResourceId -> EnrichmentState

  // Which color is currently active (receiving traffic)
  var active_color: Color

  // The current plan (if any)
  var current_plan: Plan

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  action init = all {
    desired_sinks' = Map(),
    desired_indexes' = Map(),
    desired_transforms' = Map(),
    desired_enrichments' = Map(),
    live_sinks' = Map(),
    live_indexes' = Map(),
    live_transforms' = Map(),
    live_enrichments' = Map(),
    active_color' = Red,
    current_plan' = { changes: Set(), effects: List(), target_color: Black },
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // The inactive color is the deployment target
  pure def inactive_color(c: Color): Color =
    match c {
      | Red => Black
      | Black => Red
    }

  // ---------------------------------------------------------------------------
  // Config loading (models reading config files)
  // ---------------------------------------------------------------------------

  action load_sink_config(id: ResourceId, cfg: SinkConfig): bool = all {
    desired_sinks' = desired_sinks.put(id, cfg),
    desired_indexes' = desired_indexes,
    desired_transforms' = desired_transforms,
    desired_enrichments' = desired_enrichments,
    live_sinks' = live_sinks,
    live_indexes' = live_indexes,
    live_transforms' = live_transforms,
    live_enrichments' = live_enrichments,
    active_color' = active_color,
    current_plan' = current_plan,
  }

  action load_index_config(id: ResourceId, cfg: IndexConfig): bool = all {
    desired_sinks' = desired_sinks,
    desired_indexes' = desired_indexes.put(id, cfg),
    desired_transforms' = desired_transforms,
    desired_enrichments' = desired_enrichments,
    live_sinks' = live_sinks,
    live_indexes' = live_indexes,
    live_transforms' = live_transforms,
    live_enrichments' = live_enrichments,
    active_color' = active_color,
    current_plan' = current_plan,
  }

  // ---------------------------------------------------------------------------
  // Plan generation (stub — to be expanded)
  // ---------------------------------------------------------------------------

  // Compare desired vs live and produce a plan
  action generate_plan: bool = all {
    // TODO: diff each resource type, collect changes, derive effects
    current_plan' = { changes: Set(), effects: List(), target_color: inactive_color(active_color) },
    desired_sinks' = desired_sinks,
    desired_indexes' = desired_indexes,
    desired_transforms' = desired_transforms,
    desired_enrichments' = desired_enrichments,
    live_sinks' = live_sinks,
    live_indexes' = live_indexes,
    live_transforms' = live_transforms,
    live_enrichments' = live_enrichments,
    active_color' = active_color,
  }
}
