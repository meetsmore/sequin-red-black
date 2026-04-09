import { describe, test, expect } from "bun:test";
import {
  sinkDataChanged,
  sinkOperationalChanged,
  sinkConfigChanged,
  indexConfigChanged,
  transformConfigChanged,
  enrichmentConfigChanged,
  needsBackfill,
  needsReindex,
  needsInPlaceUpdate,
  effectsForCreate,
  effectsForDeleteColor,
} from "../../src/planner/effects.js";
import type {
  SinkConfig,
  IndexConfig,
  TransformConfig,
  EnrichmentConfig,
  PipelineConfig,
  LivePipelineState,
} from "../../src/config/types.js";

// ---------------------------------------------------------------------------
// Fixtures (matching Quint test fixtures for "jobs" pipeline)
// ---------------------------------------------------------------------------

function fixtureSink(overrides?: Partial<SinkConfig>): SinkConfig {
  return {
    id: "sink-jobs-red",
    name: "jobs_red",
    sourceTable: "public.Job",
    destination: "opensearch://localhost:9200/jobs_red",
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
  };
}

// ---------------------------------------------------------------------------
// sinkDataChanged
// ---------------------------------------------------------------------------

describe("sinkDataChanged", () => {
  test("detects sourceTable change", () => {
    const desired = fixtureSink({ sourceTable: "public.Client" });
    const live = fixtureSink();
    expect(sinkDataChanged(desired, live)).toBe(true);
  });

  test("detects destination change", () => {
    const desired = fixtureSink({ destination: "opensearch://localhost:9200/jobs_black" });
    const live = fixtureSink();
    expect(sinkDataChanged(desired, live)).toBe(true);
  });

  test("detects filters change", () => {
    const desired = fixtureSink({ filters: "showInKanban = false" });
    const live = fixtureSink();
    expect(sinkDataChanged(desired, live)).toBe(true);
  });

  test("detects transformId change", () => {
    const desired = fixtureSink({ transformId: "transform-jobs-black" });
    const live = fixtureSink();
    expect(sinkDataChanged(desired, live)).toBe(true);
  });

  test("detects enrichmentIds change", () => {
    const desired = fixtureSink({ enrichmentIds: ["enrichment-jobs-red", "extra-enrichment"] });
    const live = fixtureSink();
    expect(sinkDataChanged(desired, live)).toBe(true);
  });

  test("returns false when no change", () => {
    const desired = fixtureSink();
    const live = fixtureSink();
    expect(sinkDataChanged(desired, live)).toBe(false);
  });

  test("enrichmentIds order does not matter", () => {
    const desired = fixtureSink({ enrichmentIds: ["b", "a"] });
    const live = fixtureSink({ enrichmentIds: ["a", "b"] });
    expect(sinkDataChanged(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sinkOperationalChanged
// ---------------------------------------------------------------------------

describe("sinkOperationalChanged", () => {
  test("detects batchSize change", () => {
    const desired = fixtureSink({ batchSize: 200 });
    const live = fixtureSink({ batchSize: 100 });
    expect(sinkOperationalChanged(desired, live)).toBe(true);
  });

  test("returns false when batchSize unchanged", () => {
    const desired = fixtureSink();
    const live = fixtureSink();
    expect(sinkOperationalChanged(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sinkConfigChanged
// ---------------------------------------------------------------------------

describe("sinkConfigChanged", () => {
  test("combines data + operational - data change", () => {
    const desired = fixtureSink({ sourceTable: "public.Client" });
    const live = fixtureSink();
    expect(sinkConfigChanged(desired, live)).toBe(true);
  });

  test("combines data + operational - operational change", () => {
    const desired = fixtureSink({ batchSize: 200 });
    const live = fixtureSink();
    expect(sinkConfigChanged(desired, live)).toBe(true);
  });

  test("returns false when identical", () => {
    const desired = fixtureSink();
    const live = fixtureSink();
    expect(sinkConfigChanged(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// indexConfigChanged
// ---------------------------------------------------------------------------

describe("indexConfigChanged", () => {
  test("detects mappings change", () => {
    const desired = fixtureIndex({ mappings: { properties: { title: { type: "keyword" } } } });
    const live = fixtureIndex();
    expect(indexConfigChanged(desired, live)).toBe(true);
  });

  test("detects settings change", () => {
    const desired = fixtureIndex({ settings: { number_of_replicas: 2 } });
    const live = fixtureIndex();
    expect(indexConfigChanged(desired, live)).toBe(true);
  });

  test("returns false when identical", () => {
    const desired = fixtureIndex();
    const live = fixtureIndex();
    expect(indexConfigChanged(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transformConfigChanged
// ---------------------------------------------------------------------------

describe("transformConfigChanged", () => {
  test("detects functionBody change", () => {
    const desired = fixtureTransform({ functionBody: "fn(record) { return record; }" });
    const live = fixtureTransform();
    expect(transformConfigChanged(desired, live)).toBe(true);
  });

  test("detects inputSchema change", () => {
    const desired = fixtureTransform({ inputSchema: "public.Client" });
    const live = fixtureTransform();
    expect(transformConfigChanged(desired, live)).toBe(true);
  });

  test("detects outputSchema change", () => {
    const desired = fixtureTransform({ outputSchema: "clients" });
    const live = fixtureTransform();
    expect(transformConfigChanged(desired, live)).toBe(true);
  });

  test("returns false when identical", () => {
    const desired = fixtureTransform();
    const live = fixtureTransform();
    expect(transformConfigChanged(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enrichmentConfigChanged
// ---------------------------------------------------------------------------

describe("enrichmentConfigChanged", () => {
  test("detects source change", () => {
    const desired = fixtureEnrichment({ source: "public.Phase" });
    const live = fixtureEnrichment();
    expect(enrichmentConfigChanged(desired, live)).toBe(true);
  });

  test("detects joinColumn change", () => {
    const desired = fixtureEnrichment({ joinColumn: "phaseId" });
    const live = fixtureEnrichment();
    expect(enrichmentConfigChanged(desired, live)).toBe(true);
  });

  test("detects enrichmentColumns change", () => {
    const desired = fixtureEnrichment({ enrichmentColumns: "name,description" });
    const live = fixtureEnrichment();
    expect(enrichmentConfigChanged(desired, live)).toBe(true);
  });

  test("returns false when identical", () => {
    const desired = fixtureEnrichment();
    const live = fixtureEnrichment();
    expect(enrichmentConfigChanged(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// needsBackfill / needsReindex / needsInPlaceUpdate
// ---------------------------------------------------------------------------

describe("needsBackfill", () => {
  test("true when transform changed", () => {
    const desired = fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } });
    const live = fixtureLiveState();
    expect(needsBackfill(desired, live)).toBe(true);
  });

  test("true when enrichment changed", () => {
    const desired = fixturePipeline({ enrichment: { source: "public.Phase" } });
    const live = fixtureLiveState();
    expect(needsBackfill(desired, live)).toBe(true);
  });

  test("true when sink data changed", () => {
    const desired = fixturePipeline({ sink: { sourceTable: "public.Client" } });
    const live = fixtureLiveState();
    expect(needsBackfill(desired, live)).toBe(true);
  });

  test("false when only index changed", () => {
    const desired = fixturePipeline({ index: { mappings: { properties: { title: { type: "keyword" } } } } });
    const live = fixtureLiveState();
    expect(needsBackfill(desired, live)).toBe(false);
  });

  test("false when only batchSize changed", () => {
    const desired = fixturePipeline({ sink: { batchSize: 200 } });
    const live = fixtureLiveState();
    expect(needsBackfill(desired, live)).toBe(false);
  });
});

describe("needsReindex", () => {
  test("true when only index changed", () => {
    const desired = fixturePipeline({ index: { mappings: { properties: { title: { type: "keyword" } } } } });
    const live = fixtureLiveState();
    expect(needsReindex(desired, live)).toBe(true);
  });

  test("false when transform also changed (backfill takes priority)", () => {
    const desired = fixturePipeline({
      index: { mappings: { properties: { title: { type: "keyword" } } } },
      transform: { functionBody: "fn(r) { return r; }" },
    });
    const live = fixtureLiveState();
    expect(needsReindex(desired, live)).toBe(false);
  });

  test("false when only batchSize changed", () => {
    const desired = fixturePipeline({ sink: { batchSize: 200 } });
    const live = fixtureLiveState();
    expect(needsReindex(desired, live)).toBe(false);
  });
});

describe("needsInPlaceUpdate", () => {
  test("true when only batchSize changed", () => {
    const desired = fixturePipeline({ sink: { batchSize: 200 } });
    const live = fixtureLiveState();
    expect(needsInPlaceUpdate(desired, live)).toBe(true);
  });

  test("false when transform changed (backfill instead)", () => {
    const desired = fixturePipeline({ transform: { functionBody: "fn(r) { return r; }" } });
    const live = fixtureLiveState();
    expect(needsInPlaceUpdate(desired, live)).toBe(false);
  });

  test("false when index changed (reindex instead)", () => {
    const desired = fixturePipeline({ index: { mappings: { properties: { title: { type: "keyword" } } } } });
    const live = fixtureLiveState();
    expect(needsInPlaceUpdate(desired, live)).toBe(false);
  });

  test("false when no changes", () => {
    const desired = fixturePipeline();
    const live = fixtureLiveState();
    expect(needsInPlaceUpdate(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effectsForCreate
// ---------------------------------------------------------------------------

describe("effectsForCreate", () => {
  test("produces 5 effects in correct order", () => {
    const pipeline = fixturePipeline();
    const effects = effectsForCreate("jobs", pipeline, "red");

    expect(effects).toHaveLength(5);
    expect(effects[0].effect.kind).toBe("CreateIndex");
    expect(effects[0].order).toBe(1);
    expect(effects[0].dependsOn).toEqual([]);

    expect(effects[1].effect.kind).toBe("CreateTransform");
    expect(effects[1].order).toBe(2);
    expect(effects[1].dependsOn).toEqual([]);

    expect(effects[2].effect.kind).toBe("CreateEnrichment");
    expect(effects[2].order).toBe(3);
    expect(effects[2].dependsOn).toEqual([]);

    expect(effects[3].effect.kind).toBe("CreateSink");
    expect(effects[3].order).toBe(4);
    expect(effects[3].dependsOn).toEqual([1, 2, 3]);

    expect(effects[4].effect.kind).toBe("TriggerBackfill");
    expect(effects[4].order).toBe(5);
    expect(effects[4].dependsOn).toEqual([4]);
  });

  test("all effects start as pending", () => {
    const pipeline = fixturePipeline();
    const effects = effectsForCreate("jobs", pipeline, "red");
    for (const e of effects) {
      expect(e.status).toBe("pending");
    }
  });
});

// ---------------------------------------------------------------------------
// effectsForDeleteColor
// ---------------------------------------------------------------------------

describe("effectsForDeleteColor", () => {
  test("produces 4 effects in correct order", () => {
    const live = fixtureLiveState();
    const effects = effectsForDeleteColor("jobs", live, "red");

    expect(effects).toHaveLength(4);
    expect(effects[0].effect.kind).toBe("DeleteSink");
    expect(effects[0].order).toBe(1);
    expect(effects[0].dependsOn).toEqual([]);

    expect(effects[1].effect.kind).toBe("DeleteTransform");
    expect(effects[1].order).toBe(2);
    expect(effects[1].dependsOn).toEqual([1]);

    expect(effects[2].effect.kind).toBe("DeleteEnrichment");
    expect(effects[2].order).toBe(3);
    expect(effects[2].dependsOn).toEqual([1]);

    expect(effects[3].effect.kind).toBe("DeleteIndex");
    expect(effects[3].order).toBe(4);
    expect(effects[3].dependsOn).toEqual([1, 2, 3]);
  });

  test("all effects start as pending", () => {
    const live = fixtureLiveState();
    const effects = effectsForDeleteColor("jobs", live, "red");
    for (const e of effects) {
      expect(e.status).toBe("pending");
    }
  });

  test("uses correct resource IDs from live state", () => {
    const live = fixtureLiveState();
    const effects = effectsForDeleteColor("jobs", live, "red");

    const deleteSink = effects[0].effect;
    if (deleteSink.kind === "DeleteSink") {
      expect(deleteSink.id).toBe("sink-jobs-red");
    }

    const deleteTransform = effects[1].effect;
    if (deleteTransform.kind === "DeleteTransform") {
      expect(deleteTransform.id).toBe("transform-jobs-red");
    }

    const deleteEnrichment = effects[2].effect;
    if (deleteEnrichment.kind === "DeleteEnrichment") {
      expect(deleteEnrichment.id).toBe("enrichment-jobs-red");
    }

    const deleteIndex = effects[3].effect;
    if (deleteIndex.kind === "DeleteIndex") {
      expect(deleteIndex.id).toBe("index-jobs-red");
    }
  });
});
