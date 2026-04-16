import { discoverLiveState } from "../state/discover.js";
import { pipelineKey } from "../config/types.js";
import { colorFromString } from "../config/color.js";
import { effectsForDeleteColor } from "../planner/effects.js";
import { execute } from "../executor/executor.js";
import { createClients, type OnlineOptions } from "./shared.js";

export async function dropCommand(pipeline: string, colorStr: string, opts: OnlineOptions): Promise<void> {
  const color = colorFromString(colorStr);
  if (!color) { console.error(`Invalid color: ${colorStr}`); process.exit(1); }

  const { sequinCli, sequinApi, openSearch } = createClients(opts);
  const liveState = await discoverLiveState(sequinCli, sequinApi, openSearch);

  // Cannot drop active color
  const activeColor = liveState.aliases.get(pipeline);
  if (activeColor === color) { console.error(`Cannot drop ${pipeline}:${color} — it is the active color`); process.exit(1); }

  const key = pipelineKey(pipeline, color);
  const live = liveState.pipelines.get(key);

  if (live) {
    // Sequin-managed variant: delete sink + transform + enrichment + index
    const effects = effectsForDeleteColor(pipeline, live, color);
    const plan = { pipeline, targetColor: color, effects };
    await execute([plan], new Map(), { sequinCli, sequinApi, openSearch, skipBackfill: false, dryRun: false });
  } else {
    // Foreign OS index (e.g. pgsync legacy): delete just the OpenSearch index
    const isForeign = liveState.occupiedColors.get(pipeline)?.has(color);
    if (!isForeign) { console.error(`No live variant for ${pipeline}:${color}`); process.exit(1); }
    const indexName = `${pipeline}_${color}`;
    console.log(`Deleting foreign OpenSearch index: ${indexName}`);
    await openSearch.deleteIndex(indexName);
  }

  console.log(`Dropped ${pipeline}:${color}`);
}
