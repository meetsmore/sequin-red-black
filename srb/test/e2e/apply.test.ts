import { describe, test, expect, beforeEach } from "bun:test";
import { resetAll, deployPipeline, setAlias, testSequin, testOS } from "../harness/helpers.js";
import { runSRB } from "../harness/run-srb.js";
import { COMPILED_PATH } from "../harness/constants.js";
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

const clientsConfig: PipelineConfig = {
  name: "clients",
  sink: {
    id: "sink-clients-red",
    name: "clients_red",
    sourceTable: "public.Client",
    destination: "opensearch://localhost:19200/clients_red",
    filters: "isArchive = false",
    batchSize: 50,
    transformId: "transform-clients-red",
    enrichmentIds: ["enrichment-clients-red"],
  },
  index: {
    id: "index-clients-red",
    name: "clients_red",
    mappings: { properties: { name: { type: "text" }, email: { type: "keyword" } } },
    settings: { number_of_replicas: 0 },
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
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apply", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("fresh setup (no prior state)", () => {
    test("plan shows changes pending, apply creates resources, second plan shows no changes", async () => {
      // 1. Compile
      const compile = await runSRB("offline", "compile");
      expect(compile.exitCode).toBe(0);

      // 2. Plan should show changes pending (exit code 2)
      const plan = await runSRB("online", "plan");
      expect(plan.exitCode).toBe(2);

      // 3. Apply should succeed
      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // 4. Verify: one colored sink + index exists per pipeline
      const sinks = await testSequin.listSinks();
      expect(sinks.length).toBeGreaterThan(0);

      const indices = await testOS.listIndices();
      expect(indices.length).toBeGreaterThan(0);

      // 5. Second plan should show no changes (exit code 0)
      const plan2 = await runSRB("online", "plan");
      expect(plan2.exitCode).toBe(0);
    });
  });

  describe("no change (desired == live)", () => {
    test("plan returns exit 0 when live matches desired", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      // Compile with matching config
      await Bun.write(COMPILED_PATH, JSON.stringify({ pipelines: { jobs: jobsConfig } }));

      const plan = await runSRB("online", "plan");
      expect(plan.exitCode).toBe(0);
    });
  });

  describe("transform change (backfill path)", () => {
    test("creates new color with backfill effects", async () => {
      // 1. Deploy existing pipeline
      await deployPipeline("jobs", "red", jobsConfig);
      await setAlias("jobs", "red");

      // 2. Compile with modified transform
      const modifiedConfig = {
        ...jobsConfig,
        transform: { ...jobsConfig.transform, functionBody: "fn(r) { return r; }" },
      };
      await Bun.write(COMPILED_PATH, JSON.stringify({ pipelines: { jobs: modifiedConfig } }));

      // 3. Plan should show changes
      const plan = await runSRB("online", "plan");
      expect(plan.exitCode).toBe(2);

      // 4. Apply with skip-backfill
      const apply = await runSRB("online", "apply", "--skip-backfill", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // 5. Verify: jobs_black created, jobs_red still exists
      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      expect(indexNames).toContain("jobs_black");
      expect(indexNames).toContain("jobs_red");

      // 6. Activate the new color
      const activate = await runSRB("online", "activate", "jobs", "black");
      expect(activate.exitCode).toBe(0);
      const aliasColor = await testOS.getAliasColor("jobs");
      expect(aliasColor).toBe("black");

      // 7. Drop old color
      const drop = await runSRB("online", "drop", "jobs", "red");
      expect(drop.exitCode).toBe(0);
    });
  });

  describe("batch size change (in-place update)", () => {
    test("updates existing sink without creating new color", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      // Compile with modified batch_size
      const modifiedConfig = {
        ...jobsConfig,
        sink: { ...jobsConfig.sink, batchSize: 200 },
      };
      await Bun.write(COMPILED_PATH, JSON.stringify({ pipelines: { jobs: modifiedConfig } }));

      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // Verify: no new color, no new index
      const indices = await testOS.listIndices();
      const jobsIndices = indices.filter((i) => i.name.startsWith("jobs_"));
      expect(jobsIndices).toHaveLength(1);
      expect(jobsIndices[0].name).toBe("jobs_red");
    });
  });

  describe("index mappings change (reindex path)", () => {
    test("creates new color with reindex effect", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      // Compile with modified mappings
      const modifiedConfig = {
        ...jobsConfig,
        index: {
          ...jobsConfig.index,
          mappings: { properties: { title: { type: "keyword" } } },
        },
      };
      await Bun.write(COMPILED_PATH, JSON.stringify({ pipelines: { jobs: modifiedConfig } }));

      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // Verify: new color created
      const indices = await testOS.listIndices();
      const jobsIndices = indices.filter((i) => i.name.startsWith("jobs_"));
      expect(jobsIndices.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("multi-pipeline", () => {
    test("creates both pipelines independently", async () => {
      // Compile with jobs + clients configs
      await Bun.write(
        COMPILED_PATH,
        JSON.stringify({ pipelines: { jobs: jobsConfig, clients: clientsConfig } }),
      );

      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // Verify: both pipelines created
      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      const hasJobs = indexNames.some((n) => n.startsWith("jobs_"));
      const hasClients = indexNames.some((n) => n.startsWith("clients_"));
      expect(hasJobs).toBe(true);
      expect(hasClients).toBe(true);
    });
  });
});
