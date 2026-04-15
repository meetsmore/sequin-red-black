import { describe, test, expect } from "bun:test";
import { generatePlans, pipelineChangeKind, pickTargetColor } from "../../src/planner/plan.js";
import type {
  PipelineConfig,
  LivePipelineState,
  PipelineKey,
  SinkConfig,
  IndexConfig,
  TransformConfig,
  EnrichmentConfig,
} from "../../src/config/types.js";
import { pipelineKey } from "../../src/config/types.js";

// ---------------------------------------------------------------------------
// Fixtures (matching Quint test fixtures for "jobs" pipeline)
// ---------------------------------------------------------------------------

function fixtureSink(overrides?: Partial<SinkConfig>): SinkConfig {
  return {
    id: "sink-jobs-red",
    name: "jobs_red",
    database: "source-db",
    sourceTable: "public.Job",
    destination: { type: "elasticsearch", endpoint_url: "opensearch://localhost:9200/jobs_red", auth_type: "none" },
    filters: "showInKanban = true",
    batchSize: 100,
    transformId: "transform-jobs-red",
    enrichmentIds: ["enrichment-jobs-red"],
    ...overrides,
  };
}

function fixtureIndex(overrides?: Partial<IndexConfig>): IndexConfig {
  return {
    id: "index-jobs-red",
    name: "jobs_red",
    mappings: { properties: { title: { type: "text" }, slug: { type: "keyword" } } },
    settings: { number_of_replicas: 1 },
    alias: "jobs",
    ...overrides,
  };
}

function fixtureTransform(overrides?: Partial<TransformConfig>): TransformConfig {
  return {
    id: "transform-jobs-red",
    name: "jobs_red-transform",
    functionBody: 'fn(record) { return { title: record.title, slug: record.slug }; }',
    inputSchema: "public.Job",
    outputSchema: "jobs",
    ...overrides,
  };
}

function fixtureEnrichment(overrides?: Partial<EnrichmentConfig>): EnrichmentConfig {
  return {
    id: "enrichment-jobs-red",
    name: "jobs_red-enrichment",
    source: "public.Division",
    joinColumn: "divisionId",
    enrichmentColumns: "name",
    ...overrides,
  };
}

function fixturePipeline(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): PipelineConfig {
  return {
    name: "jobs",
    sink: fixtureSink(overrides?.sink),
    index: fixtureIndex(overrides?.index),
    transform: fixtureTransform(overrides?.transform),
    enrichment: fixtureEnrichment(overrides?.enrichment),
    webhooks: [],
  };
}

function fixtureLiveState(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): LivePipelineState {
  return {
    sink: { config: fixtureSink(overrides?.sink), lifecycle: "active", backfilling: false },
    index: { config: fixtureIndex(overrides?.index), status: "green", docCount: 100 },
    transform: { config: fixtureTransform(overrides?.transform), status: "active" },
    enrichment: { config: fixtureEnrichment(overrides?.enrichment), status: "active" },
    webhooks: [],
  };
}

function fixtureClientPipeline(): PipelineConfig {
  return {
    name: "clients",
    sink: {
      id: "sink-clients-red",
      name: "clients_red",
      database: "source-db",
      sourceTable: "public.Client",
      destination: { type: "elasticsearch", endpoint_url: "opensearch://localhost:9200/clients_red", auth_type: "none" },
      filters: "isArchive = false",
      batchSize: 50,
      transformId: "transform-clients-red",
      enrichmentIds: ["enrichment-clients-red"],
    },
    index: {
      id: "index-clients-red",
      name: "clients_red",
      mappings: { properties: { name: { type: "text" }, email: { type: "keyword" } } },
      settings: { number_of_replicas: 1 },
      alias: "clients",
    },
    transform: {
      id: "transform-clients-red",
      name: "clients_red-transform",
      functionBody: 'fn(record) { return { name: record.name, email: record.email }; }',
      inputSchema: "public.Client",
      outputSchema: "clients",
    },
    enrichment: {
      id: "enrichment-clients-red",
      name: "clients_red-enrichment",
      source: "public.Division",
      joinColumn: "divisionId",
      enrichmentColumns: "name",
    },
    webhooks: [],
  };
}

// ---------------------------------------------------------------------------
// pipelineChangeKind
// ---------------------------------------------------------------------------

