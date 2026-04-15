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
  webhookHasChanges,
  pipelineHasChanges,
} from "../../src/planner/effects.js";
import type {
  SinkConfig,
  IndexConfig,
  TransformConfig,
  EnrichmentConfig,
  PipelineConfig,
  LivePipelineState,
  WebhookConfig,
  LiveWebhookState,
} from "../../src/config/types.js";

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

function fixtureWebhookSink(overrides?: Partial<SinkConfig>): SinkConfig {
  return {
    id: "sink-addr-to-jobs-red",
    name: "address_to_jobs_red",
    database: "source-db",
    sourceTable: "public.Address",
    destination: { type: "webhook", http_endpoint: "opensearch-update-by-query", http_endpoint_path: "/jobs/_update_by_query?conflicts=proceed&wait_for_completion=false" },
    filters: "",
    batchSize: 1,
    transformId: "transform-addr-to-jobs-red",
    enrichmentIds: ["enrichment-addr-to-jobs-red"],
    ...overrides,
  };
}

function fixtureWebhookTransform(overrides?: Partial<TransformConfig>): TransformConfig {
  return {
    id: "transform-addr-to-jobs-red",
    name: "address_to_jobs_red-transform",
    functionBody: 'fn(record) { return { query: record.address }; }',
    inputSchema: "public.Address",
    outputSchema: "jobs",
    ...overrides,
  };
}

function fixtureWebhookEnrichment(overrides?: Partial<EnrichmentConfig>): EnrichmentConfig {
  return {
    id: "enrichment-addr-to-jobs-red",
    name: "address_to_jobs_red-enrichment",
    source: "public.Address",
    joinColumn: "id",
    enrichmentColumns: "street",
    ...overrides,
  };
}

