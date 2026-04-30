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
    os_indices: Set[(PipelineName, Color)],
    all_colors: Set[Color]
  ): Color =
    val available = all_colors.filter(c =>
      not((pipeline, c).in(live.keys())) and not((pipeline, c).in(os_indices))
    )
    // In the spec, we just pick one non-deterministically
    // oneOf requires a non-empty set — caller must ensure available is non-empty
    available.fold(Red, (acc, c) => c)

  // Pick the "in-place active color": the currently-deployed color for this
  // pipeline. The OpenSearch alias is intentionally NOT consulted — `--in-place`
  // trusts what Sequin has running, not where the alias happens to point.
  // (The alias may lag during cutovers, manual surgery, or partial failures.)
  //
  // When multiple colors are deployed (transient state mid-rollout) the choice
  // is deterministic via fold-with-default; deployed colors win regardless of
  // alias state.
  //
  // Returns Red as a sentinel when no color is deployed; callers must check
  // pipeline_change_kind first and only invoke this for kind=Update.
  pure def pick_in_place_color(
    pipeline: PipelineName,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color]
  ): Color =
    val deployed = all_colors.filter(c => (pipeline, c).in(live.keys()))
    deployed.fold(Red, (acc, c) => c)

  // Generate plans, optionally in --in-place mode.
  //
  // Standard mode (in_place=false): pick a fresh color via pick_target_color
  // for every change, dispatch to backfill / reindex / in-place-operational
  // based on what changed.
  //
  // In-place mode (in_place=true): for kind=Update pipelines, target the
  // currently-deployed color and force effects_for_in_place_full_update
  // regardless of whether the change would normally need a backfill or
  // reindex. kind=Create still falls through to fresh-color allocation —
  // a pipeline that doesn't exist yet has nothing to update in place.
  pure def generate_plans_with_options(
    desired: PipelineName -> PipelineConfig,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color],
    os_indices: Set[(PipelineName, Color)],
    in_place: bool
  ): Set[Plan] =
    val pipelines = all_pipeline_names(desired, live, all_colors)
    pipelines
      .map(p => {
        val kind = pipeline_change_kind(p, desired, live, all_colors)
        val target = if (in_place and kind == Update)
                       pick_in_place_color(p, live, all_colors)
                     else
                       pick_target_color(p, live, os_indices, all_colors)
        plan_for_pipeline_options(p, desired, live, target, all_colors, in_place)
      })
      .filter(p => p.effects.length() > 0)

  // Backwards-compatible default: in_place=false (normal red-black).
  pure def generate_plans(
    desired: PipelineName -> PipelineConfig,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color],
    os_indices: Set[(PipelineName, Color)]
  ): Set[Plan] =
    generate_plans_with_options(desired, live, all_colors, os_indices, false)
}
