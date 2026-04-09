// Terraform/sequin-style plan formatter
// Shows config diffs and planned effects in a human-readable format.

import type {
  Color,
  PipelineConfig,
  LivePipelineState,
  Plan,
  Effect,
  PipelineKey,
} from "../config/types.js";
import { ALL_COLORS, pipelineKey } from "../config/types.js";
import {
  sinkDataChanged,
  sinkOperationalChanged,
  indexConfigChanged,
  transformConfigChanged,
  enrichmentConfigChanged,
  needsBackfill,
  needsReindex,
  needsInPlaceUpdate,
  sortedStringify,
} from "./effects.js";
import { pipelineChangeKind } from "./plan.js";

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }

// ---------------------------------------------------------------------------
// Field diff helpers
// ---------------------------------------------------------------------------

interface FieldDiff {
  field: string;
  old: string;
  new_: string;
}

function diffScalar(field: string, desired: unknown, live: unknown): FieldDiff | null {
  const d = typeof desired === "string" ? desired : JSON.stringify(desired);
  const l = typeof live === "string" ? live : JSON.stringify(live);
  if (d === l) return null;
  return { field, old: l, new_: d };
}

function diffJson(field: string, desired: unknown, live: unknown): FieldDiff | null {
  const d = sortedStringify(desired);
  const l = sortedStringify(live);
  if (d === l) return null;
  return { field, old: l, new_: d };
}

function formatFieldDiff(diff: FieldDiff, indent: string): string {
  const lines: string[] = [];
  // For multiline values (code), show inline diff
  if (diff.old.includes("\n") || diff.new_.includes("\n")) {
    lines.push(`${indent}${yellow("~")} ${bold(diff.field)}:`);
    for (const line of diff.old.split("\n")) {
      lines.push(`${indent}    ${red("- " + line)}`);
    }
    for (const line of diff.new_.split("\n")) {
      lines.push(`${indent}    ${green("+ " + line)}`);
    }
  } else {
    lines.push(`${indent}${yellow("~")} ${bold(diff.field)}: ${red(diff.old)} → ${green(diff.new_)}`);
  }
  return lines.join("\n");
}

function formatNewField(field: string, value: string, indent: string): string {
  if (value.includes("\n")) {
    const lines = [`${indent}${green("+")} ${bold(field)}:`];
    for (const line of value.split("\n")) {
      lines.push(`${indent}    ${green("+ " + line)}`);
    }
    return lines.join("\n");
  }
  return `${indent}${green("+")} ${bold(field)}: ${green(value)}`;
}

// ---------------------------------------------------------------------------
// Diff a resource config (desired vs live)
// ---------------------------------------------------------------------------

function diffSink(desired: PipelineConfig["sink"], live: PipelineConfig["sink"]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const d = diffScalar("sourceTable", desired.sourceTable, live.sourceTable); if (d) diffs.push(d);
  const d2 = diffScalar("destination", desired.destination, live.destination); if (d2) diffs.push(d2);
  const d3 = diffScalar("filters", desired.filters, live.filters); if (d3) diffs.push(d3);
  const d4 = diffScalar("batchSize", desired.batchSize, live.batchSize); if (d4) diffs.push(d4);
  const d5 = diffScalar("transformId", desired.transformId, live.transformId); if (d5) diffs.push(d5);
  const d6 = diffJson("enrichmentIds", desired.enrichmentIds, live.enrichmentIds); if (d6) diffs.push(d6);
  return diffs;
}

function diffIndex(desired: PipelineConfig["index"], live: PipelineConfig["index"]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const d = diffJson("mappings", desired.mappings, live.mappings); if (d) diffs.push(d);
  const d2 = diffJson("settings", desired.settings, live.settings); if (d2) diffs.push(d2);
  return diffs;
}

function diffTransform(desired: PipelineConfig["transform"], live: PipelineConfig["transform"]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const d = diffScalar("functionBody", desired.functionBody, live.functionBody); if (d) diffs.push(d);
  const d2 = diffScalar("inputSchema", desired.inputSchema, live.inputSchema); if (d2) diffs.push(d2);
  const d3 = diffScalar("outputSchema", desired.outputSchema, live.outputSchema); if (d3) diffs.push(d3);
  return diffs;
}

