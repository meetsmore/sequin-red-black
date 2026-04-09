import { describe, test, expect, beforeEach } from "bun:test";
import { resetAll, deployPipeline, setAlias, testSequin, testOS } from "../harness/helpers.js";
import { runSRB } from "../harness/run-srb.js";
import { COMPILED_PATH } from "../harness/constants.js";
import { jobsConfig, writeCompiled } from "../harness/fixtures.js";

/**
 * Full red-black deployment lifecycle:
 *
 * 1. jobs_red is running and active (alias "jobs" → jobs_red)
 * 2. Developer changes the transform config
 * 3. `srb plan` → detects backfill-path changes, proposes jobs_black
 * 4. `srb apply --skip-backfill` → creates jobs_black alongside jobs_red
 * 5. Verify: both colors exist, alias still on red, sinks both active
 * 6. `srb activate jobs black` → swaps alias to black
 * 7. Verify: alias now on black, both colors still exist
 * 8. `srb plan` → no changes (desired matches live)
 * 9. `srb drop jobs red` → removes old color
 * 10. Verify: only jobs_black remains, alias intact
 */
describe("red-black lifecycle", () => {
  beforeEach(async () => {
    await resetAll();
  });

  test("full cycle: deploy red → change config → deploy black → activate → drop red", async () => {
    // ---------------------------------------------------------------
    // Step 1: Start with jobs_red running and active
    // ---------------------------------------------------------------
    await deployPipeline("jobs", "red", jobsConfig);
    await setAlias("jobs", "red");

    // Verify starting state
    expect(await testOS.getAliasColor("jobs")).toBe("red");
    const redSink = await testSequin.getSinkByName("jobs_red");
    expect(redSink).not.toBeNull();

    // ---------------------------------------------------------------
    // Step 2: Change the transform
    // ---------------------------------------------------------------
    const updatedConfig = {
      ...jobsConfig,
      transform: {
        ...jobsConfig.transform,
        functionBody: `def transform(_action, record, _changes, _metadata) do
  Map.put(record, "processed", true)
end`,
      },
    };
    await writeCompiled(COMPILED_PATH, [updatedConfig]);

    // ---------------------------------------------------------------
    // Step 3: Plan → backfill path, target color = black
    // ---------------------------------------------------------------
    const plan = await runSRB("online", "plan");
    expect(plan.exitCode).toBe(2); // changes pending
    expect(plan.stdout).toContain("backfill");
    expect(plan.stdout).toContain("jobs_black");
    expect(plan.stdout).toContain("create index");
    expect(plan.stdout).toContain("create sink");

    // ---------------------------------------------------------------
    // Step 4: Apply --skip-backfill → creates black alongside red
    // ---------------------------------------------------------------
    const apply = await runSRB("online", "apply", "--skip-backfill", "--auto-approve");
    expect(apply.exitCode).toBe(0);

    // ---------------------------------------------------------------
    // Step 5: Verify both colors coexist
    // ---------------------------------------------------------------
    // Both OS indices exist
    const indices = await testOS.listIndices();
    const jobsIndices = indices.filter(i => i.name.startsWith("jobs_")).map(i => i.name).sort();
    expect(jobsIndices).toEqual(["jobs_black", "jobs_red"]);

    // Both Sequin sinks exist
    const sinks = await testSequin.listSinks();
    const jobsSinks = sinks.filter(s => s.name.startsWith("jobs_")).map(s => s.name).sort();
    expect(jobsSinks).toEqual(["jobs_black", "jobs_red"]);

    // Alias still points to red (haven't activated yet)
    expect(await testOS.getAliasColor("jobs")).toBe("red");

    // ---------------------------------------------------------------
    // Step 6: Activate black → swap alias
    // ---------------------------------------------------------------
    const activate = await runSRB("online", "activate", "jobs", "black");
    expect(activate.exitCode).toBe(0);

    // ---------------------------------------------------------------
    // Step 7: Verify alias swapped, both colors still exist
    // ---------------------------------------------------------------
    expect(await testOS.getAliasColor("jobs")).toBe("black");

    // Both indices still present (haven't dropped red yet)
    const indicesAfterActivate = await testOS.listIndices();
    const jobsAfterActivate = indicesAfterActivate.filter(i => i.name.startsWith("jobs_")).map(i => i.name).sort();
    expect(jobsAfterActivate).toEqual(["jobs_black", "jobs_red"]);

    // ---------------------------------------------------------------
    // Step 8: Plan → no changes
    // ---------------------------------------------------------------
    const planAfter = await runSRB("online", "plan");
    if (planAfter.exitCode !== 0) {
      console.log("plan stdout:", planAfter.stdout);
      console.log("plan stderr:", planAfter.stderr);
    }
    expect(planAfter.exitCode).toBe(0);
    expect(planAfter.stdout).toContain("No changes");

    // ---------------------------------------------------------------
    // Step 9: Drop the old red color
    // ---------------------------------------------------------------
    const drop = await runSRB("online", "drop", "jobs", "red");
    expect(drop.exitCode).toBe(0);

    // ---------------------------------------------------------------
    // Step 10: Verify only black remains
    // ---------------------------------------------------------------
    // Only jobs_black index
    const indicesFinal = await testOS.listIndices();
    const jobsFinal = indicesFinal.filter(i => i.name.startsWith("jobs_"));
    expect(jobsFinal).toHaveLength(1);
    expect(jobsFinal[0].name).toBe("jobs_black");

    // Only jobs_black sink
    const sinksFinal = await testSequin.listSinks();
    const jobsSinksFinal = sinksFinal.filter(s => s.name.startsWith("jobs_"));
    expect(jobsSinksFinal).toHaveLength(1);
    expect(jobsSinksFinal[0].name).toBe("jobs_black");

    // Alias intact on black
    expect(await testOS.getAliasColor("jobs")).toBe("black");
  });
});
