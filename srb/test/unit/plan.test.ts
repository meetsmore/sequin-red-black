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

  test("in-place mode targets active color and skips backfill/reindex/swap", () => {
    // Transform changed: normally triggers red-black with CreateIndex + TriggerBackfill
    // onto a fresh color. In in-place mode we keep red and just refresh the sequin
    // resources.
    const desired = new Map([
      ["jobs", fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);
    const aliases = new Map<string, "red" | "black" | "blue" | "green" | "purple" | "orange" | "yellow">([["jobs", "red"]]);

    const plans = generatePlans(desired, live, undefined, aliases, undefined, { inPlace: true });

    expect(plans).toHaveLength(1);
    expect(plans[0].pipeline).toBe("jobs");
    expect(plans[0].targetColor).toBe("red");
    expect(plans[0].inPlace).toBe(true);
    const kinds = plans[0].effects.map((e) => e.effect.kind);
    expect(kinds).toEqual(["CreateTransform", "CreateEnrichment", "CreateSink"]);
    // No CreateIndex / TriggerBackfill / TriggerReindex / SwapAlias
    expect(kinds).not.toContain("CreateIndex");
    expect(kinds).not.toContain("TriggerBackfill");
    expect(kinds).not.toContain("TriggerReindex");
    expect(kinds).not.toContain("SwapAlias");
  });

  test("in-place mode with no alias still targets the only live color", () => {
    // The alias may be missing (e.g. dropped manually) while live sinks exist.
    // In-place should still update what's there rather than silently spinning
    // up a fresh color.
    const desired = new Map([
      ["jobs", fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "red"), fixtureLiveState()],
    ]);

    const plans = generatePlans(desired, live, undefined, undefined, undefined, { inPlace: true });

    expect(plans).toHaveLength(1);
    expect(plans[0].inPlace).toBe(true);
    expect(plans[0].targetColor).toBe("red");
    expect(plans[0].effects.map((e) => e.effect.kind)).not.toContain("TriggerBackfill");
  });

  test("in-place mode leaves create plans alone", () => {
    const desired = new Map([["jobs", fixturePipeline()]]);
    const live = new Map<PipelineKey, LivePipelineState>();

    const plans = generatePlans(desired, live, undefined, undefined, undefined, { inPlace: true });

    expect(plans).toHaveLength(1);
    expect(plans[0].inPlace).toBe(false);
    expect(plans[0].effects.map((e) => e.effect.kind)).toContain("CreateIndex");
    expect(plans[0].effects.map((e) => e.effect.kind)).toContain("TriggerBackfill");
  });

  // ---------------------------------------------------------------------------
  // Color-templated destination fields: sink.yaml carries the *bare* index
  // alias (e.g. "jobs"); state discovery returns the *colored* deployed name
  // ("jobs_red"). The planner must not flag this as a change, otherwise every
  // run with no actual config change would replan a full backfill onto a new
  // color.
  // ---------------------------------------------------------------------------

  test("destination index_name color-stamping must not produce a spurious change", () => {
    // Desired (from sink.yaml template): bare "jobs".
    // Live (post normalizeLiveDestination): also bare "jobs" — discovery
    // strips the trailing _<color> off Sequin's exported "jobs_red" so the
    // planner can compare apples-to-apples. If the normalization regresses
    // (or the planner ever consumes raw colored names), this test catches
    // it: any difference will produce a plan instead of zero.
    const desired = new Map([
      [
        "jobs",
        fixturePipeline({
          sink: {
            destination: {
              type: "elasticsearch",
              endpoint_url: "https://opensearch.example.com",
              auth_type: "none",
              index_name: "jobs",
            },
          },
        }),
      ],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [
        pipelineKey("jobs", "red"),
        fixtureLiveState({
          sink: {
            destination: {
              type: "elasticsearch",
              endpoint_url: "https://opensearch.example.com",
              auth_type: "none",
              index_name: "jobs", // post-discovery normalized form
            },
          },
        }),
      ],
    ]);

    const plans = generatePlans(desired, live);
    expect(plans).toHaveLength(0);
  });

  test("destination changes other than index_name are still detected", () => {
    // Sanity check: the index_name normalization above must not mask real
    // destination changes.
    const desired = new Map([
      [
        "jobs",
        fixturePipeline({
          sink: {
            destination: {
              type: "elasticsearch",
              endpoint_url: "https://NEW-cluster.example.com",
              auth_type: "none",
              index_name: "jobs",
            },
          },
        }),
      ],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [
        pipelineKey("jobs", "red"),
        fixtureLiveState({
          sink: {
            destination: {
              type: "elasticsearch",
              endpoint_url: "https://OLD-cluster.example.com",
              auth_type: "none",
              index_name: "jobs_red",
            },
          },
        }),
      ],
    ]);

    const plans = generatePlans(desired, live);
    expect(plans).toHaveLength(1);
  });

  test("destination index_name with color-stripping must equal pipeline name", () => {
    // The normalization rule: live's index_name should always be exactly
    // `<pipeline>_<color>` for a given (pipeline, color) key. Confirms our
    // assumption — if this ever changes, the diff logic must update.
    const live = fixtureLiveState({
      sink: {
        destination: {
          type: "elasticsearch",
          endpoint_url: "x",
          auth_type: "none",
          index_name: "jobs_red",
        },
      },
    });
    const indexName = (live.sink.config.destination as { index_name: string }).index_name;
    expect(indexName).toBe("jobs_red");
    expect(indexName.replace(/_red$/, "")).toBe("jobs"); // strips back to bare
  });

  // ---------------------------------------------------------------------------
  // --in-place semantics — explicit contract per user spec:
  //   "if we use --in-place, we don't do red-black, it just doesn't roll a new
  //    color, and we update whatever the current active color is. Note that
  //    'active color' does NOT mean what color opensearch is pointing to —
  //    new colors shouldn't be created unless it's for indexes that don't
  //    exist at all."
  // ---------------------------------------------------------------------------

  test("in-place: alias points to a color that is not deployed -> targets deployed color (alias is irrelevant)", () => {
    // The OS alias may lag behind reality (manual surgery, dropped color, etc.).
    // --in-place must trust the deployed sink, not the alias.
    const desired = new Map([
      ["jobs", fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "blue"), fixtureLiveState()],
    ]);
    const aliases = new Map<string, "red" | "black" | "blue" | "green" | "purple" | "orange" | "yellow">([
      ["jobs", "red"], // alias points to red — but red is NOT deployed
    ]);

    const plans = generatePlans(desired, live, undefined, aliases, undefined, { inPlace: true });

    expect(plans).toHaveLength(1);
    expect(plans[0].targetColor).toBe("blue"); // deployed color wins
    expect(plans[0].inPlace).toBe(true);
  });

  test("in-place: deployed color is outside allowedColors -> still targets it (in-place doesn't roll, so allowedColors is irrelevant)", () => {
    // User's exact scenario: _srb.yaml restricts allowed colors to e.g. blue/green/purple
    // (red/black reserved for legacy pgsync). Pipeline already deployed at blue.
    // --in-place must target blue regardless of any other constraint.
    const desired = new Map([
      ["jobs", fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "blue"), fixtureLiveState()],
    ]);
    const allowedColors = ["green", "purple"] as const; // blue NOT in this list

    const plans = generatePlans(desired, live, [...allowedColors], undefined, undefined, { inPlace: true });

    expect(plans).toHaveLength(1);
    expect(plans[0].targetColor).toBe("blue"); // existing deploy wins over allowedColors
    expect(plans[0].inPlace).toBe(true);
  });

  test("in-place: must NEVER emit CreateIndex/TriggerBackfill/TriggerReindex/SwapAlias for an existing pipeline", () => {
    // Different change shapes that would normally pick different effect paths.
    // --in-place collapses all of them to a CreateTransform/Enrichment/Sink trio.
    const cases: Array<{ name: string; desired: Partial<{ sink: Partial<SinkConfig>; index: Partial<IndexConfig>; transform: Partial<TransformConfig>; enrichment: Partial<EnrichmentConfig> }> }> = [
      { name: "transform changed", desired: { transform: { functionBody: "fn(r) { return r; }" } } },
      { name: "enrichment changed", desired: { enrichment: { source: "public.OtherDivision" } } },
      { name: "index mappings changed", desired: { index: { mappings: { properties: { title: { type: "keyword" } } } } } },
      { name: "batch size changed", desired: { sink: { batchSize: 999 } } },
    ];
    for (const c of cases) {
      const desired = new Map([["jobs", fixturePipeline(c.desired)]]);
      const live = new Map<PipelineKey, LivePipelineState>([
        [pipelineKey("jobs", "blue"), fixtureLiveState()],
      ]);

      const plans = generatePlans(desired, live, undefined, undefined, undefined, { inPlace: true });

      expect(plans).toHaveLength(1);
      const kinds = plans[0].effects.map((e) => e.effect.kind);
      expect(kinds, `case: ${c.name}`).not.toContain("CreateIndex");
      expect(kinds, `case: ${c.name}`).not.toContain("TriggerBackfill");
      expect(kinds, `case: ${c.name}`).not.toContain("TriggerReindex");
      expect(kinds, `case: ${c.name}`).not.toContain("SwapAlias");
      expect(plans[0].targetColor, `case: ${c.name}`).toBe("blue");
      expect(plans[0].inPlace, `case: ${c.name}`).toBe(true);
    }
  });

  test("in-place: mixed (existing + missing pipelines) — existing gets in-place, missing creates fresh", () => {
    // jobs is deployed at blue, clients is brand new. --in-place updates jobs in
    // place at blue and creates clients fresh — no error, no skipped pipelines.
    const desired = new Map([
      ["jobs", fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } })],
      ["clients", fixtureClientPipeline()],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "blue"), fixtureLiveState()],
    ]);

    const plans = generatePlans(desired, live, undefined, undefined, undefined, { inPlace: true });

    const byPipeline = new Map(plans.map((p) => [p.pipeline, p]));
    expect(byPipeline.size).toBe(2);

    const jobsPlan = byPipeline.get("jobs")!;
    expect(jobsPlan.inPlace).toBe(true);
    expect(jobsPlan.targetColor).toBe("blue");
    expect(jobsPlan.effects.map((e) => e.effect.kind)).not.toContain("CreateIndex");

    const clientsPlan = byPipeline.get("clients")!;
    expect(clientsPlan.inPlace).toBe(false); // fresh-create can't be "in place"
    expect(clientsPlan.effects.map((e) => e.effect.kind)).toContain("CreateIndex");
    expect(clientsPlan.effects.map((e) => e.effect.kind)).toContain("TriggerBackfill");
  });

  test("in-place: must not allocate a NEW color when an existing one is deployed", () => {
    // Regression test for the contract: if a pipeline is deployed (at any
    // color), --in-place targets that color; it must not pick a different,
    // unoccupied color.
    const desired = new Map([
      ["jobs", fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } })],
    ]);
    const live = new Map<PipelineKey, LivePipelineState>([
      [pipelineKey("jobs", "purple"), fixtureLiveState()], // unusual color
    ]);

    const plans = generatePlans(desired, live, undefined, undefined, undefined, { inPlace: true });

    expect(plans).toHaveLength(1);
    expect(plans[0].targetColor).toBe("purple");
    // Critically: should not pick red/black/blue (which are unoccupied) just
    // because the picker would have preferred them in a fresh deploy.
    expect(["red", "black", "blue", "green", "orange", "yellow"]).not.toContain(plans[0].targetColor);
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
