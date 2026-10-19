import { z } from "zod";

export const RUNNER_RESULT_BODY_LIMIT = 1_048_576;
const resultMetadataBudget = 131_072;

/** Characters per stream, matching the Closeout session's tail. */
const closeoutRunStreamLimit = 8_192;
const closeoutRunsBudget = 196_608;

export const RunnerCloseoutRunSchema = z.strictObject({
  id: z.string().min(1).max(256),
  argv: z.array(z.string().max(4096)).max(256),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0),
  stdout: z.string().max(closeoutRunStreamLimit),
  stderr: z.string().max(closeoutRunStreamLimit),
  truncated: z.boolean(),
});

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
  reviewText: z
    .string()
    .max(524288)
    .refine(
      (text) =>
        Buffer.byteLength(JSON.stringify(text)) <= RUNNER_RESULT_BODY_LIMIT - resultMetadataBudget,
      "Runner review exceeds the maximum JSON request size",
    )
    .optional(),
  closeoutReport: z.string().max(65_536).optional(),
  closeoutRuns: z
    .array(RunnerCloseoutRunSchema)
    .max(64)
    .refine(
      (runs) => Buffer.byteLength(JSON.stringify(runs)) <= closeoutRunsBudget,
      "Closeout runs exceed the maximum size",
    )
    .optional(),
});

export type RunnerResult = z.infer<typeof RunnerResultSchema>;

export const RunnerHelperResultSchema = RunnerResultSchema.omit({
  candidateSha: true,
  reviewText: true,
  closeoutReport: true,
  closeoutRuns: true,
}).extend({
  role: z.literal("implementer"),
  text: z
    .string()
    .max(524_288)
    .refine(
      (text) =>
        Buffer.byteLength(JSON.stringify(text)) <= RUNNER_RESULT_BODY_LIMIT - resultMetadataBudget,
    ),
});

export type RunnerHelperResult = z.infer<typeof RunnerHelperResultSchema>;
