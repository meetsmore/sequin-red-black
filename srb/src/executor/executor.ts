import { tmpdir } from "os";
import * as path from "path";
import * as fs from "fs/promises";
import type { Plan, PipelineConfig, Color, Effect, PlannedEffect } from "../config/types.js";
import type { SequinCLI } from "../sequin/cli.js";
import type { SequinAPI } from "../sequin/api.js";
import type { OpenSearchClient } from "../opensearch/client.js";
import { generateSequinYaml } from "../sequin/yaml-gen.js";

export interface ExecutorOptions {
  sequinCli: SequinCLI;
  sequinApi: SequinAPI;
  openSearch: OpenSearchClient;
  skipBackfill: boolean;
  dryRun: boolean;
}

// Stamp color into resource names
export function coloredIndexName(pipeline: string, color: Color): string {
  return `${pipeline}_${color}`;
}
export function coloredSinkName(pipeline: string, color: Color): string {
  return `${pipeline}_${color}`;
}
export function coloredTransformName(pipeline: string, color: Color): string {
  return `${pipeline}_${color}-transform`;
}
export function coloredEnrichmentName(pipeline: string, color: Color): string {
  return `${pipeline}_${color}-enrichment`;
}


function log(msg: string): void {
  console.log(`[executor] ${msg}`);
}

async function executeOpenSearchEffect(
  effect: Effect,
  os: OpenSearchClient,
  plan: Plan,
  dryRun: boolean,
): Promise<void> {
  switch (effect.kind) {
    case "CreateIndex": {
      const name = coloredIndexName(plan.pipeline, plan.targetColor);
      if (dryRun) { log(`[dry-run] Would create index: ${name}`); return; }
      log(`Creating index: ${name}`);
      await os.createIndex(name, { mappings: effect.index.mappings, settings: effect.index.settings });
      break;
    }
    case "DeleteIndex": {
      if (dryRun) { log(`[dry-run] Would delete index: ${effect.id}`); return; }
      log(`Deleting index: ${effect.id}`);
      await os.deleteIndex(effect.id);
      break;
    }
    case "SwapAlias": {
      const indexName = coloredIndexName(effect.pipeline, effect.color);
      if (dryRun) { log(`[dry-run] Would swap alias for ${effect.pipeline} -> ${indexName}`); return; }
      log(`Swapping alias for ${effect.pipeline} -> ${indexName}`);
      const currentTarget = await os.getAlias(effect.pipeline);
      await os.swapAlias(effect.pipeline, currentTarget, indexName);
      break;
    }
    case "TriggerReindex": {
      if (dryRun) { log(`[dry-run] Would reindex ${effect.source} -> ${effect.target}`); return; }
      log(`Triggering reindex: ${effect.source} -> ${effect.target}`);
      await os.triggerReindex(effect.source, effect.target);
      break;
    }
    default:
      throw new Error(`Not an OpenSearch effect: ${(effect as Effect).kind}`);
  }
}

