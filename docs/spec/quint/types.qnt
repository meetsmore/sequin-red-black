// Core type definitions for red-black deployment resources
module types {

  // ---------------------------------------------------------------------------
  // Resource identifiers
  // ---------------------------------------------------------------------------

  // Color of a deployment slot
  type Color =
    | Red
    | Black

  // Unique identifier for any resource
  type ResourceId = str

  // ---------------------------------------------------------------------------
  // Sequin Sink
  // ---------------------------------------------------------------------------

  type SinkConfig = {
    id: ResourceId,
    name: str,
    source_table: str,
    destination: str,
    filters: str,
    batch_size: int,
    transform_id: ResourceId,
    enrichment_ids: Set[ResourceId]
  }

  type SinkStatus =
    | SinkActive
    | SinkPaused
    | SinkBackfilling
    | SinkDisabled

  type SinkState = {
    config: SinkConfig,
    status: SinkStatus,
    color: Color
  }

  // ---------------------------------------------------------------------------
  // OpenSearch Index
  // ---------------------------------------------------------------------------

  type IndexConfig = {
    id: ResourceId,
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
    color: Color,
    doc_count: int
  }

  // ---------------------------------------------------------------------------
  // Sequin Transformation
  // ---------------------------------------------------------------------------

  type TransformConfig = {
    id: ResourceId,
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
    id: ResourceId,
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
  // Unified resource wrapper
  // ---------------------------------------------------------------------------

  type Resource =
    | SinkResource(SinkState)
    | IndexResource(IndexState)
    | TransformResource(TransformState)
    | EnrichmentResource(EnrichmentState)

  type ResourceConfig =
    | SinkCfg(SinkConfig)
    | IndexCfg(IndexConfig)
    | TransformCfg(TransformConfig)
    | EnrichmentCfg(EnrichmentConfig)
}
