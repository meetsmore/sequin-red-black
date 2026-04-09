import { z } from "zod";

export const SinkInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "paused", "disabled"]),
  batch_size: z.number().optional(),
  active_backfills: z.array(z.unknown()).optional(),
});
export type SinkInfo = z.infer<typeof SinkInfoSchema>;

export const SinkListSchema = z.object({
  data: z.array(SinkInfoSchema),
});

/** Check if a sink is currently backfilling */
export function isBackfilling(sink: SinkInfo): boolean {
  return (sink.active_backfills ?? []).length > 0;
}
