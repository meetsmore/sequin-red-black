import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetAll,
  deployPipeline,
  triggerBackfill,
  testSequin,
} from "../harness/helpers.js";
import { runSRB } from "../harness/run-srb.js";
import type { PipelineConfig } from "../../src/config/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const jobsConfig: PipelineConfig = {
  name: "jobs",
  sink: {
    id: "sink-jobs-red",
    name: "jobs_red",
    sourceTable: "public.Job",
    destination: "opensearch://localhost:19200/jobs_red",
    filters: "showInKanban = true",
    batchSize: 100,
    transformId: "transform-jobs-red",
    enrichmentIds: ["enrichment-jobs-red"],
  },
  index: {
    id: "index-jobs-red",
    name: "jobs_red",
    mappings: { properties: { title: { type: "text" }, slug: { type: "keyword" } } },
    settings: { number_of_replicas: 0 },
    alias: "jobs",
  },
  transform: {
    id: "transform-jobs-red",
    name: "jobs_red-transform",
    functionBody: 'fn(record) { return { title: record.title, slug: record.slug }; }',
    inputSchema: "public.Job",
    outputSchema: "jobs",
  },
  enrichment: {
    id: "enrichment-jobs-red",
    name: "jobs_red-enrichment",
    source: "public.Division",
    joinColumn: "divisionId",
    enrichmentColumns: "name",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfill", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("manual backfill", () => {
    test("triggers backfill on deployed sink", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      const result = await runSRB("online", "backfill", "jobs", "red");
      expect(result.exitCode).toBe(0);

      // Verify: sink should be in backfilling state
      const sink = await testSequin.getSinkByName("jobs_red");
      expect(sink).not.toBeNull();
      expect(sink!.backfill?.active).toBe(true);
    });
  });

  describe("backfill already running", () => {
    test("returns error when backfill is already in progress", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await triggerBackfill("jobs", "red");

      const result = await runSRB("online", "backfill", "jobs", "red");
      expect(result.exitCode).not.toBe(0);
    });
  });
});
