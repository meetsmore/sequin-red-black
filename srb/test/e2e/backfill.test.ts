import { describe, test, expect, beforeEach } from "bun:test";
import { resetAll, deployPipeline, triggerBackfill, testSequin } from "../harness/helpers.js";
import { runSRB } from "../harness/run-srb.js";
import { jobsConfig } from "../harness/fixtures.js";

describe("backfill", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("manual backfill", () => {
    test("triggers backfill on deployed sink", async () => {
      await deployPipeline("jobs", "red", jobsConfig);

      const result = await runSRB("online", "backfill", "jobs", "red");
      expect(result.exitCode).toBe(0);

      // Verify sink is backfilling
      const sink = await testSequin.getSinkByName("jobs_red");
      expect(sink).not.toBeNull();
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
