import { z } from "zod";
import { RunnerResultSchema } from "./results";

export const RunnerHealthResultSchema = RunnerResultSchema.omit({
  candidateSha: true,
  reviewText: true,
  closeoutReport: true,
}).extend({
  models: z
    .array(
      z.strictObject({
        id: z.string().max(256),
        name: z.string().max(256),
        description: z.string().max(1024).optional(),
      }),
    )
    .max(128)
    .optional(),
  efforts: z
    .array(z.strictObject({ id: z.string().max(64), name: z.string().max(256) }))
    .max(32)
    .optional(),
  effort: z.string().max(64).nullable().optional(),
  login: z
    .strictObject({
      agent: z.enum(["claude", "codex", "grok"]),
      authenticated: z.boolean(),
      method: z.enum(["subscription", "api_key", "other", "none"]),
    })
    .optional(),
});

export type RunnerHealthResult = z.infer<typeof RunnerHealthResultSchema>;
