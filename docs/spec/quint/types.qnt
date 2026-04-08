// Core type definitions for red-black deployment resources
module types {

  // ---------------------------------------------------------------------------
  // Identifiers
  // ---------------------------------------------------------------------------

  type ResourceId = str
  type PipelineName = str

  // Typed resource IDs — newtype wrappers to prevent mixing up IDs
  type SinkId = Sid(str)
  type IndexId = Iid(str)
  type TransformId = Tid(str)
  type EnrichmentId = Eid(str)

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
    id: SinkId,
    name: str,
    source_table: str,
    destination: str,
    filters: str,
    batch_size: int,
    transform_id: TransformId,
    enrichment_ids: Set[EnrichmentId]
  }

  type SinkLifecycle =
    | SinkActive
    | SinkPaused
    | SinkDisabled

  type SinkState = {
    config: SinkConfig,
    lifecycle: SinkLifecycle,
    backfilling: bool
  }

  // ---------------------------------------------------------------------------
  // OpenSearch Index
  // ---------------------------------------------------------------------------

  type IndexConfig = {
    id: IndexId,
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
    id: TransformId,
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
    id: EnrichmentId,
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
    | DeleteSink(SinkId)
    | DeleteIndex(IndexId)
    | DeleteTransform(TransformId)
    | DeleteEnrichment(EnrichmentId)
    | TriggerBackfill(SinkId)
    | TriggerReindex(IndexId)
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
