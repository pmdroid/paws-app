import {
  methods,
  type ClientContext,
  type NewSessionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { ImplementerName } from "../config";

type ModelSelection = { model: string | null; models: Array<{ id: string; name: string }> };

function modelOption(options: SessionConfigOption[] | null | undefined) {
  return options?.find(
    (option) => option.type === "select" && (option.category === "model" || option.id === "model"),
  );
}

export function sessionModel(session: Pick<NewSessionResponse, "configOptions">): ModelSelection {
  const option = modelOption(session.configOptions);
  if (!option || option.type !== "select") return { model: null, models: [] };
  const options = option.options.flatMap((value) => ("group" in value ? value.options : [value]));
  const model = options.some((value) => value.value === option.currentValue)
    ? option.currentValue
    : null;
  return {
    model:
      model && !["default", "auto", "claude", "codex", "grok"].includes(model.toLowerCase())
        ? model
        : null,
    models: options.map(({ value, name }) => ({ id: value, name })),
  };
}

export async function selectSessionModel(
  ctx: ClientContext,
  session: NewSessionResponse,
  selected: string | null,
): Promise<ModelSelection> {
  const initial = sessionModel(session);
  if (selected === null) return initial;
  const option = modelOption(session.configOptions);
  if (!option || !initial.models.some((model) => model.id === selected))
    throw new Error(`Agent does not advertise model ${selected}`);
  const response = await ctx.request(methods.agent.session.setConfigOption, {
    sessionId: session.sessionId,
    configId: option.id,
    value: selected,
  });
  const result = sessionModel(response);
  if (result.model !== selected) throw new Error(`Agent did not confirm model ${selected}`);
  return result;
}

export function providerFor(agent: ImplementerName): string {
  return { claude: "anthropic", codex: "openai", grok: "xai" }[agent];
}
