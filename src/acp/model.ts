import {
  methods,
  type ClientContext,
  type NewSessionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { AgentProfile, ImplementerName } from "../config";

export type SessionModelChoice = { id: string; name: string; description?: string };
type ModelSelection = { model: string | null; models: SessionModelChoice[] };

function concreteModel(model: string): boolean {
  return !["default", "auto", "claude", "codex", "grok", "opencode"].includes(model.toLowerCase());
}

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
    model: model && concreteModel(model) ? model : null,
    models: options.map(({ value, name, description }) => ({
      id: value,
      name,
      ...(description?.trim() ? { description: description.trim().slice(0, 512) } : {}),
    })),
  };
}

function effortOption(options: SessionConfigOption[] | null | undefined) {
  return options?.find(
    (option) =>
      option.type === "select" &&
      (option.category === "thought_level" ||
        ["effort", "reasoning_effort", "thought_level"].includes(option.id)),
  );
}

export async function selectSessionProfile(
  ctx: ClientContext,
  session: NewSessionResponse,
  profile: AgentProfile,
): Promise<
  ModelSelection & {
    effort: string | null;
    efforts: Array<{ id: string; name: string }>;
    /** Set when the profile's 1M entry was missing and its standard model ran instead. */
    standardWindow?: { requested: string; name: string };
  }
> {
  let configuration = session;
  const modelConfig = modelOption(configuration.configOptions);
  let selectedModel = profile.model;
  let standardWindow: { requested: string; name: string } | undefined;
  if (selectedModel !== null && /\[1m\]$/i.test(selectedModel)) {
    const advertised = sessionModel(session).models;
    const standard = advertised.find((model) => model.id === selectedModel!.slice(0, -4));
    if (standard && !advertised.some((model) => model.id === selectedModel)) {
      standardWindow = { requested: selectedModel, name: standard.name };
      selectedModel = standard.id;
    }
  }
  if (
    selectedModel === null &&
    sessionModel(session).model === null &&
    modelConfig?.type === "select"
  ) {
    const models = modelConfig.options.flatMap((value) =>
      "group" in value ? value.options : [value],
    );
    const description = models.find(
      (value) => value.value === modelConfig.currentValue,
    )?.description;
    const matches = models.filter(
      (value) =>
        concreteModel(value.value) && (value.value === description || value.name === description),
    );
    if (matches.length === 1) selectedModel = matches[0]!.value;
  }
  if (selectedModel !== null) {
    if (
      !modelConfig ||
      !sessionModel(configuration).models.some((model) => model.id === selectedModel)
    )
      throw new Error(`Agent does not advertise model ${selectedModel}`);
    const response = await ctx.request(methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: modelConfig.id,
      value: selectedModel,
    });
    configuration = { ...session, ...response };
    if (sessionModel(configuration).model !== selectedModel)
      throw new Error(`Agent did not confirm model ${selectedModel}`);
  }
  const model = sessionModel(configuration);
  let option = effortOption(configuration.configOptions);
  const efforts =
    option?.type === "select"
      ? option.options
          .flatMap((value) => ("group" in value ? value.options : [value]))
          .map(({ value, name }) => ({ id: value, name }))
      : [];
  if (profile.effort !== undefined) {
    if (!option || !efforts.some((effort) => effort.id === profile.effort))
      throw new Error(`Agent does not advertise effort ${profile.effort} for the selected model`);
    const response = await ctx.request(methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: option.id,
      value: profile.effort,
    });
    option = effortOption(response.configOptions);
    if (option?.type !== "select" || option.currentValue !== profile.effort)
      throw new Error(`Agent did not confirm effort ${profile.effort}`);
    if (sessionModel(response).model !== model.model)
      throw new Error("Agent changed model while selecting effort");
  }
  return {
    ...model,
    effort: option?.type === "select" ? option.currentValue : null,
    efforts,
    ...(standardWindow ? { standardWindow } : {}),
  };
}

/** The Linear line for a run whose 1M entry this runner's account does not offer. */
export function standardWindowNotice(name: string): string {
  return `${name} ran with the standard window: this runner's Claude account doesn't offer 1M.`;
}

export function providerFor(agent: ImplementerName): string {
  return { claude: "anthropic", codex: "openai", grok: "xai", opencode: "opencode" }[
    agent
  ] as string;
}
