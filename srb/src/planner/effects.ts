// Direct translation of docs/spec/quint/effects.qnt
// All functions are pure — no I/O.

import {
  type Color,
  type SinkConfig,
  type IndexConfig,
  type TransformConfig,
  type EnrichmentConfig,
  type PipelineConfig,
  type LivePipelineState,
  type PlannedEffect,
  type WebhookConfig,
  type LiveWebhookState,
} from "../config/types.js";

// ---------------------------------------------------------------------------
// Config comparison
// ---------------------------------------------------------------------------

/** Sink fields that affect document content (need backfill if changed) */
export function sinkDataChanged(desired: SinkConfig, live: SinkConfig): boolean {
  return (
    desired.sourceTable !== live.sourceTable ||
    desired.destination !== live.destination ||
    desired.filters !== live.filters ||
    desired.transformId !== live.transformId ||
    JSON.stringify([...desired.enrichmentIds].sort()) !==
      JSON.stringify([...live.enrichmentIds].sort())
  );
}

/** Sink fields that are purely operational (can update in place) */
export function sinkOperationalChanged(desired: SinkConfig, live: SinkConfig): boolean {
  return desired.batchSize !== live.batchSize;
}

/** Compare two sink configs — returns true if they differ */
export function sinkConfigChanged(desired: SinkConfig, live: SinkConfig): boolean {
  return sinkDataChanged(desired, live) || sinkOperationalChanged(desired, live);
}

/** Deep comparison with sorted keys — order-independent JSON comparison */
export function sortedStringify(obj: unknown): string {
  return JSON.stringify(obj, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = (v as Record<string, unknown>)[k]; return o; }, {})
      : v
  );
}

/** Compare two index configs — returns true if they differ */
export function indexConfigChanged(desired: IndexConfig, live: IndexConfig): boolean {
  return (
    sortedStringify(desired.mappings) !== sortedStringify(live.mappings) ||
    sortedStringify(desired.settings) !== sortedStringify(live.settings)
  );
}

/** Compare two transform configs — returns true if they differ */
export function transformConfigChanged(desired: TransformConfig, live: TransformConfig): boolean {
  return (
    desired.functionBody !== live.functionBody ||
    desired.inputSchema !== live.inputSchema ||
    desired.outputSchema !== live.outputSchema
  );
}

/** Compare two enrichment configs — returns true if they differ */
export function enrichmentConfigChanged(
  desired: EnrichmentConfig,
  live: EnrichmentConfig,
): boolean {
  return (
    desired.source !== live.source ||
    desired.joinColumn !== live.joinColumn ||
    desired.enrichmentColumns !== live.enrichmentColumns
  );
}

/** Compare a webhook's config against its live state */
export function webhookHasChanges(desired: WebhookConfig, live: LiveWebhookState): boolean {
  return (
    sinkConfigChanged(desired.sink, live.sink.config) ||
    transformConfigChanged(desired.transform, live.transform.config) ||
    enrichmentConfigChanged(desired.enrichment, live.enrichment.config)
  );
}

/** Check if any resource in a pipeline has changed */
export function pipelineHasChanges(desired: PipelineConfig, live: LivePipelineState): boolean {
  return (
    sinkConfigChanged(desired.sink, live.sink.config) ||
    indexConfigChanged(desired.index, live.index.config) ||
    transformConfigChanged(desired.transform, live.transform.config) ||
    enrichmentConfigChanged(desired.enrichment, live.enrichment.config) ||
    desired.webhooks.length !== live.webhooks.length ||
    desired.webhooks.some((wh, i) => i < live.webhooks.length && webhookHasChanges(wh, live.webhooks[i]))
  );
}

/** Does this pipeline need a full backfill? */
export function needsBackfill(desired: PipelineConfig, live: LivePipelineState): boolean {
  return (
    sinkDataChanged(desired.sink, live.sink.config) ||
    transformConfigChanged(desired.transform, live.transform.config) ||
    enrichmentConfigChanged(desired.enrichment, live.enrichment.config)
  );
}

/** Does this pipeline need a reindex? Index schema changed but documents are fine. */
export function needsReindex(desired: PipelineConfig, live: LivePipelineState): boolean {
  return indexConfigChanged(desired.index, live.index.config) && !needsBackfill(desired, live);
}

/** Does this pipeline have only operational changes? No new color needed. */
export function needsInPlaceUpdate(desired: PipelineConfig, live: LivePipelineState): boolean {
  return (
    pipelineHasChanges(desired, live) &&
    !needsBackfill(desired, live) &&
    !needsReindex(desired, live)
  );
}

// ---------------------------------------------------------------------------
// Effect generation for a single pipeline
// ---------------------------------------------------------------------------

