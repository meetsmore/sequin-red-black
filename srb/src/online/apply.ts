import { discoverLiveState } from "../state/discover.js";
import { generatePlans } from "../planner/plan.js";
import { formatPlans } from "../planner/format.js";
import { execute } from "../executor/executor.js";
import { ALL_COLORS } from "../config/types.js";
import { createClients, loadCompiled, type OnlineOptions } from "./shared.js";

export async function applyCommand(opts: OnlineOptions & { skipBackfill?: boolean; autoApprove?: boolean }): Promise<void> {
  const { sequinCli, sequinApi, openSearch } = createClients(opts);
  const desired = await loadCompiled(opts.compiled);
  const { pipelines: live, aliases, occupiedColors } = await discoverLiveState(sequinCli, sequinApi, openSearch, desired);
  const plans = generatePlans(desired, live, ALL_COLORS, aliases, occupiedColors);

  if (plans.length === 0) {
    console.log("No changes. Infrastructure is up to date.");
    process.exit(0);
  }

  // Print plan
  console.log(formatPlans(plans, { desired, live }));

  // Confirm unless auto-approve
  if (!opts.autoApprove) {
    process.stdout.write("\nProceed? [y/N] ");
    const reader = Bun.stdin.stream().getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const answer = new TextDecoder().decode(value).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled.");
      process.exit(1);
    }
  }

  console.log("");
  await execute(plans, desired, {
    sequinCli,
    sequinApi,
    openSearch,
    skipBackfill: opts.skipBackfill ?? false,
    dryRun: false,
  });

  console.log("\nApply complete.");
}
