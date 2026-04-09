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
