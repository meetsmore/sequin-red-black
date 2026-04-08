// Plan generation: diff desired config against live state, produce effects
module plan {

  import types.* from "./types"

  // ---------------------------------------------------------------------------
  // Change detection
  // ---------------------------------------------------------------------------

  // What kind of change was detected for a resource
  type ChangeKind =
    | NoChange
    | Create
    | Update
    | Delete

  // Which fields changed on an update (modeled as a set of field names)
  type FieldChange = {
    field_name: str,
    requires_backfill: bool,
    requires_reindex: bool
  }

  type ResourceChange = {
    resource_id: ResourceId,
    kind: ChangeKind,
    desired: ResourceConfig,
    field_changes: Set[FieldChange]
  }

  // ---------------------------------------------------------------------------
  // Effects — the operations a plan can produce
  // ---------------------------------------------------------------------------

  type Effect =
    | CreateSink(SinkConfig)
    | UpdateSink(SinkConfig)
    | DeleteSink(ResourceId)
    | CreateIndex(IndexConfig)
    | UpdateIndex(IndexConfig)
    | DeleteIndex(ResourceId)
    | CreateTransform(TransformConfig)
    | UpdateTransform(TransformConfig)
    | DeleteTransform(ResourceId)
    | CreateEnrichment(EnrichmentConfig)
    | UpdateEnrichment(EnrichmentConfig)
    | DeleteEnrichment(ResourceId)
    | TriggerBackfill(ResourceId)
    | TriggerReindex(ResourceId)
    | SwapAlias({ resource_id: ResourceId, color: Color })

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
    changes: Set[ResourceChange],
    effects: List[PlannedEffect],
    target_color: Color
  }
}