function fixtureWebhook(overrides?: {
  sink?: Partial<SinkConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): WebhookConfig {
  return {
    name: "address_to_jobs",
    sink: fixtureWebhookSink(overrides?.sink),
    transform: fixtureWebhookTransform(overrides?.transform),
    enrichment: fixtureWebhookEnrichment(overrides?.enrichment),
    httpEndpoint: "opensearch-update-by-query",
    httpEndpointPath: "/jobs/_update_by_query?conflicts=proceed&wait_for_completion=false",
  };
}

function fixtureLiveWebhookState(overrides?: {
  sink?: Partial<SinkConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): LiveWebhookState {
  return {
    sink: { config: fixtureWebhookSink(overrides?.sink), lifecycle: "active", backfilling: false },
    transform: { config: fixtureWebhookTransform(overrides?.transform), status: "active" },
    enrichment: { config: fixtureWebhookEnrichment(overrides?.enrichment), status: "active" },
  };
}

function fixturePipelineWithWebhook(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): PipelineConfig {
  return {
    ...fixturePipeline(overrides),
    webhooks: [fixtureWebhook()],
  };
}

function fixtureLiveStateWithWebhook(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): LivePipelineState {
  return {
    ...fixtureLiveState(overrides),
    webhooks: [fixtureLiveWebhookState()],
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
    const desired = fixtureSink({ destination: { type: "elasticsearch", endpoint_url: "opensearch://localhost:9200/jobs_black", auth_type: "none" } });
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

// ---------------------------------------------------------------------------
// webhookHasChanges
// ---------------------------------------------------------------------------

describe("webhookHasChanges", () => {
  test("detects sink change", () => {
    const desired = fixtureWebhook({ sink: { filters: "status = active" } });
    const live = fixtureLiveWebhookState();
    expect(webhookHasChanges(desired, live)).toBe(true);
  });

  test("detects transform change", () => {
    const desired = fixtureWebhook({ transform: { functionBody: "fn(r) { return r; }" } });
    const live = fixtureLiveWebhookState();
    expect(webhookHasChanges(desired, live)).toBe(true);
  });

  test("detects enrichment change", () => {
    const desired = fixtureWebhook({ enrichment: { source: "public.Contact" } });
    const live = fixtureLiveWebhookState();
    expect(webhookHasChanges(desired, live)).toBe(true);
  });

  test("returns false when identical", () => {
    const desired = fixtureWebhook();
    const live = fixtureLiveWebhookState();
    expect(webhookHasChanges(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pipelineHasChanges — webhooks
// ---------------------------------------------------------------------------

describe("pipelineHasChanges — webhooks", () => {
  test("detects webhook added", () => {
    const desired = fixturePipelineWithWebhook();
    const live = fixtureLiveState(); // no webhooks
    expect(pipelineHasChanges(desired, live)).toBe(true);
  });

  test("detects webhook removed", () => {
    const desired = fixturePipeline(); // no webhooks
    const live = fixtureLiveStateWithWebhook();
    expect(pipelineHasChanges(desired, live)).toBe(true);
  });

  test("detects webhook config changed", () => {
    const desired: PipelineConfig = {
      ...fixturePipelineWithWebhook(),
      webhooks: [fixtureWebhook({ sink: { filters: "new_filter" } })],
    };
    const live = fixtureLiveStateWithWebhook();
    expect(pipelineHasChanges(desired, live)).toBe(true);
  });

  test("no change when webhooks match", () => {
    const desired = fixturePipelineWithWebhook();
    const live = fixtureLiveStateWithWebhook();
    expect(pipelineHasChanges(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effectsForCreate — with webhooks
// ---------------------------------------------------------------------------

describe("effectsForCreate — with webhooks", () => {
  test("produces 8 effects (5 primary + 3 webhook)", () => {
    const pipeline = fixturePipelineWithWebhook();
    const effects = effectsForCreate("jobs", pipeline, "red");
    expect(effects).toHaveLength(8);
  });

  test("webhook effects follow primary effects", () => {
    const pipeline = fixturePipelineWithWebhook();
    const effects = effectsForCreate("jobs", pipeline, "red");
    expect(effects[5].effect.kind).toBe("CreateTransform");
    expect(effects[6].effect.kind).toBe("CreateEnrichment");
    expect(effects[7].effect.kind).toBe("CreateSink");
  });

  test("webhook sink depends on index creation", () => {
    const pipeline = fixturePipelineWithWebhook();
    const effects = effectsForCreate("jobs", pipeline, "red");
    expect(effects[7].dependsOn).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// effectsForDeleteColor — with webhooks
// ---------------------------------------------------------------------------

describe("effectsForDeleteColor — with webhooks", () => {
  test("produces 7 effects (3 webhook + 4 primary)", () => {
    const live = fixtureLiveStateWithWebhook();
    const effects = effectsForDeleteColor("jobs", live, "red");
    expect(effects).toHaveLength(7);
  });

  test("webhook deletes come before primary deletes", () => {
    const live = fixtureLiveStateWithWebhook();
    const effects = effectsForDeleteColor("jobs", live, "red");
    expect(effects[0].effect.kind).toBe("DeleteSink");
    expect(effects[3].effect.kind).toBe("DeleteSink");
    expect(effects[6].effect.kind).toBe("DeleteIndex");
  });
});

// ---------------------------------------------------------------------------
// needsBackfill — webhook changes
// ---------------------------------------------------------------------------

describe("needsBackfill — webhook changes", () => {
  test("webhook-only change does NOT trigger backfill", () => {
    const desired = fixturePipelineWithWebhook();
    const live = fixtureLiveStateWithWebhook();
    expect(needsBackfill(desired, live)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// colorizeWebhookPath
// ---------------------------------------------------------------------------

import { colorizeWebhookPath } from "../../src/sequin/yaml-gen.js";

describe("colorizeWebhookPath", () => {
  test("stamps color into path", () => {
    const result = colorizeWebhookPath(
      "/jobs/_update_by_query?conflicts=proceed&wait_for_completion=false",
      "jobs",
      "red",
    );
    expect(result).toBe("/jobs_red/_update_by_query?conflicts=proceed&wait_for_completion=false");
  });

  test("handles different pipeline names", () => {
    const result = colorizeWebhookPath(
      "/buildings/_update_by_query?conflicts=proceed",
      "buildings",
      "black",
    );
    expect(result).toBe("/buildings_black/_update_by_query?conflicts=proceed");
  });

  test("handles purple color", () => {
    const result = colorizeWebhookPath(
      "/clients/_update_by_query",
      "clients",
      "purple",
    );
    expect(result).toBe("/clients_purple/_update_by_query");
  });
});
