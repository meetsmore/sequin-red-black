import { TestOpenSearchClient } from "./opensearch-api.js";
import { TestSequinClient } from "./sequin-api.js";
import {
  TEST_SEQUIN_URL,
  TEST_SEQUIN_TOKEN,
  TEST_OS_URL,
  SEQUIN_CONTEXT,
} from "./constants.js";
import type { PipelineConfig } from "../../src/config/types.js";

export const testOS = new TestOpenSearchClient(TEST_OS_URL);
export const testSequin = new TestSequinClient(TEST_SEQUIN_URL, TEST_SEQUIN_TOKEN);

/**
 * Wipe all state: delete all Sequin sinks via API + delete all OS test indices.
 */
export async function resetAll(): Promise<void> {
  await testSequin.deleteAllSinks();
  await testOS.deleteAllTestIndices();
}

/**
 * Deploy a fully provisioned colored pipeline:
 * 1. Create colored OpenSearch index with mappings
 * 2. Generate colored Sequin YAML (sink + transform + enrichment)
 * 3. sequin config apply --auto-approve --context=srb-test
 */
export async function deployPipeline(
  pipeline: string,
  color: string,
  config: PipelineConfig,
): Promise<void> {
  const coloredName = `${pipeline}_${color}`;

  // 1. Create colored OS index
  await testOS.createIndex(coloredName, {
    mappings: config.index.mappings,
    settings: config.index.settings,
  });

  // 2. Generate and apply Sequin config
  const yamlContent = generateDeployYaml(pipeline, color, config);
  const tmpPath = `/tmp/srb-test-deploy-${pipeline}-${color}.yml`;
  await Bun.write(tmpPath, yamlContent);

  const proc = Bun.spawn(
    ["sequin", "config", "apply", "--auto-approve", `--context=${SEQUIN_CONTEXT}`, tmpPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`sequin config apply failed for ${coloredName}: ${stderr}`);
  }
}

/**
 * Generate Sequin YAML for a colored pipeline deployment.
 */
function generateDeployYaml(pipeline: string, color: string, config: PipelineConfig): string {
  const coloredSink = `${pipeline}_${color}`;
  const coloredTransform = `${pipeline}_${color}-transform`;
  const coloredEnrichment = `${pipeline}_${color}-enrichment`;

  return `sinks:
  - name: ${coloredSink}
    database: source-db
    table: ${config.sink.sourceTable}
    batch_size: ${config.sink.batchSize}
    status: active
    actions:
      - insert
      - update
      - delete
    destination:
      type: elasticsearch
      endpoint_url: http://opensearch:9200
      index_name: ${coloredSink}
      auth_type: basic
      auth_value: admin:admin
    transform: ${coloredTransform}
    enrichment: ${coloredEnrichment}
functions:
  - name: ${coloredTransform}
    type: transform
    code: |
      ${config.transform.functionBody.split("\n").join("\n      ")}
  - name: ${coloredEnrichment}
    type: enrichment
    code: |
      ${config.enrichment.source.split("\n").join("\n      ")}
`;
}

/**
 * Set OS alias: pipeline -> pipeline_color
 */
export async function setAlias(pipeline: string, color: string): Promise<void> {
  await testOS.setAlias(pipeline, `${pipeline}_${color}`);
}

/**
 * Find the sink named pipeline_color, trigger backfill via Sequin API.
 */
export async function triggerBackfill(pipeline: string, color: string): Promise<void> {
  const sink = await testSequin.getSinkByName(`${pipeline}_${color}`);
  if (!sink) throw new Error(`Sink ${pipeline}_${color} not found`);
  await testSequin.triggerBackfill(sink.id);
}
