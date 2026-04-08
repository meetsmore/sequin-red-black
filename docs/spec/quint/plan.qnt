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
    desired.keys().union(live.keys().map(k => k._1))

  // Pick an available color for a pipeline (non-deterministic in spec)
  // Returns a color that has no live resources for this pipeline
  pure def pick_target_color(
    pipeline: PipelineName,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color]
  ): Color =
    val available = all_colors.filter(c => not((pipeline, c).in(live.keys())))
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
