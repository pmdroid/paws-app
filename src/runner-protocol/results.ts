import { z } from "zod";
import { RUNNER_HANDOVER_FAILURES } from "./commands";

export const RUNNER_RESULT_BODY_LIMIT = 1_048_576;
const resultMetadataBudget = 131_072;

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
  tokens: z.number().int().nonnegative().optional(),
  agentLimits: z
    .array(
      z.strictObject({
        window: z.string().min(1).max(32),
        usedPercent: z.number().min(0).max(100),
        resetsAt: z.number().int().positive().nullable(),
      }),
    )
    .min(1)
    .max(4)
    .optional(),
  /** The run stopped for a handover: `candidateSha` is its WIP commit, if the worktree changed. */
  handedOver: z.literal(true).optional(),
  /** The handover stopped the agent, then failed; the next turn resumes the session here. */
  handoverFailure: z.enum(RUNNER_HANDOVER_FAILURES).optional(),
  pushFailure: z
    .strictObject({
      branch: z.string().min(1).max(256),
      error: z.string().min(1).max(4096),
      /** The branch holds commits the candidate lacks, and they did not rebase cleanly. */
      conflict: z.literal(true).optional(),
    })
    .optional(),
});

export type RunnerResult = z.infer<typeof RunnerResultSchema>;

export const RunnerHelperResultSchema = RunnerResultSchema.omit({
  candidateSha: true,
  reviewText: true,
  closeoutReport: true,
  handedOver: true,
  handoverFailure: true,
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
