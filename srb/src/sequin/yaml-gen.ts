import * as yaml from "js-yaml";
import type { Plan, PipelineConfig } from "../config/types.js";
import type { SequinConfigYaml } from "./cli.js";

interface SinkYamlEntry {
  name: string;
  database: string;
  table: string;
  batch_size: number;
  status: string;
  actions: string[];
  timestamp_format: string;
  message_grouping: boolean;
  load_shedding_policy: string;
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
}

interface FunctionYamlEntry {
  name: string;
  type: string;
  code: string;
}

/**
 * Generate a Sequin config YAML string from plans and desired pipeline configs.
 *
 * For each plan that has create/update effects, generates:
 * - A sink entry: `<pipeline>_<color>` with colored index name
 * - A transform function: `<pipeline>_<color>-transform`
 * - An enrichment function: `<pipeline>_<color>-enrichment`
 */
export function generateSequinYaml(
  plans: Plan[],
  desired: Map<string, PipelineConfig>,
  existingConfig?: SequinConfigYaml,
): string {
  const sinks: SinkYamlEntry[] = [];
  const functions: FunctionYamlEntry[] = [];

  // Collect names of sinks/functions we're generating so we can preserve unmanaged ones
  const managedSinkNames = new Set<string>();
  const managedFunctionNames = new Set<string>();

  for (const plan of plans) {
    if (plan.effects.length === 0) continue;

    const cfg = desired.get(plan.pipeline);
    if (!cfg) continue;

    const coloredName = `${plan.pipeline}_${plan.targetColor}`;
    const coloredIndexName = `${cfg.index.name}_${plan.targetColor}`;
    const transformName = `${coloredName}-transform`;
    const enrichmentName = `${coloredName}-enrichment`;

    managedSinkNames.add(coloredName);
    managedFunctionNames.add(transformName);
    managedFunctionNames.add(enrichmentName);

    // Generate sink entry
    sinks.push({
      name: coloredName,
      database: "source-db",
      table: cfg.sink.sourceTable,
      batch_size: cfg.sink.batchSize,
      status: "active",
      actions: ["insert", "update", "delete"],
      timestamp_format: "iso8601",
      message_grouping: true,
      load_shedding_policy: "pause_on_full",
      destination: {
        type: "elasticsearch",
        endpoint_url: cfg.sink.destination,
        index_name: coloredIndexName,
        auth_type: "basic",
        auth_value: "admin:admin",
        batch_size: 100,
      },
      transform: transformName,
      enrichment: enrichmentName,
    });

    // Generate transform function
    functions.push({
      name: transformName,
      type: "transform",
      code: cfg.transform.functionBody,
    });

    // Generate enrichment function
    functions.push({
      name: enrichmentName,
      type: "enrichment",
      code: cfg.enrichment.source,
    });
  }

  // Preserve existing entries not managed by srb
  if (existingConfig) {
    if (Array.isArray(existingConfig.sinks)) {
      for (const sink of existingConfig.sinks) {
        const s = sink as Record<string, unknown>;
        if (typeof s.name === "string" && !managedSinkNames.has(s.name)) {
          sinks.push(s as unknown as SinkYamlEntry);
        }
      }
    }
    if (Array.isArray(existingConfig.functions)) {
      for (const fn of existingConfig.functions) {
        const f = fn as Record<string, unknown>;
        if (typeof f.name === "string" && !managedFunctionNames.has(f.name)) {
          functions.push(f as unknown as FunctionYamlEntry);
        }
      }
    }
  }

  const output: Record<string, unknown> = {};
  if (sinks.length > 0) output.sinks = sinks;
  if (functions.length > 0) output.functions = functions;

  return yaml.dump(output, { lineWidth: -1, noRefs: true });
}
