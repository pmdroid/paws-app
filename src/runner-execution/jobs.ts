import { z } from "zod";
import { RunnerCommandSchema, type RunnerCommand } from "../runner-protocol";

export const ExecutionIdSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const RunnerJobSchema = z.strictObject({
  executionId: ExecutionIdSchema,
  command: RunnerCommandSchema.refine((command) =>
    ["run", "review", "probe", "login_check"].includes(command.type),
  ).transform(
    (command) =>
      command as Extract<RunnerCommand, { type: "run" | "review" | "probe" | "login_check" }>,
  ),
});
export type RunnerJob = z.infer<typeof RunnerJobSchema>;
