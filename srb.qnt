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
