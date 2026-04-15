// Terraform/sequin-style plan formatter
// Shows config diffs and planned effects in a human-readable format.

import { createTwoFilesPatch } from "diff";
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
// Diff helpers
// ---------------------------------------------------------------------------

function sortedPretty(obj: unknown): string {
  return JSON.stringify(JSON.parse(sortedStringify(obj)), null, 2);
}

function scalarStr(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Produce a colored unified diff, skipping the header lines */
function unifiedDiff(label: string, oldStr: string, newStr: string, indent: string): string {
  const patch = createTwoFilesPatch("live", "desired", oldStr + "\n", newStr + "\n", "", "", { context: 3 });
  const lines = patch.split("\n");
  // Skip the first 4 header lines (===, ---, +++, @@)
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith("===") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      // Show hunk header dimmed
      result.push(`${indent}${dim(line)}`);
    } else if (line.startsWith("-")) {
      result.push(`${indent}${red(line)}`);
    } else if (line.startsWith("+")) {
      result.push(`${indent}${green(line)}`);
    } else if (line.startsWith("\\")) {
      continue; // "No newline at end of file"
    } else if (line.length > 0) {
      result.push(`${indent} ${line.slice(1)}`);
    }
  }
  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Field comparison — produces a diff section for each resource
// ---------------------------------------------------------------------------

interface ResourceDiff {
  resourceType: string;
  resourceName: string;
  fieldDiffs: { field: string; diffText: string }[];
}

function diffField(field: string, desired: unknown, live: unknown, indent: string): { field: string; diffText: string } | null {
  const dStr = scalarStr(desired);
  const lStr = scalarStr(live);
  if (dStr === lStr) return null;

  // For short scalar values, show inline
  if (!dStr.includes("\n") && !lStr.includes("\n") && dStr.length < 60 && lStr.length < 60) {
    return { field, diffText: `${indent}${yellow("~")} ${bold(field)}: ${red(lStr)} → ${green(dStr)}` };
  }

  // For longer values, use unified diff
  const header = `${indent}${yellow("~")} ${bold(field)}:`;
  const body = unifiedDiff(field, lStr, dStr, indent + "    ");
  return { field, diffText: header + "\n" + body };
}

function diffJsonField(field: string, desired: unknown, live: unknown, indent: string): { field: string; diffText: string } | null {
  if (sortedStringify(desired) === sortedStringify(live)) return null;
  const dStr = sortedPretty(desired);
  const lStr = sortedPretty(live);

  const header = `${indent}${yellow("~")} ${bold(field)}:`;
  const body = unifiedDiff(field, lStr, dStr, indent + "    ");
  return { field, diffText: header + "\n" + body };
}

function diffSinkResource(desired: PipelineConfig, live: LivePipelineState, indent: string): ResourceDiff | null {
  const diffs: { field: string; diffText: string }[] = [];
  const d = (field: string, dv: unknown, lv: unknown) => {
    const r = diffField(field, dv, lv, indent + "    ");
    if (r) diffs.push(r);
  };
  d("sourceTable", desired.sink.sourceTable, live.sink.config.sourceTable);
  d("destination", desired.sink.destination, live.sink.config.destination);
  d("filters", desired.sink.filters, live.sink.config.filters);
  d("batchSize", desired.sink.batchSize, live.sink.config.batchSize);
  d("transformId", desired.sink.transformId, live.sink.config.transformId);

  if (diffs.length === 0) return null;
  return { resourceType: "sink", resourceName: desired.name, fieldDiffs: diffs };
}

function diffIndexResource(desired: PipelineConfig, live: LivePipelineState, indent: string): ResourceDiff | null {
  const diffs: { field: string; diffText: string }[] = [];
  const d = diffJsonField("mappings", desired.index.mappings, live.index.config.mappings, indent + "    ");
  if (d) diffs.push(d);
  const d2 = diffJsonField("settings", desired.index.settings, live.index.config.settings, indent + "    ");
  if (d2) diffs.push(d2);
  if (diffs.length === 0) return null;
  return { resourceType: "index", resourceName: desired.name, fieldDiffs: diffs };
}

function diffTransformResource(desired: PipelineConfig, live: LivePipelineState, indent: string): ResourceDiff | null {
  const diffs: { field: string; diffText: string }[] = [];
  const d = diffField("functionBody", desired.transform.functionBody, live.transform.config.functionBody, indent + "    ");
  if (d) diffs.push(d);
  if (diffs.length === 0) return null;
  return { resourceType: "transform", resourceName: desired.transform.name, fieldDiffs: diffs };
}

function diffEnrichmentResource(desired: PipelineConfig, live: LivePipelineState, indent: string): ResourceDiff | null {
  const diffs: { field: string; diffText: string }[] = [];
  const d = diffField("source", desired.enrichment.source, live.enrichment.config.source, indent + "    ");
  if (d) diffs.push(d);
  if (diffs.length === 0) return null;
  return { resourceType: "enrichment", resourceName: desired.enrichment.name, fieldDiffs: diffs };
}

