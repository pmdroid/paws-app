import { PreviewReadySchema } from "./preview";
import { z } from "zod";
import { RUNNER_HANDOVER_FAILURES } from "./commands";
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
  z.strictObject({ type: z.literal("preview_stopped"), id: z.string().uuid() }),
  z.strictObject({
    type: z.literal("artifact"),
    artifact: RunnerArtifactSchema,
    /** Set by the runner when Paws refused the upload; the bytes were not sent. */
    dropped: z.string().min(1).max(1024).optional(),
  }),
  z.strictObject({
    type: z.literal("progress"),
    text: z.string().min(1).max(500),
    /** Set by the runner itself, so Paws posts it even inside the update interval. */
    notice: z.literal(true).optional(),
  }),
  z.strictObject({ type: z.literal("activity"), update: RunnerActivitySchema }),
  /** Whether the runner continued a moved run's saved session, and why not. */
  z.strictObject({
    type: z.literal("session_restore"),
    restored: z.boolean(),
    reason: z.enum(["download", "integrity", "unpack", "load"]).optional(),
  }),
  /**
   * A handover Paws asked for: the runner handed the session over (the WIP commit and session are
   * published and the result follows), found no safe point in time (`timeout`, the session keeps
   * running), or failed after it stopped the agent (the run stays on this runner).
   */
  z.strictObject({
    type: z.literal("handover"),
    handedOver: z.boolean(),
    reason: z.enum(["timeout", ...RUNNER_HANDOVER_FAILURES]).optional(),
  }),
  /** The runner stopped the agent at a safe point and is making the WIP commit and snapshot. */
  z.strictObject({ type: z.literal("handover_interrupted") }),
  /**
   * A WIP commit of the running worktree, published to the item's branch: before a stop Paws
   * asked for (`stop`), or on the runner's own interval (`interval`). A stop with no `sha` found
   * nothing new to save. `dropped` is set by the runner when it could not publish the commit.
   */
  z.strictObject({
    type: z.literal("checkpoint"),
    reason: z.enum(["stop", "interval"]),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    dropped: z.string().min(1).max(1024).optional(),
  }),
  z.strictObject({
    type: z.literal("hook_failed"),
    hookId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    hookEvent: z.enum(["after_edit", "before_shell", "before_tool", "stop", "session_start"]),
    command: z.string().min(1).max(512),
    reason: z.string().min(1).max(1024),
  }),
  z.strictObject({ type: z.literal("permission"), permission: RunnerPermissionSchema }),
  z.strictObject({
    type: z.literal("plan"),
    steps: z.array(RunnerPlanStepSchema).min(1).max(16),
  }),
  z.strictObject({
    type: z.literal("question"),
    text: z.string().min(1).max(16384),
    preview: PreviewReadySchema.optional(),
    context: z.string().min(1).max(16384).optional(),
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
  z.strictObject({
    type: z.literal("closeout_policy"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(8 * 1024 * 1024)
      .optional(),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  z.strictObject({ type: z.literal("completed") }),
  z.strictObject({ type: z.literal("failed"), message: z.string().max(16384) }),
]);

export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
