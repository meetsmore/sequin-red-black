import * as path from "path";
import * as yaml from "js-yaml";
import { readdir } from "fs/promises";
import type { PipelineConfig, WebhookConfig } from "./types.js";

interface RawSinkYaml {
  name: string;
  database: string;
  table: string;
  batch_size: number;
  status: string;
  actions: string[];
  destination: {
    type: string;
    endpoint_url: string;
    index_name: string;
    auth_type: string;
    auth_value: string;
    batch_size: number;
  };
  transform: string;
  enrichment: string;
  // other fields passed through
  [key: string]: unknown;
}

async function loadWebhooks(pipelineDir: string): Promise<WebhookConfig[]> {
  const webhooksDir = path.join(pipelineDir, "webhooks");
  try {
    const entries = await readdir(webhooksDir, { withFileTypes: true });
    const webhookDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith("_"));
    const webhooks = await Promise.all(webhookDirs.map(e => loadWebhook(e.name, webhooksDir)));
    return webhooks;
  } catch {
    // No webhooks/ directory — pipeline has no webhooks
    return [];
  }
}

async function loadWebhook(name: string, webhooksDir: string): Promise<WebhookConfig> {
  const dir = path.join(webhooksDir, name);

  const sinkYaml = yaml.load(await Bun.file(path.join(dir, "sink.yaml")).text()) as RawSinkYaml;
  const transformName = `${name}-transform`;
  const enrichmentName = `${name}-enrichment`;
  const transformBody = await Bun.file(path.join(dir, "transform.ex")).text();
  const enrichmentSql = await Bun.file(path.join(dir, "enrichment.sql")).text();

  // Read webhook-specific destination fields
  const dest = sinkYaml.destination as Record<string, unknown> | undefined;
  const httpEndpoint = (dest?.http_endpoint as string) ?? "";
  const httpEndpointPath = (dest?.http_endpoint_path as string) ?? "";

  return {
    name,
    sink: {
      id: name,
      name: sinkYaml.name,
      sourceTable: sinkYaml.table ?? "",
      destination: httpEndpointPath,
      filters: "",
      batchSize: sinkYaml.batch_size ?? 1,
      transformId: transformName,
      enrichmentIds: [enrichmentName],
    },
    transform: {
      id: transformName,
      name: transformName,
      functionBody: transformBody.trim(),
      inputSchema: "{}",
      outputSchema: "{}",
    },
    enrichment: {
      id: enrichmentName,
      name: enrichmentName,
      source: enrichmentSql.trim(),
      joinColumn: "",
      enrichmentColumns: "",
    },
    httpEndpoint,
    httpEndpointPath,
  };
}

export async function loadPipeline(name: string, indexesDir: string): Promise<PipelineConfig> {
  const dir = path.join(indexesDir, name);

  // 1. Import index.ts
  const indexModule = await import(path.resolve(dir, "index.ts"));
  const indexExport = indexModule.default as { mappings: Record<string, unknown>; settings: Record<string, unknown> };

  // 2. Read sink.yaml
  const sinkYaml = yaml.load(await Bun.file(path.join(dir, "sink.yaml")).text()) as RawSinkYaml;

  // 3. Read transform code file (convention: <pipeline>-transform)
  const transformName = `${name}-transform`;
  const transformBody = await Bun.file(path.join(dir, "transform.ex")).text();

  // 4. Read enrichment code file (convention: <pipeline>-enrichment)
  const enrichmentName = `${name}-enrichment`;
  const enrichmentSql = await Bun.file(path.join(dir, "enrichment.sql")).text();

  return {
    name,
    sink: {
      id: name,
      name: sinkYaml.name,
      sourceTable: sinkYaml.table,
      destination: sinkYaml.destination.endpoint_url,
      filters: "",
      batchSize: sinkYaml.batch_size,
      transformId: transformName,
      enrichmentIds: [enrichmentName],
    },
    index: {
      id: name,
      name,
      mappings: indexExport.mappings,
      settings: indexExport.settings,
      alias: name,
    },
    transform: {
      id: transformName,
      name: transformName,
      functionBody: transformBody.trim(),
      inputSchema: "{}",
      outputSchema: "{}",
    },
    enrichment: {
      id: enrichmentName,
      name: enrichmentName,
      source: enrichmentSql.trim(),
      joinColumn: "",
      enrichmentColumns: "",
    },
    webhooks: await loadWebhooks(dir),
  };
}

export async function loadAll(indexesDir: string): Promise<Map<string, PipelineConfig>> {
  const entries = await readdir(indexesDir, { withFileTypes: true });
  const pipelines = entries.filter(e => e.isDirectory() && !e.name.startsWith("_") && e.name !== "opensearch");
  const results = await Promise.all(pipelines.map(e => loadPipeline(e.name, indexesDir)));
  return new Map(results.map(p => [p.name, p]));
}
