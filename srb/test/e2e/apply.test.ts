import { describe, test, expect, beforeEach } from "bun:test";
import { resetAll, deployPipeline, testSequin, testOS } from "../harness/helpers.js";
import { runSRB } from "../harness/run-srb.js";
import { COMPILED_PATH } from "../harness/constants.js";
import { jobsConfig, clientsConfig, writeCompiled } from "../harness/fixtures.js";

describe("apply", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("fresh setup (no prior state)", () => {
    test("plan shows changes pending, apply creates resources, second plan shows no changes", async () => {
      await writeCompiled(COMPILED_PATH, [jobsConfig]);

      // Plan should show changes pending (exit code 2)
      const plan = await runSRB("online", "plan");
      expect(plan.exitCode).toBe(2);

      // Apply should succeed
      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // Verify: sink exists
      const sinks = await testSequin.listSinks();
      expect(sinks.length).toBeGreaterThan(0);

      // Verify: OS index exists
      const indices = await testOS.listIndices();
      const jobsIndices = indices.filter((i) => i.name.startsWith("jobs_"));
      expect(jobsIndices.length).toBeGreaterThan(0);

      // Second plan should show no changes (exit code 0)
      const plan2 = await runSRB("online", "plan");
      expect(plan2.exitCode).toBe(0);
    });
  });

  describe("no change (desired == live)", () => {
    test("plan returns exit 0 when live matches desired", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await writeCompiled(COMPILED_PATH, [jobsConfig]);

      const plan = await runSRB("online", "plan");
      expect(plan.exitCode).toBe(0);
    });
  });

  describe("transform change (backfill path)", () => {
    test("creates new color with backfill effects", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      // Compile with modified transform
      const modifiedConfig = {
        ...jobsConfig,
        transform: {
          ...jobsConfig.transform,
          functionBody: `def transform(_action, record, _changes, _metadata) do\n  Map.put(record, "extra", true)\nend`,
        },
      };
      await writeCompiled(COMPILED_PATH, [modifiedConfig]);

      // Plan should show changes
      const plan = await runSRB("online", "plan");
      expect(plan.exitCode).toBe(2);

      // Apply with skip-backfill
      const apply = await runSRB("online", "apply", "--skip-backfill", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // Verify: new color created, old still exists
      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      expect(indexNames).toContain("jobs_black");
      expect(indexNames).toContain("jobs_red");
    });
  });

  describe("batch size change (in-place update)", () => {
    test("updates existing sink without creating new color", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      const modifiedConfig = {
        ...jobsConfig,
        sink: { ...jobsConfig.sink, batchSize: 200 },
      };
      await writeCompiled(COMPILED_PATH, [modifiedConfig]);

      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // Verify: no new color, only jobs_red
      const indices = await testOS.listIndices();
      const jobsIndices = indices.filter((i) => i.name.startsWith("jobs_"));
      expect(jobsIndices).toHaveLength(1);
      expect(jobsIndices[0].name).toBe("jobs_red");
    });
  });

  describe("index mappings change (reindex path)", () => {
    test("creates new color with reindex effect", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      const modifiedConfig = {
        ...jobsConfig,
        index: {
          ...jobsConfig.index,
          mappings: { properties: { title: { type: "keyword" } } },
        },
      };
      await writeCompiled(COMPILED_PATH, [modifiedConfig]);

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
      await writeCompiled(COMPILED_PATH, [jobsConfig, clientsConfig]);

      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      expect(indexNames.some((n) => n.startsWith("jobs_"))).toBe(true);
      expect(indexNames.some((n) => n.startsWith("clients_"))).toBe(true);
    });
  });

  describe("retry after partial failure", () => {
    test("apply succeeds when OS index already exists from a previous failed apply", async () => {
      await writeCompiled(COMPILED_PATH, [jobsConfig]);

      // Simulate a partial failure: OS index was created but Sequin apply failed
      await testOS.createIndex("jobs_red", {
        mappings: jobsConfig.index.mappings,
        settings: jobsConfig.index.settings,
      });

      // Apply should succeed despite the index already existing
      const apply = await runSRB("online", "apply", "--auto-approve");
      expect(apply.exitCode).toBe(0);

      // Verify resources were created
      const sinks = await testSequin.listSinks();
      expect(sinks.some((s) => s.name === "jobs_red")).toBe(true);
    });
  });
});
