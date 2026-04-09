import type {
  Color,
  PipelineKey,
  LivePipelineState,
  PipelineConfig,
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
import { type SinkInfo, isBackfilling } from "../sequin/schemas.js";
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
  desired?: Map<string, PipelineConfig>,
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
      // Store color-agnostic values so comparison with desired config works.
      // The desired config has base names (e.g. "jobs-transform"), while live
      // has colored names (e.g. "jobs_red-transform"). We strip the color
      // prefix to make comparison meaningful for content fields.
      const dest = s.destination as Record<string, unknown> | undefined;
      const transformRef = (s.transform as string) ?? "";
      const enrichmentRef = s.enrichment ? (s.enrichment as string) : "";

      // Strip color prefix from function references for comparison
      // "jobs_red-transform" → "jobs-transform"
      const colorPrefix = `${pipeline}_${color}`;
      const baseTransformId = transformRef.startsWith(colorPrefix)
        ? pipeline + transformRef.slice(colorPrefix.length)
        : transformRef;
      const baseEnrichmentId = enrichmentRef.startsWith(colorPrefix)
        ? pipeline + enrichmentRef.slice(colorPrefix.length)
        : enrichmentRef;

      // Extract source table from either `table` or `source.include_tables`
      const source = s.source as Record<string, unknown> | undefined;
      const includeTables = source?.include_tables as string[] | undefined;
      const sourceTable = (s.table as string) ?? (includeTables?.[0] ?? "");

      const sinkConfig: SinkConfig = {
        id: sinkInfo?.id ?? sinkName, // Sequin UUID — needed for API calls
        name: pipeline, // base name for comparison
        sourceTable,
        destination: (dest?.endpoint_url as string) ?? "",
        filters: "",
        batchSize: (s.batch_size as number) ?? 1000,
        transformId: baseTransformId, // base name for comparison
        enrichmentIds: baseEnrichmentId ? [baseEnrichmentId] : [],
      };

      // Build IndexConfig from OpenSearch data
      const coloredIndexName = dest?.index_name as string | undefined;
      const indexName = coloredIndexName ?? `${pipeline}_${color}`;
      const osIndex = osIndexByName.get(indexName);

      // Fetch actual mappings/settings from OpenSearch for accurate comparison
      // Pass desired settings to filter out OS defaults that weren't explicitly set
      const desiredCfg = desired?.get(pipeline);
      const [actualMappings, actualSettings] = await Promise.all([
        os.getIndexMappings(indexName),
        os.getIndexSettings(indexName, desiredCfg?.index.settings),
      ]);

      // Keep colored index name as ID (needed for delete/reindex),
      // but content fields (mappings/settings) are compared directly
      const indexConfig: IndexConfig = {
        id: indexName,    // colored: "jobs_red" — needed for delete
        name: pipeline,   // base: "jobs" — not compared
        mappings: actualMappings,
        settings: actualSettings,
        alias: pipeline,
      };

      // Determine index status
      const indexHealth = osIndex?.health ?? "not_found";
      const indexStatus =
        indexHealth === "green" || indexHealth === "yellow" || indexHealth === "red"
          ? indexHealth
          : ("not_found" as const);

      // Keep colored function names as IDs (needed for delete)
      const transformName = `${pipeline}_${color}-transform`;
      const transformFn = functionsByName.get(transformName);
      const transformConfig: TransformConfig = {
        id: transformName,           // colored: needed for delete
        name: `${pipeline}-transform`, // base: for comparison
        functionBody: ((transformFn?.code as string) ?? "").trim(),
        inputSchema: "{}",
        outputSchema: "{}",
      };

      // Keep colored function names as IDs (needed for delete)
      const enrichmentName = `${pipeline}_${color}-enrichment`;
      const enrichmentFn = functionsByName.get(enrichmentName);
      const enrichmentConfig: EnrichmentConfig = {
        id: enrichmentName,             // colored: needed for delete
        name: `${pipeline}-enrichment`, // base: for comparison
        source: ((enrichmentFn?.code as string) ?? "").trim(),
        joinColumn: "",
        enrichmentColumns: "",
      };

      // Determine sink lifecycle from API data
      const lifecycle: SinkLifecycle = sinkInfo?.status ?? "active";
      const backfilling = sinkInfo ? isBackfilling(sinkInfo) : false;

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
