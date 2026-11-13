import { z } from "zod";
import {
  RunnerCommandSchema,
  RunnerRetroCommandSchema,
  type RunnerCommand,
  type RunnerRetroCommand,
} from "../runner-protocol";

export const ExecutionIdSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const WorkCommandSchema = RunnerCommandSchema.refine((command) =>
  ["run", "review", "task", "probe", "login_check", "login", "helper"].includes(command.type),
).transform(
  (command) =>
    command as Extract<
      RunnerCommand,
      { type: "run" | "review" | "task" | "probe" | "login_check" | "login" | "helper" }
    >,
);
export const RunnerJobSchema = z.strictObject({
  executionId: ExecutionIdSchema,
  command: z.union([
    RunnerRetroCommandSchema.transform((command): RunnerRetroCommand => command),
    WorkCommandSchema,
  ]),
  credentials: z.strictObject({ certificate: z.string().min(1).max(16_384) }).optional(),
});
export type RunnerJob = z.infer<typeof RunnerJobSchema>;
