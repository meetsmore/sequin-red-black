import type {
  Color,
  PipelineKey,
  LivePipelineState,
  SinkConfig,
  IndexConfig,
  TransformConfig,
  EnrichmentConfig,
  SinkLifecycle,
} from "../config/types.js";
import { pipelineKey } from "../config/types.js";
import { colorFromString } from "../config/color.js";
import type { SequinCLI } from "../sequin/cli.js";
import type { SequinAPI } from "../sequin/api.js";
import type { SinkInfo } from "../sequin/schemas.js";
import type { OpenSearchClient } from "../opensearch/client.js";

export interface LiveState {
  pipelines: Map<PipelineKey, LivePipelineState>;
  aliases: Map<string, Color>;
}

/** Parse "<pipeline>_<color>" naming convention. Returns null if name doesn't match. */
function parseColoredName(name: string): { pipeline: string; color: Color } | null {
  const lastUnderscore = name.lastIndexOf("_");
  if (lastUnderscore < 0) return null;
  const pipeline = name.slice(0, lastUnderscore);
  const colorStr = name.slice(lastUnderscore + 1);
  const color = colorFromString(colorStr);
  if (!color) return null;
  return { pipeline, color };
}

/**
 * Discover live state from Sequin (CLI export + API) and OpenSearch.
 *
 * 1. Export current Sequin config via CLI to get resource definitions
 * 2. List sinks via API to get runtime state (status, backfill)
 * 3. List indices from OpenSearch for index info
 * 4. Build LivePipelineState for each discovered pipeline+color
 * 5. Resolve aliases for discovered pipeline names
 */
export async function discoverLiveState(
  sequinCli: SequinCLI,
  sequinApi: SequinAPI,
  os: OpenSearchClient,
): Promise<LiveState> {
  // Fetch data in parallel
  const [exportedConfig, sinkInfos, osIndices] = await Promise.all([
    sequinCli.export_(),
    sequinApi.listSinks(),
    os.listIndices(),
  ]);

  const pipelines = new Map<PipelineKey, LivePipelineState>();

  // Build lookup maps
  const sinkInfoByName = new Map<string, SinkInfo>();
  for (const info of sinkInfos) {
    sinkInfoByName.set(info.name, info);
  }

  const osIndexByName = new Map<string, { health: string; docCount: number }>();
  for (const idx of osIndices) {
    osIndexByName.set(idx.name, { health: idx.health, docCount: idx.docCount });
  }

  // Build function lookup from exported config
  const functionsByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(exportedConfig.functions)) {
    for (const fn of exportedConfig.functions) {
      const f = fn as Record<string, unknown>;
      if (typeof f.name === "string") {
        functionsByName.set(f.name, f);
      }
    }
  }

  // Discovered pipeline names (for alias resolution)
  const discoveredPipelines = new Set<string>();

  // Process each sink in exported config
  if (Array.isArray(exportedConfig.sinks)) {
    for (const sinkEntry of exportedConfig.sinks) {
      const s = sinkEntry as Record<string, unknown>;
      const sinkName = s.name as string;
      if (!sinkName) continue;

      const parsed = parseColoredName(sinkName);
      if (!parsed) continue;

      const { pipeline, color } = parsed;
      discoveredPipelines.add(pipeline);

      // Get runtime info from API
      const sinkInfo = sinkInfoByName.get(sinkName);

      // Build SinkConfig from exported YAML
      const dest = s.destination as Record<string, unknown> | undefined;
      const sinkConfig: SinkConfig = {
        id: sinkInfo?.id ?? sinkName,
        name: sinkName,
        sourceTable: (s.table as string) ?? "",
        destination: (dest?.endpoint_url as string) ?? "",
        filters: "",
        batchSize: (s.batch_size as number) ?? 1000,
        transformId: (s.transform as string) ?? "",
        enrichmentIds: s.enrichment ? [s.enrichment as string] : [],
      };

      // Build IndexConfig from OpenSearch data
      const coloredIndexName = dest?.index_name as string | undefined;
      const indexName = coloredIndexName ?? `${pipeline}_${color}`;
      const osIndex = osIndexByName.get(indexName);

      const indexConfig: IndexConfig = {
        id: indexName,
        name: indexName,
        mappings: {},
        settings: {},
        alias: pipeline,
      };

      // Determine index status
      const indexHealth = osIndex?.health ?? "not_found";
      const indexStatus =
        indexHealth === "green" || indexHealth === "yellow" || indexHealth === "red"
          ? indexHealth
          : ("not_found" as const);

      // Build TransformConfig
      const transformName = `${pipeline}_${color}-transform`;
      const transformFn = functionsByName.get(transformName);
      const transformConfig: TransformConfig = {
        id: transformName,
        name: transformName,
        functionBody: (transformFn?.code as string) ?? "",
        inputSchema: "",
        outputSchema: "",
      };

      // Build EnrichmentConfig
      const enrichmentName = `${pipeline}_${color}-enrichment`;
      const enrichmentFn = functionsByName.get(enrichmentName);
      const enrichmentConfig: EnrichmentConfig = {
        id: enrichmentName,
        name: enrichmentName,
        source: (enrichmentFn?.code as string) ?? "",
        joinColumn: "",
        enrichmentColumns: "",
      };

      // Determine sink lifecycle from API data
      const lifecycle: SinkLifecycle = sinkInfo?.status ?? "active";
      const backfilling = sinkInfo?.backfill?.active ?? false;

      const key = pipelineKey(pipeline, color);
      pipelines.set(key, {
        sink: { config: sinkConfig, lifecycle, backfilling },
        index: {
          config: indexConfig,
          status: indexStatus,
          docCount: osIndex?.docCount ?? 0,
        },
        transform: {
          config: transformConfig,
          status: transformFn ? "active" : "inactive",
        },
        enrichment: {
          config: enrichmentConfig,
          status: enrichmentFn ? "active" : "inactive",
        },
      });
    }
  }

  // Resolve aliases for discovered pipelines
  const aliases = new Map<string, Color>();
  const aliasPromises = Array.from(discoveredPipelines).map(async (pipelineName) => {
    const aliasTarget = await os.getAlias(pipelineName);
    if (aliasTarget) {
      // The alias points to an index like "<pipeline>_<color>"
      const parsed = parseColoredName(aliasTarget);
      if (parsed && parsed.pipeline === pipelineName) {
        aliases.set(pipelineName, parsed.color);
      }
    }
  });
  await Promise.all(aliasPromises);

  return { pipelines, aliases };
}
