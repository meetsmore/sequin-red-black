import { discoverLiveState } from "../state/discover.js";
import { generatePlans } from "../planner/plan.js";
import { formatPlans } from "../planner/format.js";
import { createClients, loadCompiled, type OnlineOptions } from "./shared.js";

export async function planCommand(opts: OnlineOptions & { output?: string }): Promise<void> {
  const { sequinCli, sequinApi, openSearch } = createClients(opts);
  const { colors, pipelines: desired } = await loadCompiled(opts.compiled);
  const { pipelines: live, aliases, occupiedColors } = await discoverLiveState(sequinCli, sequinApi, openSearch, desired);
  const plans = generatePlans(desired, live, colors, aliases, occupiedColors);

  if (plans.length === 0) {
    console.log("No changes. Infrastructure is up to date.");
    process.exit(0);
  }

  if (opts.output === "json") {
    console.log(JSON.stringify(plans, null, 2));
  } else {
    console.log(formatPlans(plans, { desired, live }));
  }

  process.exit(2); // changes pending
}
