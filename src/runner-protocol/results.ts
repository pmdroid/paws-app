import { z } from "zod";

export const RunnerResultSchema = z.strictObject({
  executionId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  role: z.enum(["implementer", "reviewer"]),
  stopReason: z.enum([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
    "timeout",
    "error",
  ]),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  authRequired: z.boolean(),
  agentExited: z.boolean(),
  sessionId: z.string().max(512).optional(),
  errorMessage: z.string().max(16384).optional(),
  identity: z
    .strictObject({
      session: z.string().max(512),
      model: z.string().max(512),
      provider: z.string().max(512),
    })
    .optional(),
  candidateSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  reviewText: z.string().max(524288).optional(),
});

export type RunnerResult = z.infer<typeof RunnerResultSchema>;
