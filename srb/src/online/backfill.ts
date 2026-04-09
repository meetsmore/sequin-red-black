import { discoverLiveState } from "../state/discover.js";
import { pipelineKey } from "../config/types.js";
import { colorFromString } from "../config/color.js";
import { createClients, type OnlineOptions } from "./shared.js";

export async function backfillCommand(pipeline: string, colorStr: string, opts: OnlineOptions): Promise<void> {
  const color = colorFromString(colorStr);
  if (!color) { console.error(`Invalid color: ${colorStr}`); process.exit(1); }

  const { sequinCli, sequinApi, openSearch } = createClients(opts);
  const liveState = await discoverLiveState(sequinCli, sequinApi, openSearch);
  const key = pipelineKey(pipeline, color);
  const live = liveState.pipelines.get(key);

  if (!live) { console.error(`No live variant for ${pipeline}:${color}`); process.exit(1); }
  if (live.sink.backfilling) { console.error(`${pipeline}:${color} is already backfilling`); process.exit(1); }

  await sequinApi.triggerBackfill(live.sink.config.id);
  console.log(`Triggered backfill for ${pipeline}:${color}`);
}
