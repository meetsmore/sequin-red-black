import { discoverLiveState } from "../state/discover.js";
import { generatePlans } from "../planner/plan.js";
import { formatPlans } from "../planner/format.js";
import { ALL_COLORS } from "../config/types.js";
import { createClients, loadCompiled, type OnlineOptions } from "./shared.js";

export async function planCommand(opts: OnlineOptions & { output?: string }): Promise<void> {
  const { sequinCli, sequinApi, openSearch } = createClients(opts);
  const desired = await loadCompiled(opts.compiled);
  const liveState = await discoverLiveState(sequinCli, sequinApi, openSearch, desired);
  const plans = generatePlans(desired, liveState.pipelines, ALL_COLORS, liveState.aliases);

  if (plans.length === 0) {
    console.log("No changes. Infrastructure is up to date.");
    process.exit(0);
  }

  if (opts.output === "json") {
    console.log(JSON.stringify(plans, null, 2));
  } else {
    console.log(formatPlans(plans, { desired, live: liveState.pipelines }));
  }

  process.exit(2); // changes pending
}
