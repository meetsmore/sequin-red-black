import { describe, test, expect, beforeEach } from "bun:test";
import { resetAll, deployPipeline, setAlias, triggerBackfill, testOS } from "../harness/helpers.js";
import { runSRB } from "../harness/run-srb.js";
import { jobsConfig } from "../harness/fixtures.js";

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
