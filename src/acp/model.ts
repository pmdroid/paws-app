import {
  methods,
  type ClientContext,
  type NewSessionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { AgentProfile, ImplementerName } from "../config";
import { isOneMillionModel, standardModelId, type ModelChoice } from "../core";

type ModelSelection = { model: string | null; models: ModelChoice[] };

function concreteModel(model: string): boolean {
  return !["default", "auto", "claude", "codex", "grok"].includes(model.toLowerCase());
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
      ...(typeof description === "string" && description ? { description } : {}),
    })),
  };
}

/** The Linear line for a 1M profile that ran with the standard window. */
export function standardWindowNotice(name: string): string {
  return `${name} ran with the standard window: this runner's Claude account doesn't offer 1M.`;
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
    /** Set when the profile asked for a 1M entry this session does not list. */
    standardWindow?: ModelChoice;
  }
> {
  let configuration = session;
  const modelConfig = modelOption(configuration.configOptions);
  let selectedModel = profile.model;
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
  let standardWindow: ModelChoice | undefined;
  if (selectedModel !== null) {
    const advertised = sessionModel(configuration).models;
    const standard = standardModelId(selectedModel);
    if (modelConfig && standard && !advertised.some((model) => model.id === selectedModel)) {
      standardWindow = advertised.find(
        (model) => model.id === standard && !isOneMillionModel(model),
      );
      if (standardWindow) selectedModel = standardWindow.id;
    }
    if (!modelConfig || !advertised.some((model) => model.id === selectedModel))
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

export function providerFor(agent: ImplementerName): string {
  return { claude: "anthropic", codex: "openai", grok: "xai" }[agent];
}
