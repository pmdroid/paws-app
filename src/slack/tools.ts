type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type HostToolDefinitions = {
  name: string;
  description: string;
  inputSchema: Record<string, Json>;
}[];
type HelperToolAnswer = { text: string; isError?: boolean };
type HelperToolHandler = (name: string, args: Record<string, Json>) => Promise<HelperToolAnswer>;

export type SlackToolRun = {
  workspaceId: string;
  member: { userId: string; linkId: string };
  thread: { teamId: string; channelId: string; threadTs: string; installGeneration: number };
  requestId: string;
};

export type SlackTools = { definitions: HostToolDefinitions; call: HelperToolHandler };

export type SlackToolProvider = (run: SlackToolRun) => SlackTools | null;

const FAILED: HelperToolAnswer = { text: "Paws could not do that.", isError: true };

export function slackRunTools(
  providers: readonly SlackToolProvider[],
  run: SlackToolRun,
): SlackTools | undefined {
  const owners = new Map<string, SlackTools>();
  const definitions: HostToolDefinitions = [];
  for (const provider of providers) {
    const tools = provider(run);
    for (const definition of tools?.definitions ?? []) {
      if (owners.has(definition.name))
        throw new Error(`Two Slack tool providers define ${definition.name}.`);
      owners.set(definition.name, tools!);
      definitions.push(definition);
    }
  }
  if (!definitions.length) return undefined;
  return {
    definitions,
    async call(name, args) {
      const owner = owners.get(name);
      if (!owner) return FAILED;
      try {
        return await owner.call(name, args);
      } catch {
        return FAILED;
      }
    },
  };
}
