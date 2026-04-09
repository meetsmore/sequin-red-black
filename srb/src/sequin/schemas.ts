import { z } from "zod";

export const SinkInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "paused", "disabled"]),
  backfill: z
    .object({
      active: z.boolean(),
    })
    .optional(),
});
export type SinkInfo = z.infer<typeof SinkInfoSchema>;

export const SinkListSchema = z.object({
  data: z.array(SinkInfoSchema),
});
