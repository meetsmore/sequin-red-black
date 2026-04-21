import { describe, test, expect } from "bun:test";
import { execute } from "../../src/executor/executor.js";
import type { SequinCLI, SequinConfigYaml } from "../../src/sequin/cli.js";
import type { SequinAPI } from "../../src/sequin/api.js";
import type { OpenSearchClient } from "../../src/opensearch/client.js";
import type { Plan, PipelineConfig, PlannedEffect } from "../../src/config/types.js";
import * as fs from "fs/promises";

// ---------------------------------------------------------------------------
// Recording mocks — capture call order via a shared log.
// ---------------------------------------------------------------------------

type CallLog = string[];

function mockSequinCli(log: CallLog): SequinCLI {
  return {
    async plan(_: string) { return { stdout: "", exitCode: 0 }; },
    async apply(yamlPath: string) {
      const body = await fs.readFile(yamlPath, "utf-8");
      log.push(`sequin.apply:${body}`);
    },
    async export_(): Promise<SequinConfigYaml> { return {}; },
  } as unknown as SequinCLI;
}

function mockSequinApi(log: CallLog): SequinAPI {
  return {
    async listSinks() { return []; },
    async deleteSink(id: string) { log.push(`sequin.deleteSink:${id}`); },
    async triggerBackfill(id: string) { log.push(`sequin.triggerBackfill:${id}`); },
  } as unknown as SequinAPI;
}

function mockOpenSearch(log: CallLog): OpenSearchClient {
  return {
    async createIndex(name: string) { log.push(`os.createIndex:${name}`); },
    async deleteIndex(name: string) { log.push(`os.deleteIndex:${name}`); },
    async getAlias(_: string) { return "old-target"; },
    async swapAlias(alias: string, _old: string, next: string) { log.push(`os.swapAlias:${alias}->${next}`); },
    async triggerReindex(src: string, tgt: string) { log.push(`os.reindex:${src}->${tgt}`); },
  } as unknown as OpenSearchClient;
}

function fixturePipelineConfig(name: string): PipelineConfig {
  return {
    name,
    sink: {
      id: `sink-${name}`,
      name,
      database: "source-db",
      sourceTable: "public.T",
      destination: { type: "elasticsearch", endpoint_url: "http://os:9200", auth_type: "none" },
      filters: "",
      batchSize: 100,
      transformId: `transform-${name}`,
      enrichmentIds: [`enrichment-${name}`],
    },
    index: { id: `index-${name}`, name, mappings: {}, settings: {}, alias: name },
    transform: { id: `transform-${name}`, name: `${name}-transform`, functionBody: "return m", inputSchema: "{}", outputSchema: "{}" },
    enrichment: { id: `enrichment-${name}`, name: `${name}-enrichment`, source: "select 1", joinColumn: "id", enrichmentColumns: "" },
    webhooks: [],
  };
}

function planWithCreate(pipeline: string, color: "red" | "black"): Plan {
  const cfg = fixturePipelineConfig(pipeline);
  const effects: PlannedEffect[] = [
    { effect: { kind: "CreateIndex", index: cfg.index }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "CreateTransform", transform: cfg.transform }, status: "pending", dependsOn: [], order: 2 },
    { effect: { kind: "CreateEnrichment", enrichment: cfg.enrichment }, status: "pending", dependsOn: [], order: 3 },
    { effect: { kind: "CreateSink", sink: cfg.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
  ];
  return { pipeline, targetColor: color, effects };
}

describe("executor", () => {
  test("empty plans list makes no calls", async () => {
    const log: CallLog = [];
    await execute(
      [],
      new Map(),
      {
        sequinCli: mockSequinCli(log),
        sequinApi: mockSequinApi(log),
        openSearch: mockOpenSearch(log),
        skipBackfill: false,
        dryRun: false,
      },
    );
    expect(log).toEqual([]);
  });

  test("multiple plans with declarative effects trigger exactly one sequin apply", async () => {
    const log: CallLog = [];
    const desired = new Map<string, PipelineConfig>([
      ["jobs", fixturePipelineConfig("jobs")],
      ["clients", fixturePipelineConfig("clients")],
    ]);
    const plans = [planWithCreate("jobs", "red"), planWithCreate("clients", "black")];

    await execute(plans, desired, {
      sequinCli: mockSequinCli(log),
      sequinApi: mockSequinApi(log),
      openSearch: mockOpenSearch(log),
      skipBackfill: true,
      dryRun: false,
    });

    const applies = log.filter(l => l.startsWith("sequin.apply:"));
    expect(applies).toHaveLength(1);
    expect(applies[0]).toContain("jobs_red");
    expect(applies[0]).toContain("clients_black");
  });
});
