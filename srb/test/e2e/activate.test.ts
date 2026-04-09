import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetAll,
  deployPipeline,
  setAlias,
  triggerBackfill,
  testOS,
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

describe("activate", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("activate succeeds", () => {
    test("sets alias to point to the specified color", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      const result = await runSRB("online", "activate", "jobs", "red");
      expect(result.exitCode).toBe(0);

      const aliasColor = await testOS.getAliasColor("jobs");
      expect(aliasColor).toBe("red");
    });
  });

  describe("activate while backfilling", () => {
    test("returns error when sink is backfilling", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await triggerBackfill("jobs", "red");

      const result = await runSRB("online", "activate", "jobs", "red");
      expect(result.exitCode).not.toBe(0);

      // Alias should not be set
      const aliasColor = await testOS.getAliasColor("jobs");
      expect(aliasColor).toBeNull();
    });
  });

  describe("activate already active (idempotent)", () => {
    test("succeeds when alias already points to the same color", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await setAlias("jobs", "red");

      const result = await runSRB("online", "activate", "jobs", "red");
      expect(result.exitCode).toBe(0);

      const aliasColor = await testOS.getAliasColor("jobs");
      expect(aliasColor).toBe("red");
    });
  });
});
