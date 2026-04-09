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

// Classify effects by execution target
type EffectCategory = "opensearch" | "sequin_declarative" | "imperative";

function categorize(effect: Effect): EffectCategory {
  switch (effect.kind) {
    case "CreateIndex":
    case "DeleteIndex":
    case "SwapAlias":
    case "TriggerReindex":
      return "opensearch";
    case "CreateSink":
    case "CreateTransform":
    case "CreateEnrichment":
    case "UpdateSink":
    case "DeleteSink":
    case "DeleteTransform":
    case "DeleteEnrichment":
      return "sequin_declarative";
    case "TriggerBackfill":
      return "imperative";
  }
}

// Group consecutive sequin declarative effects into batches
interface EffectBatch {
  category: EffectCategory;
  effects: PlannedEffect[];
}

function batchEffects(effects: PlannedEffect[]): EffectBatch[] {
  const sorted = [...effects].sort((a, b) => a.order - b.order);
  const batches: EffectBatch[] = [];

  for (const pe of sorted) {
    const cat = categorize(pe.effect);
    const last = batches[batches.length - 1];
    if (last && last.category === cat && cat === "sequin_declarative") {
      // Merge consecutive sequin declarative effects
      last.effects.push(pe);
    } else {
      batches.push({ category: cat, effects: [pe] });
    }
  }

  return batches;
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
      // Stamp color into index name: "jobs" → "jobs_red"
      const name = coloredIndexName(plan.pipeline, plan.targetColor);
      if (dryRun) {
        log(`[dry-run] Would create index: ${name}`);
        return;
      }
      log(`Creating index: ${name}`);
      await os.createIndex(name, {
        mappings: effect.index.mappings,
        settings: effect.index.settings,
      });
      break;
    }
    case "DeleteIndex": {
      if (dryRun) {
        log(`[dry-run] Would delete index: ${effect.id}`);
        return;
      }
      log(`Deleting index: ${effect.id}`);
      await os.deleteIndex(effect.id);
      break;
    }
    case "SwapAlias": {
      const indexName = coloredIndexName(effect.pipeline, effect.color);
      if (dryRun) {
        log(`[dry-run] Would swap alias for ${effect.pipeline} -> ${indexName}`);
        return;
      }
      log(`Swapping alias for ${effect.pipeline} -> ${indexName}`);
      // Look up current alias target so we can remove the old binding
      const currentTarget = await os.getAlias(effect.pipeline);
      await os.swapAlias(effect.pipeline, currentTarget, indexName);
      break;
    }
    case "TriggerReindex": {
      if (dryRun) {
        log(`[dry-run] Would reindex ${effect.source} -> ${effect.target}`);
        return;
      }
      log(`Triggering reindex: ${effect.source} -> ${effect.target}`);
      await os.triggerReindex(effect.source, effect.target);
      break;
    }
    default:
      throw new Error(`Not an OpenSearch effect: ${(effect as Effect).kind}`);
  }
}

async function executeSequinBatch(
  plan: Plan,
  batch: PlannedEffect[],
  desired: Map<string, PipelineConfig>,
  opts: ExecutorOptions,
): Promise<void> {
  if (opts.dryRun) {
    for (const pe of batch) {
      log(`[dry-run] Would apply sequin effect: ${pe.effect.kind}`);
    }
    return;
  }

  // Generate YAML from the current plan and desired configs, then apply via CLI
  const yaml = generateSequinYaml([plan], desired);
  const tmpFile = path.join(tmpdir(), `srb-sequin-${Date.now()}.yaml`);

  try {
    await fs.writeFile(tmpFile, yaml, "utf-8");
    log(`Applying Sequin config from ${tmpFile} (${batch.length} effects)`);
    await opts.sequinCli.apply(tmpFile);
  } finally {
    // Clean up temp file
    await fs.unlink(tmpFile).catch(() => {});
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

  if (opts.skipBackfill) {
    log(`Skipping backfill for sink: ${effect.sinkId} (--skip-backfill)`);
    return;
  }

  if (opts.dryRun) {
    log(`[dry-run] Would trigger backfill for sink: ${effect.sinkId}`);
    return;
  }

  // Look up the actual sink ID by colored name — the effect stores the base
  // ID from desired config, but the Sequin API needs the UUID
  const coloredName = coloredSinkName(plan.pipeline, plan.targetColor);
  const sinks = await opts.sequinApi.listSinks();
  const sink = sinks.find(s => s.name === coloredName);
  if (!sink) {
    throw new Error(`Cannot trigger backfill: sink "${coloredName}" not found in Sequin`);
  }

  log(`Triggering backfill for sink: ${coloredName} (${sink.id})`);
  await opts.sequinApi.triggerBackfill(sink.id);
}

export async function execute(
  plans: Plan[],
  desired: Map<string, PipelineConfig>,
  opts: ExecutorOptions,
): Promise<void> {
  for (const plan of plans) {
    if (plan.effects.length === 0) {
      log(`Pipeline ${plan.pipeline} (${plan.targetColor}): no changes`);
      continue;
    }

    log(`Pipeline ${plan.pipeline} (${plan.targetColor}): ${plan.effects.length} effects`);

    const batches = batchEffects(plan.effects);

    for (const batch of batches) {
      switch (batch.category) {
        case "opensearch":
          for (const pe of batch.effects) {
            await executeOpenSearchEffect(pe.effect, opts.openSearch, plan, opts.dryRun);
          }
          break;
        case "sequin_declarative":
          await executeSequinBatch(plan, batch.effects, desired, opts);
          break;
        case "imperative":
          for (const pe of batch.effects) {
            await executeImperativeEffect(pe.effect, plan, opts);
          }
          break;
      }
    }
  }
}
