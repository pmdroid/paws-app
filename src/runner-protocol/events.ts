import { z } from "zod";
import { RunnerArtifactSchema } from "./artifacts";
import { RunnerActivitySchema } from "./activity";

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

export const RunnerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("artifact"), artifact: RunnerArtifactSchema }),
  z.strictObject({ type: z.literal("progress"), text: z.string().min(1).max(500) }),
  z.strictObject({ type: z.literal("activity"), update: RunnerActivitySchema }),
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
  z.strictObject({ type: z.literal("candidate"), sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.strictObject({ type: z.literal("completed") }),
  z.strictObject({ type: z.literal("failed"), message: z.string().max(16384) }),
]);

export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