async function executeSequinApplyBatch(
  plansWithDeclarative: Plan[],
  effectCount: number,
  desired: Map<string, PipelineConfig>,
  opts: ExecutorOptions,
): Promise<void> {
  if (opts.dryRun) {
    log(`[dry-run] Would apply consolidated Sequin config for ${plansWithDeclarative.length} pipeline(s) (${effectCount} effects)`);
    return;
  }
  const yaml = generateSequinYaml(plansWithDeclarative, desired);
  const tmpFile = path.join(tmpdir(), `srb-sequin-${Date.now()}.yaml`);
  await fs.writeFile(tmpFile, yaml, "utf-8");
  log(`Applying consolidated Sequin config for ${plansWithDeclarative.length} pipeline(s) (${effectCount} effects): ${tmpFile}`);
  try {
    await opts.sequinCli.apply(tmpFile);
  } catch (err) {
    log(`Sequin config YAML that failed:\n${yaml}`);
    throw err;
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function executeSequinDelete(
  effect: Effect,
  plan: Plan,
  opts: ExecutorOptions,
): Promise<void> {
  if (effect.kind === "DeleteSink") {
    if (opts.dryRun) { log(`[dry-run] Would delete sink: ${effect.id}`); return; }
    log(`Deleting sink: ${coloredSinkName(plan.pipeline, plan.targetColor)} (${effect.id})`);
    await opts.sequinApi.deleteSink(effect.id);
  } else if (effect.kind === "DeleteTransform" || effect.kind === "DeleteEnrichment") {
    if (opts.dryRun) { log(`[dry-run] Would delete function: ${effect.id}`); return; }
    log(`Function ${effect.id} will be cleaned up by Sequin`);
  }
}

async function executeImperativeEffect(
  effect: Effect,
  plan: Plan,
  opts: ExecutorOptions,
): Promise<void> {
  if (effect.kind !== "TriggerBackfill") {
    throw new Error(`Not an imperative effect: ${effect.kind}`);
  }
  if (opts.skipBackfill) { log(`Skipping backfill for sink: ${effect.sinkId} (--skip-backfill)`); return; }
  if (opts.dryRun) { log(`[dry-run] Would trigger backfill for sink: ${effect.sinkId}`); return; }

  // Look up the actual sink UUID by colored name — the Sequin API needs the UUID
  const coloredName = coloredSinkName(plan.pipeline, plan.targetColor);
  const sinks = await opts.sequinApi.listSinks();
  const sink = sinks.find(s => s.name === coloredName);
  if (!sink) {
    throw new Error(`Cannot trigger backfill: sink "${coloredName}" not found in Sequin`);
  }
  log(`Triggering backfill for sink: ${coloredName} (${sink.id})`);
  await opts.sequinApi.triggerBackfill(sink.id);
}

type PhaseKind = "os_create" | "sequin_declarative" | "backfill" | "sequin_delete" | "os_mod";

function phaseFor(effect: Effect): PhaseKind {
  switch (effect.kind) {
    case "CreateIndex": return "os_create";
    case "CreateSink":
    case "CreateTransform":
    case "CreateEnrichment":
    case "UpdateSink": return "sequin_declarative";
    case "TriggerBackfill": return "backfill";
    case "DeleteSink":
    case "DeleteTransform":
    case "DeleteEnrichment": return "sequin_delete";
    case "SwapAlias":
    case "DeleteIndex":
    case "TriggerReindex": return "os_mod";
  }
}

export async function execute(
  plans: Plan[],
  desired: Map<string, PipelineConfig>,
  opts: ExecutorOptions,
): Promise<void> {
  for (const plan of plans) {
    if (plan.effects.length === 0) {
      log(`Pipeline ${plan.pipeline} (${plan.targetColor}): no changes`);
    } else {
      log(`Pipeline ${plan.pipeline} (${plan.targetColor}): ${plan.effects.length} effects`);
    }
  }

  // Collect effects by phase, preserving insertion order (plan-by-plan, effect-by-effect)
  type Item = { plan: Plan; pe: PlannedEffect };
  const byPhase: Record<PhaseKind, Item[]> = {
    os_create: [],
    sequin_declarative: [],
    backfill: [],
    sequin_delete: [],
    os_mod: [],
  };
  for (const plan of plans) {
    const sorted = [...plan.effects].sort((a, b) => a.order - b.order);
    for (const pe of sorted) byPhase[phaseFor(pe.effect)].push({ plan, pe });
  }

  // Phase 1: OS index creates (must exist before sinks reference them)
  for (const { pe, plan } of byPhase.os_create) {
    await executeOpenSearchEffect(pe.effect, opts.openSearch, plan, opts.dryRun);
  }

  // Phase 2: one consolidated sequin config apply
  if (byPhase.sequin_declarative.length > 0) {
    const plansWithDeclarative = plans.filter(p =>
      p.effects.some(e => phaseFor(e.effect) === "sequin_declarative"),
    );
    await executeSequinApplyBatch(
      plansWithDeclarative,
      byPhase.sequin_declarative.length,
      desired,
      opts,
    );
  }

  // Phase 3: imperative backfills
  for (const { pe, plan } of byPhase.backfill) {
    await executeImperativeEffect(pe.effect, plan, opts);
  }

  // Phase 4: imperative sequin deletes (by UUID)
  for (const { pe, plan } of byPhase.sequin_delete) {
    await executeSequinDelete(pe.effect, plan, opts);
  }

  // Phase 5: OS alias swaps / index deletes / reindex
  for (const { pe, plan } of byPhase.os_mod) {
    await executeOpenSearchEffect(pe.effect, opts.openSearch, plan, opts.dryRun);
  }
}
