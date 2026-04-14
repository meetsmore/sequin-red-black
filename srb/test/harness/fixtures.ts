import type { PipelineConfig } from "../../src/config/types.js";

/**
 * Color-agnostic pipeline configs for testing.
 * These represent the "desired" state before color is applied.
 * The planner stamps color into names at plan time.
 */
export const jobsConfig: PipelineConfig = {
  name: "jobs",
  sink: {
    id: "jobs",
    name: "jobs",
    sourceTable: "public.Job",
    destination: "http://opensearch:9200",
    filters: "",
    batchSize: 100,
    transformId: "jobs-transform",
    enrichmentIds: ["jobs-enrichment"],
  },
  index: {
    id: "jobs",
    name: "jobs",
    mappings: { properties: { title: { type: "text" }, slug: { type: "keyword" } } },
    settings: { number_of_replicas: "0" },
    alias: "jobs",
  },
  transform: {
    id: "jobs-transform",
    name: "jobs-transform",
    functionBody: `def transform(_action, record, _changes, _metadata) do
  record
end`,
    inputSchema: "{}",
    outputSchema: "{}",
  },
  enrichment: {
    id: "jobs-enrichment",
    name: "jobs-enrichment",
    source: `SELECT id FROM "Job" WHERE id = ANY($$1);`,
    joinColumn: "",
    enrichmentColumns: "",
  },
  webhooks: [],
};

export const clientsConfig: PipelineConfig = {
  name: "clients",
  sink: {
    id: "clients",
    name: "clients",
    sourceTable: "public.Client",
    destination: "http://opensearch:9200",
    filters: "",
    batchSize: 50,
    transformId: "clients-transform",
    enrichmentIds: ["clients-enrichment"],
  },
  index: {
    id: "clients",
    name: "clients",
    mappings: { properties: { name: { type: "text" }, email: { type: "keyword" } } },
    settings: { number_of_replicas: "0" },
    alias: "clients",
  },
  transform: {
    id: "clients-transform",
    name: "clients-transform",
    functionBody: `def transform(_action, record, _changes, _metadata) do
  record
end`,
    inputSchema: "{}",
    outputSchema: "{}",
  },
  enrichment: {
    id: "clients-enrichment",
    name: "clients-enrichment",
    source: `SELECT id FROM "Client" WHERE id = ANY($$1);`,
    joinColumn: "",
    enrichmentColumns: "",
  },
  webhooks: [],
};

/**
 * Write compiled JSON for the given pipeline configs.
 * Format matches what `srb offline compile` produces: flat map of name → config.
 */
export async function writeCompiled(path: string, configs: PipelineConfig[]): Promise<void> {
  const obj: Record<string, PipelineConfig> = {};
  for (const c of configs) {
    obj[c.name] = c;
  }
  await Bun.write(path, JSON.stringify(obj, null, 2));
}
