import { HostToolDefinitionsSchema } from "../src/runner-protocol";

export const validHostToolDefinitions = (definitions: unknown) =>
  HostToolDefinitionsSchema.safeParse(definitions).success;