/** Effects for creating a brand new colored pipeline */
export function effectsForCreate(
  _pipeline: string,
  desired: PipelineConfig,
  _targetColor: Color,
): PlannedEffect[] {
  const primary: PlannedEffect[] = [
    { effect: { kind: "CreateIndex", index: desired.index }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "CreateTransform", transform: desired.transform }, status: "pending", dependsOn: [], order: 2 },
    { effect: { kind: "CreateEnrichment", enrichment: desired.enrichment }, status: "pending", dependsOn: [], order: 3 },
    { effect: { kind: "CreateSink", sink: desired.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
    { effect: { kind: "TriggerBackfill", sinkId: desired.sink.id }, status: "pending", dependsOn: [4], order: 5 },
  ];
  const webhookEffects: PlannedEffect[] = [];
  for (const wh of desired.webhooks) {
    const base = 5 + webhookEffects.length;
    webhookEffects.push(
      { effect: { kind: "CreateTransform", transform: wh.transform }, status: "pending", dependsOn: [], order: base + 1 },
      { effect: { kind: "CreateEnrichment", enrichment: wh.enrichment }, status: "pending", dependsOn: [], order: base + 2 },
      { effect: { kind: "CreateSink", sink: wh.sink }, status: "pending", dependsOn: [1, base + 1, base + 2], order: base + 3 },
    );
  }
  return [...primary, ...webhookEffects];
}

/** Effects for deleting all resources for a pipeline+color */
export function effectsForDeleteColor(
  _pipeline: string,
  live: LivePipelineState,
  _color: Color,
): PlannedEffect[] {
  const webhookDeletes: PlannedEffect[] = [];
  for (const wh of live.webhooks) {
    const base = webhookDeletes.length;
    webhookDeletes.push(
      { effect: { kind: "DeleteSink", id: wh.sink.config.id }, status: "pending", dependsOn: [], order: base + 1 },
      { effect: { kind: "DeleteTransform", id: wh.transform.config.id }, status: "pending", dependsOn: [base + 1], order: base + 2 },
      { effect: { kind: "DeleteEnrichment", id: wh.enrichment.config.id }, status: "pending", dependsOn: [base + 1], order: base + 3 },
    );
  }
  const pBase = webhookDeletes.length;
  const primaryDeletes: PlannedEffect[] = [
    { effect: { kind: "DeleteSink", id: live.sink.config.id }, status: "pending", dependsOn: [], order: pBase + 1 },
    { effect: { kind: "DeleteTransform", id: live.transform.config.id }, status: "pending", dependsOn: [pBase + 1], order: pBase + 2 },
    { effect: { kind: "DeleteEnrichment", id: live.enrichment.config.id }, status: "pending", dependsOn: [pBase + 1], order: pBase + 3 },
    { effect: { kind: "DeleteIndex", id: live.index.config.id }, status: "pending", dependsOn: [pBase + 1, pBase + 2, pBase + 3], order: pBase + 4 },
  ];
  return [...webhookDeletes, ...primaryDeletes];
}

/** Effects for reindexing — index config changed, documents are correct */
export function effectsForReindex(
  _pipeline: string,
  desired: PipelineConfig,
  sourceIndexId: string,
  _targetColor: Color,
): PlannedEffect[] {
  const primary: PlannedEffect[] = [
    { effect: { kind: "CreateIndex", index: desired.index }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "CreateTransform", transform: desired.transform }, status: "pending", dependsOn: [], order: 2 },
    { effect: { kind: "CreateEnrichment", enrichment: desired.enrichment }, status: "pending", dependsOn: [], order: 3 },
    { effect: { kind: "CreateSink", sink: desired.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
    { effect: { kind: "TriggerReindex", source: sourceIndexId, target: desired.index.id }, status: "pending", dependsOn: [1, 4], order: 5 },
  ];
  const webhookEffects: PlannedEffect[] = [];
  for (const wh of desired.webhooks) {
    const base = 5 + webhookEffects.length;
    webhookEffects.push(
      { effect: { kind: "CreateTransform", transform: wh.transform }, status: "pending", dependsOn: [], order: base + 1 },
      { effect: { kind: "CreateEnrichment", enrichment: wh.enrichment }, status: "pending", dependsOn: [], order: base + 2 },
      { effect: { kind: "CreateSink", sink: wh.sink }, status: "pending", dependsOn: [1, base + 1, base + 2], order: base + 3 },
    );
  }
  return [...primary, ...webhookEffects];
}

/** Effects for in-place update — only operational fields changed */
export function effectsForInPlaceUpdate(
  _pipeline: string,
  desired: PipelineConfig,
  live: LivePipelineState,
): PlannedEffect[] {
  return [
    {
      effect: { kind: "UpdateSink", id: live.sink.config.id, config: desired.sink },
      status: "pending",
      dependsOn: [],
      order: 1,
    },
  ];
}

/** Effects for updating a pipeline — dispatches to backfill, reindex, or in-place */
export function effectsForUpdate(
  pipeline: string,
  desired: PipelineConfig,
  live: LivePipelineState,
  targetColor: Color,
): PlannedEffect[] {
  if (needsBackfill(desired, live)) {
    return effectsForCreate(pipeline, desired, targetColor);
  } else if (needsReindex(desired, live)) {
    return effectsForReindex(pipeline, desired, live.index.config.id, targetColor);
  } else {
    return effectsForInPlaceUpdate(pipeline, desired, live);
  }
}