describe("pipelineChangeKind", () => {
  test("returns create when no live state exists", () => {
    const desired = new Map([["jobs", fixturePipeline()]]);
    const live = new Map<PipelineKey, LivePipelineState>();
    expect(pipelineChangeKind("jobs", desired, live)).toBe("create");
  });

  test("returns update when both desired and live exist", () => {
    const desired = new Map([["jobs", fixturePipeline()]]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);
    expect(pipelineChangeKind("jobs", desired, live)).toBe("update");
  });

  test("returns delete when only live exists", () => {
    const desired = new Map<string, PipelineConfig>();
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);
    expect(pipelineChangeKind("jobs", desired, live)).toBe("delete");
  });

  test("returns no_change when neither exists", () => {
    const desired = new Map<string, PipelineConfig>();
    const live = new Map<PipelineKey, LivePipelineState>();
    expect(pipelineChangeKind("jobs", desired, live)).toBe("no_change");
  });
});

// ---------------------------------------------------------------------------
// pickTargetColor
// ---------------------------------------------------------------------------

describe("pickTargetColor", () => {
  test("picks red when no live state", () => {
    const live = new Map<PipelineKey, LivePipelineState>();
    expect(pickTargetColor("jobs", live)).toBe("red");
  });

  test("picks black when red is taken", () => {
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);
    expect(pickTargetColor("jobs", live)).toBe("black");
  });

  test("picks blue when red and black are taken", () => {
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
      [pipelineKey("jobs", "black"), fixtureLiveState()],
    ]);
    expect(pickTargetColor("jobs", live)).toBe("blue");
  });
});

// ---------------------------------------------------------------------------
// generatePlans
// ---------------------------------------------------------------------------

describe("generatePlans", () => {
  test("fresh setup (no live state) -> 1 plan, 5 effects (create path)", () => {
    const desired = new Map([["jobs", fixturePipeline()]]);
    const live = new Map<PipelineKey, LivePipelineState>();

    const plans = generatePlans(desired, live);

    expect(plans).toHaveLength(1);
    expect(plans[0].pipeline).toBe("jobs");
    expect(plans[0].targetColor).toBe("red");
    expect(plans[0].effects).toHaveLength(5);
    expect(plans[0].effects[0].effect.kind).toBe("CreateIndex");
    expect(plans[0].effects[1].effect.kind).toBe("CreateTransform");
    expect(plans[0].effects[2].effect.kind).toBe("CreateEnrichment");
    expect(plans[0].effects[3].effect.kind).toBe("CreateSink");
    expect(plans[0].effects[4].effect.kind).toBe("TriggerBackfill");
  });

  test("no change (desired == live) -> 0 plans", () => {
    const desired = new Map([["jobs", fixturePipeline()]]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);

    const plans = generatePlans(desired, live);
    expect(plans).toHaveLength(0);
  });

  test("transform body changed -> backfill path, 5 effects", () => {
    const desired = new Map([
      ["jobs", fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);

    const plans = generatePlans(desired, live);

    expect(plans).toHaveLength(1);
    expect(plans[0].pipeline).toBe("jobs");
    expect(plans[0].targetColor).toBe("black"); // red is taken
    expect(plans[0].effects).toHaveLength(5);
    expect(plans[0].effects[0].effect.kind).toBe("CreateIndex");
    expect(plans[0].effects[4].effect.kind).toBe("TriggerBackfill");
  });

  test("only index mappings changed -> reindex path, 5 effects with TriggerReindex", () => {
    const desired = new Map([
      ["jobs", fixturePipeline({ index: { mappings: { properties: { title: { type: "keyword" } } } } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);

    const plans = generatePlans(desired, live);

    expect(plans).toHaveLength(1);
    expect(plans[0].effects).toHaveLength(5);
    expect(plans[0].effects[4].effect.kind).toBe("TriggerReindex");
  });

  test("only batchSize changed -> in-place, 1 UpdateSink effect", () => {
    const desired = new Map([
      ["jobs", fixturePipeline({ sink: { batchSize: 200 } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);

    const plans = generatePlans(desired, live);

    expect(plans).toHaveLength(1);
    expect(plans[0].effects).toHaveLength(1);
    expect(plans[0].effects[0].effect.kind).toBe("UpdateSink");
  });

  test("two pipelines (jobs + clients) -> 2 independent plans", () => {
    const desired = new Map([
      ["jobs", fixturePipeline()],
      ["clients", fixtureClientPipeline()],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>();

    const plans = generatePlans(desired, live);

    expect(plans).toHaveLength(2);
    const pipelineNames = plans.map((p) => p.pipeline).sort();
    expect(pipelineNames).toEqual(["clients", "jobs"]);

    // Both should be create plans with 5 effects each
    for (const plan of plans) {
      expect(plan.effects).toHaveLength(5);
      expect(plan.targetColor).toBe("red"); // both fresh -> both get red
    }
  });
});