// ---------------------------------------------------------------------------
// Format effect
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
// Format new resource (for create plans)
// ---------------------------------------------------------------------------

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

  const diffSections: string[] = [];
  const effectSections: string[] = [];

  for (const plan of plans) {
    const diffLines: string[] = [];
    const kind = pipelineChangeKind(plan.pipeline, ctx.desired, ctx.live);
    const desired = ctx.desired.get(plan.pipeline);

    // Find live color for comparison
    const liveColor = ALL_COLORS.find(c => ctx.live.has(pipelineKey(plan.pipeline, c)));
    const live = liveColor ? ctx.live.get(pipelineKey(plan.pipeline, liveColor)) : undefined;

    // Header
    const strategy = strategyLabel(kind as "create" | "update", desired!, live);
    diffLines.push(bold(`Pipeline: ${cyan(plan.pipeline)}`));
    diffLines.push(`  Strategy: ${strategy}`);
    diffLines.push(`  Target color: ${bold(plan.targetColor)}`);
    if (liveColor) {
      diffLines.push(`  Current color: ${bold(liveColor)}`);
    }

    // Config diff section
    if (kind === "create" && desired) {
      diffLines.push("");
      diffLines.push(dim("  Config (new):"));
      diffLines.push(formatNewResource("sink", desired.name, [
        ["sourceTable", desired.sink.sourceTable],
        ["destination", desired.sink.destination],
        ["batchSize", String(desired.sink.batchSize)],
      ], "    "));
      diffLines.push(formatNewResource("index", desired.name, [
        ["mappings", JSON.stringify(desired.index.mappings, null, 2)],
        ["settings", JSON.stringify(desired.index.settings, null, 2)],
      ], "    "));
      diffLines.push(formatNewResource("transform", desired.transform.name, [
        ["functionBody", desired.transform.functionBody],
      ], "    "));
      diffLines.push(formatNewResource("enrichment", desired.enrichment.name, [
        ["source", desired.enrichment.source],
      ], "    "));
      for (const wh of desired.webhooks) {
        diffLines.push(formatNewResource(`webhook sink (${wh.name})`, wh.name, [
          ["sourceTable", wh.sink.sourceTable],
          ["destination", wh.sink.destination],
        ], "    "));
        diffLines.push(formatNewResource(`webhook transform (${wh.name})`, wh.transform.name, [
          ["functionBody", wh.transform.functionBody],
        ], "    "));
        diffLines.push(formatNewResource(`webhook enrichment (${wh.name})`, wh.enrichment.name, [
          ["source", wh.enrichment.source],
        ], "    "));
      }
    } else if (kind === "update" && desired && live) {
      const indent = "    ";
      const resourceDiffs: ResourceDiff[] = [];
      const sd = diffSinkResource(desired, live, indent); if (sd) resourceDiffs.push(sd);
      const id = diffIndexResource(desired, live, indent); if (id) resourceDiffs.push(id);
      const td = diffTransformResource(desired, live, indent); if (td) resourceDiffs.push(td);
      const ed = diffEnrichmentResource(desired, live, indent); if (ed) resourceDiffs.push(ed);

      if (resourceDiffs.length > 0) {
        diffLines.push("");
        diffLines.push(dim("  Changes:"));
        for (const rd of resourceDiffs) {
          diffLines.push(`${indent}${yellow("~")} ${bold(rd.resourceType)} ${cyan(`"${rd.resourceName}"`)}`);
          for (const fd of rd.fieldDiffs) {
            diffLines.push(fd.diffText);
          }
        }
      }
    }

    diffSections.push(diffLines.join("\n"));

    // Collect effects separately
    const effectLines: string[] = [];
    effectLines.push(`  ${bold(cyan(plan.pipeline))} → ${bold(plan.targetColor)}`);
    for (const pe of plan.effects) {
      effectLines.push(`    ${formatEffect(pe.effect, plan.pipeline, plan.targetColor)}`);
    }
    effectSections.push(effectLines.join("\n"));
  }

  // Summary
  const totalEffects = plans.reduce((sum, p) => sum + p.effects.length, 0);
  const creates = plans.filter(p => pipelineChangeKind(p.pipeline, ctx.desired, ctx.live) === "create").length;
  const updates = plans.length - creates;

  const output: string[] = [];

  // All diffs first
  output.push(diffSections.join("\n\n"));

  // Then all effects together
  output.push("");
  output.push(bold("Effects:"));
  output.push(effectSections.join("\n"));

  // Summary
  output.push("");
  output.push(bold("Plan:") + ` ${plans.length} pipeline(s), ${totalEffects} effect(s)`);
  if (creates > 0) output.push(`  ${green("+")} ${creates} to create`);
  if (updates > 0) output.push(`  ${yellow("~")} ${updates} to update`);

  return output.join("\n");
}
