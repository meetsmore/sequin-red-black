import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetAll,
  deployPipeline,
  setAlias,
  testSequin,
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

const jobsBlackConfig: PipelineConfig = {
  ...jobsConfig,
  name: "jobs",
  sink: { ...jobsConfig.sink, id: "sink-jobs-black", name: "jobs_black" },
  index: { ...jobsConfig.index, id: "index-jobs-black", name: "jobs_black" },
  transform: { ...jobsConfig.transform, id: "transform-jobs-black", name: "jobs_black-transform" },
  enrichment: { ...jobsConfig.enrichment, id: "enrichment-jobs-black", name: "jobs_black-enrichment" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("drop", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("drop inactive color", () => {
    test("deletes inactive color resources, leaves active color untouched", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await deployPipeline("jobs", "black", jobsBlackConfig);
      await setAlias("jobs", "red");

      const result = await runSRB("online", "drop", "jobs", "black");
      expect(result.exitCode).toBe(0);

      // Black resources should be deleted
      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      expect(indexNames).not.toContain("jobs_black");

      // Red resources should still exist
      expect(indexNames).toContain("jobs_red");

      // Alias should still point to red
      const aliasColor = await testOS.getAliasColor("jobs");
      expect(aliasColor).toBe("red");
    });
  });

  describe("drop active color", () => {
    test("returns error when trying to drop active color", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await setAlias("jobs", "red");

      const result = await runSRB("online", "drop", "jobs", "red");
      expect(result.exitCode).not.toBe(0);

      // Nothing should be deleted
      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      expect(indexNames).toContain("jobs_red");
    });
  });
});
