import { z } from "zod";

export const RunnerLoginInputSchema = z.union([
  z.strictObject({ text: z.string().min(1).max(4096) }),
  z.strictObject({ accept: z.boolean() }),
]);
export const RunnerLoginUpdateSchema = z.strictObject({
  state: z.enum(["starting", "waiting", "connected", "failed"]),
  terminal: z.string().max(32768),
  authorization: z
    .strictObject({ url: z.url().max(4096), message: z.string().max(4096) })
    .nullable(),
  inputId: z.uuid().nullable(),
});
export const RunnerLoginExchangeSchema = z.strictObject({
  cancelled: z.boolean(),
  input: z.strictObject({ id: z.uuid(), value: RunnerLoginInputSchema }).nullable(),
});
export type RunnerLoginUpdate = z.infer<typeof RunnerLoginUpdateSchema>;
export type RunnerLoginInput = z.infer<typeof RunnerLoginInputSchema>;