function diffEnrichment(desired: PipelineConfig["enrichment"], live: PipelineConfig["enrichment"]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const d = diffScalar("source", desired.source, live.source); if (d) diffs.push(d);
  const d2 = diffScalar("joinColumn", desired.joinColumn, live.joinColumn); if (d2) diffs.push(d2);
  const d3 = diffScalar("enrichmentColumns", desired.enrichmentColumns, live.enrichmentColumns); if (d3) diffs.push(d3);
  return diffs;
}

// ---------------------------------------------------------------------------
// Format a single resource section
// ---------------------------------------------------------------------------

function formatResourceDiff(
  symbol: string, // "+", "~", "-"
  resourceType: string,
  resourceName: string,
  diffs: FieldDiff[],
  indent: string,
): string {
  const lines: string[] = [];
  const colorFn = symbol === "+" ? green : symbol === "-" ? red : yellow;
  lines.push(`${indent}${colorFn(symbol)} ${bold(resourceType)} ${cyan(`"${resourceName}"`)}`);
  for (const diff of diffs) {
    lines.push(formatFieldDiff(diff, indent + "    "));
  }
  return lines.join("\n");
}

function formatNewResource(
  resourceType: string,
  resourceName: string,
  fields: [string, string][],
  indent: string,
): string {
  const lines: string[] = [];
  lines.push(`${indent}${green("+")} ${bold(resourceType)} ${cyan(`"${resourceName}"`)}`);
  for (const [field, value] of fields) {
    lines.push(formatNewField(field, value, indent + "    "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Format an effect
// ---------------------------------------------------------------------------

function formatEffect(effect: Effect, pipeline: string, color: Color): string {
  const colored = `${pipeline}_${color}`;
  switch (effect.kind) {
    case "CreateIndex":
      return `${green("+")} create index ${cyan(`"${colored}"`)}`;
    case "CreateTransform":
      return `${green("+")} create function ${cyan(`"${colored}-transform"`)}`;
    case "CreateEnrichment":
      return `${green("+")} create function ${cyan(`"${colored}-enrichment"`)}`;
    case "CreateSink":
      return `${green("+")} create sink ${cyan(`"${colored}"`)}`;
    case "UpdateSink":
      return `${yellow("~")} update sink ${cyan(`"${colored}"`)}`;
    case "DeleteSink":
      return `${red("-")} delete sink ${cyan(`"${effect.id}"`)}`;
    case "DeleteTransform":
      return `${red("-")} delete function ${cyan(`"${effect.id}"`)}`;
    case "DeleteEnrichment":
      return `${red("-")} delete function ${cyan(`"${effect.id}"`)}`;
    case "DeleteIndex":
      return `${red("-")} delete index ${cyan(`"${effect.id}"`)}`;
    case "TriggerBackfill":
      return `${yellow("~")} trigger backfill on ${cyan(`"${colored}"`)}`;
    case "TriggerReindex":
      return `${yellow("~")} trigger reindex ${cyan(`"${effect.source}"`)} → ${cyan(`"${effect.target}"`)}`;
    case "SwapAlias":
      return `${yellow("~")} swap alias ${cyan(`"${effect.pipeline}"`)} → ${cyan(`"${colored}"`)}`;
  }
}

// ---------------------------------------------------------------------------
// Format a full plan
// ---------------------------------------------------------------------------

export interface FormatPlanContext {
  desired: Map<string, PipelineConfig>;
  live: Map<PipelineKey, LivePipelineState>;
}

function strategyLabel(
  kind: "create" | "update",
  desired: PipelineConfig,
  live?: LivePipelineState,
): string {
  if (kind === "create") return green("new pipeline");
  if (!live) return yellow("update");
  if (needsBackfill(desired, live)) return yellow("backfill") + dim(" (transform/enrichment/data changed)");
  if (needsReindex(desired, live)) return yellow("reindex") + dim(" (index mappings/settings changed)");
  if (needsInPlaceUpdate(desired, live)) return yellow("in-place update") + dim(" (operational fields only)");
  return yellow("update");
}

export function formatPlans(plans: Plan[], ctx: FormatPlanContext): string {
  if (plans.length === 0) {
    return `${green("No changes.")} Infrastructure is up to date.`;
  }

  const sections: string[] = [];

  for (const plan of plans) {
    const lines: string[] = [];
    const kind = pipelineChangeKind(plan.pipeline, ctx.desired, ctx.live);
    const desired = ctx.desired.get(plan.pipeline);

    // Find live color for comparison
    const liveColor = ALL_COLORS.find(c => ctx.live.has(pipelineKey(plan.pipeline, c)));
    const live = liveColor ? ctx.live.get(pipelineKey(plan.pipeline, liveColor)) : undefined;

    // Header
    const strategy = strategyLabel(kind as "create" | "update", desired!, live);
    lines.push(bold(`Pipeline: ${cyan(plan.pipeline)}`));
    lines.push(`  Strategy: ${strategy}`);
    lines.push(`  Target color: ${bold(plan.targetColor)}`);
    if (liveColor) {
      lines.push(`  Current color: ${bold(liveColor)}`);
    }

    // Config diff section
    if (kind === "create" && desired) {
      lines.push("");
      lines.push(dim("  Config (new):"));
      lines.push(formatNewResource("sink", desired.name, [
        ["sourceTable", desired.sink.sourceTable],
        ["destination", desired.sink.destination],
        ["batchSize", String(desired.sink.batchSize)],
      ], "    "));
      lines.push(formatNewResource("index", desired.name, [
        ["mappings", JSON.stringify(desired.index.mappings, null, 2)],
        ["settings", JSON.stringify(desired.index.settings, null, 2)],
      ], "    "));
      lines.push(formatNewResource("transform", desired.transform.name, [
        ["functionBody", desired.transform.functionBody],
      ], "    "));
      lines.push(formatNewResource("enrichment", desired.enrichment.name, [
        ["source", desired.enrichment.source],
      ], "    "));
    } else if (kind === "update" && desired && live) {
      const sinkDiffs = diffSink(desired.sink, live.sink.config);
      const indexDiffs = diffIndex(desired.index, live.index.config);
      const transformDiffs = diffTransform(desired.transform, live.transform.config);
      const enrichmentDiffs = diffEnrichment(desired.enrichment, live.enrichment.config);

      const hasDiffs = sinkDiffs.length + indexDiffs.length + transformDiffs.length + enrichmentDiffs.length > 0;
      if (hasDiffs) {
        lines.push("");
        lines.push(dim("  Changes:"));
        if (sinkDiffs.length > 0) {
          lines.push(formatResourceDiff("~", "sink", desired.name, sinkDiffs, "    "));
        }
        if (indexDiffs.length > 0) {
          lines.push(formatResourceDiff("~", "index", desired.name, indexDiffs, "    "));
        }
        if (transformDiffs.length > 0) {
          lines.push(formatResourceDiff("~", "transform", desired.transform.name, transformDiffs, "    "));
        }
        if (enrichmentDiffs.length > 0) {
          lines.push(formatResourceDiff("~", "enrichment", desired.enrichment.name, enrichmentDiffs, "    "));
        }
      }
    }

    // Effects section
    lines.push("");
    lines.push(dim("  Effects:"));
    for (const pe of plan.effects) {
      lines.push(`    ${formatEffect(pe.effect, plan.pipeline, plan.targetColor)}`);
    }

    sections.push(lines.join("\n"));
  }

  // Summary
  const totalEffects = plans.reduce((sum, p) => sum + p.effects.length, 0);
  const creates = plans.filter(p => pipelineChangeKind(p.pipeline, ctx.desired, ctx.live) === "create").length;
  const updates = plans.length - creates;

  const summary: string[] = [];
  summary.push("");
  summary.push(bold("Plan:") + ` ${plans.length} pipeline(s), ${totalEffects} effect(s)`);
  if (creates > 0) summary.push(`  ${green("+")} ${creates} to create`);
  if (updates > 0) summary.push(`  ${yellow("~")} ${updates} to update`);

  return sections.join("\n\n") + "\n" + summary.join("\n");
}
