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
    ALL_COLORS.filter(c => live.keys().contains((pipeline, c)))

  // Get colors that have NO live resources for a pipeline (available for deployment)
  pure def available_colors(pipeline: PipelineName, live: (PipelineName, Color) -> LivePipelineState): Set[Color] =
    ALL_COLORS.filter(c => not(live.keys().contains((pipeline, c))))

  // Check if a pipeline has any live colored variants
  pure def pipeline_exists_live(pipeline: PipelineName, live: (PipelineName, Color) -> LivePipelineState): bool =
    ALL_COLORS.exists(c => live.keys().contains((pipeline, c)))

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
