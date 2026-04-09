import { describe, test, expect, beforeEach } from "bun:test";
import { resetAll, deployPipeline, setAlias, testSequin, testOS } from "../harness/helpers.js";
import { runSRB } from "../harness/run-srb.js";
import { jobsConfig } from "../harness/fixtures.js";

describe("drop", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("drop inactive color", () => {
    test("deletes inactive color resources, leaves active color untouched", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await deployPipeline("jobs", "black", jobsConfig);
      await setAlias("jobs", "red");

      const result = await runSRB("online", "drop", "jobs", "black");
      expect(result.exitCode).toBe(0);

      // Verify: black resources deleted
      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      expect(indexNames).not.toContain("jobs_black");
      expect(indexNames).toContain("jobs_red");

      // Alias intact
      const aliasColor = await testOS.getAliasColor("jobs");
      expect(aliasColor).toBe("red");
    });
  });

  describe("drop active color", () => {
    test("returns error when trying to drop the active color", async () => {
      await deployPipeline("jobs", "red", jobsConfig);
      await setAlias("jobs", "red");

      const result = await runSRB("online", "drop", "jobs", "red");
      expect(result.exitCode).not.toBe(0);

      // Nothing deleted
      const indices = await testOS.listIndices();
      const indexNames = indices.map((i) => i.name);
      expect(indexNames).toContain("jobs_red");
    });
  });
});
