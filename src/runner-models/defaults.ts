import { z } from "zod";

export type BundledAgent = "claude" | "codex" | "grok";
export type BundledList = Record<BundledAgent, string[]>;

export const BUNDLED_MODELS: Record<
  BundledAgent,
  { models: string[]; efforts: string[]; defaultModel: string }
> = {
  claude: {
    models: ["opus", "fable", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultModel: "fable",
  },
  codex: {
    models: [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultModel: "gpt-6.1-sol",
  },
  grok: {
    models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultModel: "grok-4.7",
  },
};

export const MODELS_DEV_URL = "https://models.dev/api.json";

const sources: Array<{ agent: BundledAgent; provider: string; prefix: string }> = [
  { agent: "claude", provider: "anthropic", prefix: "claude-" },
  { agent: "codex", provider: "openai", prefix: "gpt-" },
  { agent: "grok", provider: "xai", prefix: "grok-" },
];

const ModelsDevSchema = z.record(
  z.string(),
  z.looseObject({ models: z.record(z.string(), z.looseObject({ id: z.string() })).optional() }),
);

export function bundledList(): BundledList {
  return {
    claude: [...BUNDLED_MODELS.claude.models],
    codex: [...BUNDLED_MODELS.codex.models],
    grok: [...BUNDLED_MODELS.grok.models],
  };
}

export function mergeModelsDev(document: unknown): BundledList {
  const providers = ModelsDevSchema.parse(document);
  const list = bundledList();
  for (const { agent, provider, prefix } of sources)
    for (const { id } of Object.values(providers[provider]?.models ?? {}))
      if (id.startsWith(prefix) && !list[agent].includes(id)) list[agent].push(id);
  return list;
}
