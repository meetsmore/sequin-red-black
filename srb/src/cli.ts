#!/usr/bin/env bun
import { Command } from "commander";
import { compile } from "./offline/compile.js";
import { planCommand } from "./online/plan.js";
import { applyCommand } from "./online/apply.js";
import { activateCommand } from "./online/activate.js";
import { backfillCommand } from "./online/backfill.js";
import { dropCommand } from "./online/drop.js";
import { compareIndexesCommand } from "./online/opensearch/compare.js";

const program = new Command();
program.name("srb").description("Red-Black Deployment Orchestrator").version("0.1.0");

// offline group
const offline = program.command("offline").description("Offline operations (no network)");
offline.command("compile")
  .description("Compile pipeline configs to JSON")
  .option("--indexes <dir>", "Path to indexes directory", "./indexes")
  .option("--out <path>", "Output path for compiled JSON", "./compiled.json")
  .action(async (opts) => { await compile(opts.indexes, opts.out); });

// online group with shared connection options
const online = program.command("online").description("Online operations (requires Sequin + OpenSearch)");

function addConnectionOpts(cmd: Command): Command {
  return cmd
    .option("--compiled <path>", "Path to compiled.json (env: SRB_COMPILED)", process.env.SRB_COMPILED || "./compiled.json")
    .option("--sequin-context <ctx>", "Sequin CLI context (env: SRB_SEQUIN_CONTEXT)", process.env.SRB_SEQUIN_CONTEXT)
    .option("--sequin-url <url>", "Sequin API URL (env: SRB_SEQUIN_URL)", process.env.SRB_SEQUIN_URL || "http://localhost:7376")
    .option("--sequin-token <token>", "Sequin API token (env: SRB_SEQUIN_TOKEN)", process.env.SRB_SEQUIN_TOKEN)
    .option("--opensearch-url <url>", "OpenSearch URL (env: SRB_OPENSEARCH_URL)", process.env.SRB_OPENSEARCH_URL || "http://localhost:9200")
    .option("--opensearch-user <user>", "OpenSearch user (env: SRB_OPENSEARCH_USER)", process.env.SRB_OPENSEARCH_USER)
    .option("--opensearch-password <pass>", "OpenSearch password (env: SRB_OPENSEARCH_PASSWORD)", process.env.SRB_OPENSEARCH_PASSWORD);
}

// Note: commander uses camelCase for multi-word option names
function getOnlineOpts(opts: Record<string, string>) {
  return {
    compiled: opts.compiled,
    sequinContext: opts.sequinContext,
    sequinUrl: opts.sequinUrl,
    sequinToken: opts.sequinToken,
    opensearchUrl: opts.opensearchUrl,
    opensearchUser: opts.opensearchUser,
    opensearchPassword: opts.opensearchPassword,
  };
}

addConnectionOpts(online.command("plan").description("Show planned changes"))
  .option("--output <format>", "Output format (text|json)", "text")
  .action(async (opts) => { await planCommand({ ...getOnlineOpts(opts), output: opts.output }); });

addConnectionOpts(online.command("apply").description("Apply planned changes"))
  .option("--skip-backfill", "Skip backfill triggers")
  .option("--auto-approve", "Skip confirmation prompt")
  .option("--nuke-sequin", "Delete all existing Sequin sinks before applying")
  .option("--in-place", "Update current active color in place (skip red-black swap; ignores index changes). Overridden by --nuke-sequin.")
  .action(async (opts) => { await applyCommand({ ...getOnlineOpts(opts), skipBackfill: opts.skipBackfill, autoApprove: opts.autoApprove, nukeSequin: opts.nukeSequin, inPlace: opts.inPlace }); });

addConnectionOpts(online.command("activate").description("Activate a colored variant").argument("<pipeline>", "Pipeline name").argument("<color>", "Color to activate"))
  .action(async (pipeline: string, color: string, opts: Record<string, string>) => { await activateCommand(pipeline, color, getOnlineOpts(opts)); });

addConnectionOpts(online.command("backfill").description("Trigger backfill").argument("<pipeline>", "Pipeline name").argument("<color>", "Color to backfill"))
  .action(async (pipeline: string, color: string, opts: Record<string, string>) => { await backfillCommand(pipeline, color, getOnlineOpts(opts)); });

addConnectionOpts(online.command("drop").description("Drop a colored variant").argument("<pipeline>", "Pipeline name").argument("<color>", "Color to drop"))
  .action(async (pipeline: string, color: string, opts: Record<string, string>) => { await dropCommand(pipeline, color, getOnlineOpts(opts)); });

// online opensearch subgroup (OpenSearch-only utilities)
const onlineOpensearch = online.command("opensearch").description("OpenSearch utilities");

onlineOpensearch.command("compare")
  .description("Compare documents between two OpenSearch indexes")
  .argument("<indexA>", "First index name")
  .argument("<indexB>", "Second index name")
  .option("--sample <fraction>", "Fraction of docs to randomly sample (e.g. 0.01 = 1%)", parseFloat)
  .option(
    "--ignore-fields <paths>",
    "Comma-separated dotted field paths to ignore (e.g. '_meta,os_indexed_at'). A path also ignores its descendants. Repeatable.",
    (value: string, prev: string[] = []) => [...prev, ...value.split(",").map(s => s.trim()).filter(Boolean)],
    [] as string[],
  )
  .option("--opensearch-url <url>", "OpenSearch URL (env: SRB_OPENSEARCH_URL)", process.env.SRB_OPENSEARCH_URL || "http://localhost:9200")
  .option("--opensearch-user <user>", "OpenSearch user (env: SRB_OPENSEARCH_USER)", process.env.SRB_OPENSEARCH_USER)
  .option("--opensearch-password <pass>", "OpenSearch password (env: SRB_OPENSEARCH_PASSWORD)", process.env.SRB_OPENSEARCH_PASSWORD)
  .action(async (indexA: string, indexB: string, opts: Record<string, unknown>) => {
    await compareIndexesCommand(indexA, indexB, {
      opensearchUrl: opts.opensearchUrl as string,
      opensearchUser: opts.opensearchUser as string | undefined,
      opensearchPassword: opts.opensearchPassword as string | undefined,
      sample: opts.sample as number | undefined,
      ignoreFields: (opts.ignoreFields as string[] | undefined) ?? [],
    });
  });

program.parse();
