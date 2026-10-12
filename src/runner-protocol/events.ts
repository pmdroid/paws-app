import { z } from "zod";

export const RunnerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), text: z.string().max(65536) }),
  z.strictObject({
    type: z.literal("question"),
    text: z.string().min(1).max(16384),
    options: z
      .array(
        z.union([
          z.string().max(256),
          z.strictObject({
            label: z.string().min(1).max(256).optional(),
            value: z.string().min(1).max(256),
          }),
        ]),
      )
      .max(16),
  }),
  z.strictObject({ type: z.literal("candidate"), sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.strictObject({ type: z.literal("completed") }),
  z.strictObject({ type: z.literal("failed"), message: z.string().max(16384) }),
]);

export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
