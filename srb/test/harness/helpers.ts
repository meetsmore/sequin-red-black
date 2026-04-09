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
 * Wipe all state: apply minimal Sequin config (no sinks/functions) + delete all OS test indices.
 */
export async function resetAll(): Promise<void> {
  // 1. Apply empty Sequin config (removes all sinks/functions)
  // Write a minimal YAML with just the account/DB info, apply it
  const minimalYaml = `
account:
  name: "SRB Example"

users:
  - account: "SRB Example"
    email: "admin@example.com"
    password: "sequinpassword!"

api_tokens:
  - name: "dev-token"
    token: "srb-dev-token-secret"

databases:
  - name: "source-db"
    username: "postgres"
    password: "postgres"
    hostname: "postgres"
    database: "source"
    port: 5432
    slot_name: "sequin_slot"
    publication_name: "sequin_pub"
`;
  const tmpPath = "/tmp/srb-test-reset-config.yml";
  await Bun.write(tmpPath, minimalYaml);

  const proc = Bun.spawn(
    ["sequin", "config", "apply", "--auto-approve", `--context=${SEQUIN_CONTEXT}`, `--config=${tmpPath}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;

  // 2. Delete all test OpenSearch indices
  await testOS.deleteAllTestIndices();
}

/**
 * Deploy a fully provisioned colored pipeline:
 * 1. Generate colored Sequin YAML (sink + transform + enrichment)
 * 2. sequin config apply --auto-approve --context=srb-test
 * 3. Create colored OpenSearch index with mappings
 */
export async function deployPipeline(
  pipeline: string,
  color: string,
  config: PipelineConfig,
): Promise<void> {
  // Create colored OS index
  await testOS.createIndex(`${pipeline}_${color}`, {
    mappings: config.index.mappings,
    settings: config.index.settings,
  });

  // Generate and apply Sequin config for the sink
  // In a real deployment this would generate full YAML; for tests we use the API directly
  // For now, create the index only. Sink creation happens via srb apply in tests.
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
