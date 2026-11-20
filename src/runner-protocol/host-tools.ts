import { z } from "zod";

export const BUILT_IN_HOST_TOOL_NAMES = [
  "ask_team",
  "update_plan",
  "publish_artifact",
  "open_pull_request",
  "post_update",
  "reply",
  "start_work",
  "get_closeout",
  "run_closeout",
  "closeout_finish",
  "rerun_ci",
  "remember",
  "recall",
] as const;

export const HOST_TOOL_LIMITS = {
  tools: 16,
  description: 1024,
  definitionBytes: 32_768,
  argumentBytes: 16_384,
  answerBytes: 16_384,
  callsPerCommand: 200,
} as const;

const builtIn: ReadonlySet<string> = new Set(BUILT_IN_HOST_TOOL_NAMES);

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export const HostToolNameSchema = z
  .string()
  .regex(/^[a-z][a-z_]{0,39}$/)
  .refine((name) => !builtIn.has(name), { message: "names a built-in tool" });

export const HostToolDefinitionsSchema = z
  .array(
    z.strictObject({
      name: HostToolNameSchema,
      description: z.string().max(HOST_TOOL_LIMITS.description),
      inputSchema: z.record(z.string(), z.json()),
    }),
  )
  .max(HOST_TOOL_LIMITS.tools)
  .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, {
    message: "tool names repeat",
  })
  .refine((tools) => jsonBytes(tools) <= HOST_TOOL_LIMITS.definitionBytes, {
    message: `tool definitions exceed ${HOST_TOOL_LIMITS.definitionBytes} bytes`,
  });

export const HostToolArgumentsSchema = z
  .record(z.string(), z.json())
  .refine((value) => jsonBytes(value) <= HOST_TOOL_LIMITS.argumentBytes, {
    message: `arguments exceed ${HOST_TOOL_LIMITS.argumentBytes} bytes`,
  });

export type HostToolDefinitions = z.infer<typeof HostToolDefinitionsSchema>;
