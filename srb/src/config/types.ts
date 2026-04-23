export type Color = "red" | "black" | "blue" | "green" | "purple" | "orange" | "yellow";
export const ALL_COLORS: Color[] = ["red", "black", "blue", "green", "purple", "orange", "yellow"];

export interface SinkConfig {
  id: string;
  name: string;
  /** @example "meetsone-db" */
  database: string;
  sourceTable: string;
  /** Full destination config from sink.yaml (type, endpoint_url, auth_type, etc.) */
  destination: Record<string, unknown>;
  filters: string;
  batchSize: number;
  transformId: string;
  enrichmentIds: string[];
}

export interface IndexConfig {
  id: string;
  name: string;
  mappings: Record<string, unknown>;
  settings: Record<string, unknown>;
  alias: string;
}

export interface TransformConfig {
  id: string;
  name: string;
  functionBody: string;
  inputSchema: string;
  outputSchema: string;
}

export interface EnrichmentConfig {
  id: string;
  name: string;
  source: string;
  joinColumn: string;
  enrichmentColumns: string;
}

export interface PipelineConfig {
  name: string;
  sink: SinkConfig;
  index: IndexConfig;
  transform: TransformConfig;
  enrichment: EnrichmentConfig;
  webhooks: WebhookConfig[];
}

/** Top-level compiled config. Emitted by `srb offline compile`, consumed by online commands. */
export interface CompiledConfig {
  /** Colors the orchestrator is allowed to deploy to. Loaded from indexes/_srb.yaml (falls back to ALL_COLORS). */
  colors: Color[];
  pipelines: Map<string, PipelineConfig>;
}

export interface WebhookConfig {
  name: string;
  sink: SinkConfig;
  transform: TransformConfig;
  enrichment: EnrichmentConfig;
  /** Sequin HTTP endpoint name (e.g. "opensearch-update-by-query") */
  httpEndpoint: string;
  /** Path template with base index name (e.g. "/jobs/_update_by_query?conflicts=proceed") — color gets stamped in at deploy time */
  httpEndpointPath: string;
}

// Live state
export type SinkLifecycle = "active" | "paused" | "disabled";
export type IndexStatus = "green" | "yellow" | "red" | "reindexing" | "not_found";

export interface SinkState { config: SinkConfig; lifecycle: SinkLifecycle; backfilling: boolean; }
export interface IndexState { config: IndexConfig; status: IndexStatus; docCount: number; }
export interface TransformState { config: TransformConfig; status: "active" | "inactive"; }
export interface EnrichmentState { config: EnrichmentConfig; status: "active" | "inactive"; }

export interface LivePipelineState {
  sink: SinkState;
  index: IndexState;
  transform: TransformState;
  enrichment: EnrichmentState;
  webhooks: LiveWebhookState[];
}

export interface LiveWebhookState {
  sink: SinkState;
  transform: TransformState;
  enrichment: EnrichmentState;
}

// Keyed by pipeline name + color
export type PipelineKey = `${string}:${Color}`;
export function pipelineKey(pipeline: string, color: Color): PipelineKey { return `${pipeline}:${color}`; }
export function parseKey(key: PipelineKey): [string, Color] {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1) as Color];
}

// Effects
export type Effect =
  | { kind: "CreateSink"; sink: SinkConfig }
  | { kind: "CreateIndex"; index: IndexConfig }
  | { kind: "CreateTransform"; transform: TransformConfig }
  | { kind: "CreateEnrichment"; enrichment: EnrichmentConfig }
  | { kind: "UpdateSink"; id: string; config: SinkConfig }
  | { kind: "DeleteSink"; id: string }
  | { kind: "DeleteIndex"; id: string }
  | { kind: "DeleteTransform"; id: string }
  | { kind: "DeleteEnrichment"; id: string }
  | { kind: "TriggerBackfill"; sinkId: string }
  | { kind: "TriggerReindex"; source: string; target: string }
  | { kind: "SwapAlias"; pipeline: string; color: Color };

export type EffectStatus = "pending" | "in_progress" | "completed" | { failed: string };

export interface PlannedEffect {
  effect: Effect;
  status: EffectStatus;
  dependsOn: number[];
  order: number;
}

export interface Plan {
  pipeline: string;
  targetColor: Color;
  effects: PlannedEffect[];
}
