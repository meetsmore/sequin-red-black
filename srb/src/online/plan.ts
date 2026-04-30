import { discoverLiveState } from "../state/discover.js";
import { generatePlans } from "../planner/plan.js";
import { formatPlans } from "../planner/format.js";
import { createClients, loadCompiled, type OnlineOptions } from "./shared.js";

export async function planCommand(opts: OnlineOptions & { output?: string; inPlace?: boolean }): Promise<void> {
  const { sequinCli, sequinApi, openSearch } = createClients(opts);
  const { colors, pipelines: desired } = await loadCompiled(opts.compiled);
  const { pipelines: live, aliases, occupiedColors } = await discoverLiveState(sequinCli, sequinApi, openSearch, desired);
  const inPlace = opts.inPlace ?? false;
  if (inPlace) {
    console.log("In-place mode: planning against current active color; red-black swap and index changes skipped.\n");
  }
  const plans = generatePlans(desired, live, colors, aliases, occupiedColors, { inPlace });

  // Mirror apply.ts: surface pipelines that fell back to a fresh color even
  // though --in-place was requested (they're new, nothing exists to update
  // in place yet) — otherwise an unexpected `_green` suffix would appear in
  // the output without explanation.
  if (inPlace) {
    for (const plan of plans) {
      if (!plan.inPlace && plan.effects.length > 0) {
        console.warn(`⚠ ${plan.pipeline}: in-place requested but no existing pipeline to update — falling back to ${plan.targetColor}`);
      }
    }
  }

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
