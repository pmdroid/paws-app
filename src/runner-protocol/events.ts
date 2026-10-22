import { z } from "zod";
import { RunnerArtifactSchema } from "./artifacts";
import { RunnerActivitySchema, RunnerPermissionSchema } from "./activity";

export const RunnerPlanStepSchema = z.strictObject({
  content: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (content) =>
        content.trim() === content &&
        [...content].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        }),
    ),
  status: z.enum(["pending", "inProgress", "completed", "canceled"]),
});

const closeoutText = z.string().max(256);
const closeoutHead = z.string().regex(/^([a-f0-9]{40}|)$/);
const closeoutAttempt = {
  head: closeoutHead,
  id: closeoutText.min(1),
  kind: closeoutText,
  command: z.string().max(4096),
  attempt: z.number().int().min(1).max(1000),
  maxAttempts: z.number().int().min(0).max(1000).nullable(),
};

export const RunnerCloseoutProgressSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("report"),
    head: closeoutHead,
    maxAttempts: z.number().int().min(0).max(1000).nullable(),
    checks: z
      .array(
        z.strictObject({
          id: closeoutText.min(1),
          kind: closeoutText,
          command: z.string().max(4096),
          status: closeoutText,
          failedAttempts: z.number().int().min(0).max(1000),
        }),
      )
      .max(64),
    blocked: z.string().max(16384).nullable(),
  }),
  z.strictObject({ type: z.literal("started"), ...closeoutAttempt }),
  z.strictObject({
    type: z.literal("finished"),
    ...closeoutAttempt,
    state: z.enum(["passed", "failed", "exhausted", "cancelled"]),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    stdout: z.string().max(16_000),
    stderr: z.string().max(16_000),
    truncated: z.boolean(),
  }),
]);

export const RunnerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("artifact"), artifact: RunnerArtifactSchema }),
  z.strictObject({
    type: z.literal("progress"),
    text: z.string().min(1).max(500),
    /** Set by the runner itself, so Paws posts it even inside the update interval. */
    notice: z.literal(true).optional(),
  }),
  z.strictObject({ type: z.literal("activity"), update: RunnerActivitySchema }),
  z.strictObject({ type: z.literal("permission"), permission: RunnerPermissionSchema }),
  z.strictObject({
    type: z.literal("plan"),
    steps: z.array(RunnerPlanStepSchema).min(1).max(16),
  }),
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
  z.strictObject({
    type: z.literal("pull_request"),
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(12000),
  }),
  z.strictObject({ type: z.literal("closeout"), progress: RunnerCloseoutProgressSchema }),
  z.strictObject({ type: z.literal("candidate"), sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.strictObject({ type: z.literal("closeout_policy") }),
  z.strictObject({ type: z.literal("completed") }),
  z.strictObject({ type: z.literal("failed"), message: z.string().max(16384) }),
]);

export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
