import { type Color, ALL_COLORS, type PipelineKey, type LivePipelineState } from "./types.js";

export function colorFromString(s: string): Color | null {
  return ALL_COLORS.includes(s as Color) ? (s as Color) : null;
}

export function availableColors(
  pipeline: string,
  live: Map<PipelineKey, LivePipelineState>
): Color[] {
  return ALL_COLORS.filter(c => !live.has(`${pipeline}:${c}` as PipelineKey));
}

/**
 * Stamp a color into a bare resource name to produce the on-disk name we
 * actually create in Sequin / OpenSearch.
 *
 * The convention (mirrors src/executor/executor.ts and src/sequin/yaml-gen.ts):
 *
 *   indexes & sinks:           "<base>"            -> "<base>_<color>"
 *   transforms & enrichments:  "<base>-transform"  -> "<base>_<color>-transform"
 *                              "<base>-enrichment" -> "<base>_<color>-enrichment"
 *
 * For webhooks the same rule applies to the webhook directory name (e.g.
 * "jobs-from-client" -> "jobs-from-client_blue").
 */
export function colorizeName(bareName: string, color: Color): string {
  const m = bareName.match(/^(.+)-(transform|enrichment)$/);
  if (m) return `${m[1]}_${color}-${m[2]}`;
  return `${bareName}_${color}`;
}
