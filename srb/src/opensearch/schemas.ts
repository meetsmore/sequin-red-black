import { z } from "zod";

export const IndexInfoSchema = z.object({
  index: z.string(),
  health: z.enum(["green", "yellow", "red"]).optional(),
  status: z.string().optional(),
  "docs.count": z.string().optional(),
});
export type IndexInfo = z.infer<typeof IndexInfoSchema>;
