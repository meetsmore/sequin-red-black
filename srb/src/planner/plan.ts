// Direct translation of docs/spec/quint/plan.qnt
// All functions are pure — no I/O.

import {
  type Color,
  type PipelineConfig,
  type LivePipelineState,
  type Plan,
  type PipelineKey,
  ALL_COLORS,
  pipelineKey,
  parseKey,
} from "../config/types.js";
import { effectsForCreate, effectsForInPlaceFullUpdate, effectsForUpdate, pipelineHasChanges } from "./effects.js";

export type ChangeKind = "create" | "update" | "delete" | "no_change";

// ---------------------------------------------------------------------------
// Plan generation across all pipelines
// ---------------------------------------------------------------------------

/** Determine what kind of change a pipeline has */
export function pipelineChangeKind(
  pipeline: string,
  desired: Map<string, PipelineConfig>,
  live: Map<PipelineKey, LivePipelineState>,
): ChangeKind {
  const hasDesired = desired.has(pipeline);
  const hasLive = ALL_COLORS.some((c) => live.has(pipelineKey(pipeline, c)));
  if (hasDesired && !hasLive) return "create";
  if (!hasDesired && hasLive) return "delete";
  if (hasDesired && hasLive) return "update";
  return "no_change";
}

/** Pick an available color for a pipeline — tries preferred color first, then first available from `allowedColors` */
export function pickTargetColor(
  pipeline: string,
  live: Map<PipelineKey, LivePipelineState>,
  occupiedColors?: Map<string, Set<Color>>,
  preferredColor?: Color,
  allowedColors: Color[] = ALL_COLORS,
): Color {
  const occupied = occupiedColors?.get(pipeline);
  const isAvailable = (c: Color) =>
    !live.has(pipelineKey(pipeline, c)) && !occupied?.has(c);

  if (preferredColor && allowedColors.includes(preferredColor) && isAvailable(preferredColor)) {
    return preferredColor;
  }
  for (const c of allowedColors) {
    if (isAvailable(c)) {
      return c;
    }
  }
  // Fallback: first allowed color (should not happen unless every allowed color is already occupied)
  return allowedColors[0] ?? "red";
}

export interface GeneratePlansOptions {
  /**
   * Update the currently-active color in place instead of provisioning a
   * fresh color and performing a red-black swap. Only affects `update`
   * plans; `create` and `delete` are unchanged. Index mapping/settings
   * changes are skipped (warn and keep going) — callers who need those
   * should use red-black.
   */
  inPlace?: boolean;
}

/** Generate plans for all pipelines that have changes */
export function generatePlans(
  desired: Map<string, PipelineConfig>,
  live: Map<PipelineKey, LivePipelineState>,
  allowedColors: Color[] = ALL_COLORS,
  aliases?: Map<string, Color>,
  occupiedColors?: Map<string, Set<Color>>,
  options: GeneratePlansOptions = {},
): Plan[] {
  // Get all pipeline names from desired + live
  const pipelineNames = new Set<string>();
  for (const name of desired.keys()) {
    pipelineNames.add(name);
  }
  for (const key of live.keys()) {
    const [name] = parseKey(key);
    pipelineNames.add(name);
  }

  const plans: Plan[] = [];
  let preferredColor: Color | undefined;

  for (const pipeline of pipelineNames) {
    const kind = pipelineChangeKind(pipeline, desired, live);

    // In-place update mode: target whichever color this pipeline already has.
    // Prefer the alias (true active color). If the alias is missing
    // (e.g. never activated, or was dropped manually) but a live sink+index
    // exist at some color, use that — the intent of in-place is "don't make
    // a new copy", so use what's there. Only non-update kinds (create)
    // fall back to the normal color picker.
    const inPlaceColor: Color | undefined = (() => {
      if (!options.inPlace || kind !== "update") return undefined;
      const aliased = aliases?.get(pipeline);
      if (aliased && live.has(pipelineKey(pipeline, aliased))) return aliased;
      return ALL_COLORS.find((c) => live.has(pipelineKey(pipeline, c)));
    })();
    const targetColor =
      inPlaceColor ??
      pickTargetColor(pipeline, live, occupiedColors, preferredColor, allowedColors);
    if (!preferredColor) preferredColor = targetColor;

    let effects: Plan["effects"] = [];

    if (kind === "create") {
      effects = effectsForCreate(pipeline, desired.get(pipeline)!, targetColor);
    } else if (kind === "update") {
      // Compare against the active color (alias target) if available,
      // otherwise fall back to first live color found
      const activeColor = aliases?.get(pipeline);
      const liveColor = activeColor && live.has(pipelineKey(pipeline, activeColor))
        ? activeColor
        : ALL_COLORS.find((c) => live.has(pipelineKey(pipeline, c)));
      if (liveColor !== undefined) {
        const liveState = live.get(pipelineKey(pipeline, liveColor))!;
        const cfg = desired.get(pipeline)!;
        if (pipelineHasChanges(cfg, liveState)) {
          effects = options.inPlace && inPlaceColor
            ? effectsForInPlaceFullUpdate(pipeline, cfg, liveState)
            : effectsForUpdate(pipeline, cfg, liveState, targetColor);
        }
      }
    }
    // delete and no_change produce no effects

    if (effects.length > 0) {
      plans.push({
        pipeline,
        targetColor,
        effects,
        inPlace: options.inPlace && kind === "update" && inPlaceColor !== undefined,
      });
    }
  }

  return plans;
}
