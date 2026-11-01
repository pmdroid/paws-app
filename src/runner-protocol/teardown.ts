import { z } from "zod";

/** Broker-confirmed termination, independent of command receipt and execution authority. */
export const RunnerTerminationSchema = z.strictObject({
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
});
export type RunnerTermination = z.infer<typeof RunnerTerminationSchema>;
