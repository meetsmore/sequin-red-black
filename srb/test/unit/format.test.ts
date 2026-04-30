import { describe, test, expect } from "bun:test";
import { formatPlans } from "../../src/planner/format.js";
import { pipelineKey } from "../../src/config/types.js";
import type {
  Plan,
  PipelineConfig,
  LivePipelineState,
  PipelineKey,
  SinkConfig,
  IndexConfig,
  TransformConfig,
  EnrichmentConfig,
} from "../../src/config/types.js";

// Strip ANSI escape codes so assertions can match plain substrings.
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function fixtureSink(overrides?: Partial<SinkConfig>): SinkConfig {
  return {
    id: "jobs",
    name: "jobs",
    database: "src",
    sourceTable: "public.Job",
    destination: { type: "elasticsearch", index_name: "jobs" },
    filters: "",
    batchSize: 100,
    transformId: "jobs-transform",
    enrichmentIds: ["jobs-enrichment"],
    ...overrides,
  };
}
function fixtureIndex(): IndexConfig {
  return {
    id: "jobs",
    name: "jobs",
    mappings: { properties: { title: { type: "text" } } },
    settings: {},
    alias: "jobs",
  };
}
function fixtureTransform(body = "fn(r) { return r; }"): TransformConfig {
  return { id: "jobs-transform", name: "jobs-transform", functionBody: body, inputSchema: "", outputSchema: "" };
}
function fixtureEnrichment(): EnrichmentConfig {
  return { id: "jobs-enrichment", name: "jobs-enrichment", source: "select 1", joinColumn: "id", enrichmentColumns: "" };
}
function fixturePipeline(overrides?: Partial<{ transform: TransformConfig }>): PipelineConfig {
  return {
    name: "jobs",
    sink: fixtureSink(),
    index: fixtureIndex(),
    transform: overrides?.transform ?? fixtureTransform(),
    enrichment: fixtureEnrichment(),
    webhooks: [],
  };
}
function fixtureLive(): LivePipelineState {
  return {
    sink: { config: fixtureSink(), lifecycle: "active", backfilling: false },
    index: { config: fixtureIndex(), status: "green", docCount: 100 },
    transform: { config: fixtureTransform("fn(r) { return null; }"), status: "active" },
    enrichment: { config: fixtureEnrichment(), status: "active" },
    webhooks: [],
  };
}

describe("formatPlans — effect verbs", () => {
  test("in-place plan renders CreateTransform/Enrichment/Sink as `~ upsert`, not `+ create`", () => {
    // In-place mode means the named resources already exist in Sequin and
    // `sequin config apply` will update them by name. The plan output should
    // reflect that — `+ create` reads as "this is brand new", which misleads
    // operators reviewing the plan.
    const plan: Plan = {
      pipeline: "jobs",
      targetColor: "blue",
      inPlace: true,
      effects: [
        { effect: { kind: "CreateTransform", transform: fixtureTransform() }, status: "pending", dependsOn: [], order: 1 },
        { effect: { kind: "CreateEnrichment", enrichment: fixtureEnrichment() }, status: "pending", dependsOn: [], order: 2 },
        { effect: { kind: "CreateSink", sink: fixtureSink() }, status: "pending", dependsOn: [], order: 3 },
      ],
    };
    const desired = new Map([["jobs", fixturePipeline({ transform: fixtureTransform() })]]);
    const live = new Map<PipelineKey, LivePipelineState>([[pipelineKey("jobs", "blue"), fixtureLive()]]);

    const out = plain(formatPlans([plan], { desired, live }));

    expect(out).toContain("~ upsert function \"jobs_blue-transform\"");
    expect(out).toContain("~ upsert function \"jobs_blue-enrichment\"");
    expect(out).toContain("~ upsert sink \"jobs_blue\"");
    expect(out).not.toContain("+ create function");
    expect(out).not.toContain("+ create sink");
  });

  test("non-in-place create plan still renders as `+ create` (these resources truly are new)", () => {
    // Regression: plan.inPlace=false (e.g. the equipments fallback case) must
    // continue to read as a real create.
    const plan: Plan = {
      pipeline: "jobs",
      targetColor: "blue",
      inPlace: false,
      effects: [
        { effect: { kind: "CreateIndex", index: fixtureIndex() }, status: "pending", dependsOn: [], order: 1 },
        { effect: { kind: "CreateTransform", transform: fixtureTransform() }, status: "pending", dependsOn: [], order: 2 },
        { effect: { kind: "CreateEnrichment", enrichment: fixtureEnrichment() }, status: "pending", dependsOn: [], order: 3 },
        { effect: { kind: "CreateSink", sink: fixtureSink() }, status: "pending", dependsOn: [], order: 4 },
        { effect: { kind: "TriggerBackfill", sinkId: "jobs" }, status: "pending", dependsOn: [], order: 5 },
      ],
    };
    const desired = new Map([["jobs", fixturePipeline()]]);
    const live = new Map<PipelineKey, LivePipelineState>(); // brand new

    const out = plain(formatPlans([plan], { desired, live }));

    expect(out).toContain("+ create index \"jobs_blue\"");
    expect(out).toContain("+ create function \"jobs_blue-transform\"");
    expect(out).toContain("+ create function \"jobs_blue-enrichment\"");
    expect(out).toContain("+ create sink \"jobs_blue\"");
    expect(out).not.toContain("~ upsert");
  });
});
