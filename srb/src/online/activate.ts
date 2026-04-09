import { discoverLiveState } from "../state/discover.js";
import { pipelineKey } from "../config/types.js";
import { colorFromString } from "../config/color.js";
import { createClients, type OnlineOptions } from "./shared.js";
import { coloredIndexName } from "../executor/executor.js";

export async function activateCommand(pipeline: string, colorStr: string, opts: OnlineOptions): Promise<void> {
  const color = colorFromString(colorStr);
  if (!color) { console.error(`Invalid color: ${colorStr}`); process.exit(1); }

  const { sequinCli, sequinApi, openSearch } = createClients(opts);
  const liveState = await discoverLiveState(sequinCli, sequinApi, openSearch);
  const key = pipelineKey(pipeline, color);
  const live = liveState.pipelines.get(key);

  if (!live) { console.error(`No live variant for ${pipeline}:${color}`); process.exit(1); }
  if (live.sink.backfilling) { console.error(`Cannot activate ${pipeline}:${color} — sink is mid-backfill`); process.exit(1); }
  if (live.index.status === "reindexing") { console.error(`Cannot activate ${pipeline}:${color} — index is mid-reindex`); process.exit(1); }

  // Check if already active (idempotent)
  const currentAlias = liveState.aliases.get(pipeline);
  if (currentAlias === color) {
    console.log(`${pipeline} is already active at ${color}.`);
    process.exit(0);
  }

  // Swap alias
  const fromIndex = currentAlias ? coloredIndexName(pipeline, currentAlias) : null;
  const toIndex = coloredIndexName(pipeline, color);
  await openSearch.swapAlias(pipeline, fromIndex, toIndex);
  console.log(`Activated ${pipeline} → ${color}`);
}
