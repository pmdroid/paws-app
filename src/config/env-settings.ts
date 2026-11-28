import type { EnvSource } from "./env";

export const ENV_SETTINGS = {
  github: {
    appId: "GITHUB_APP_ID",
    clientId: "PAWS_GITHUB_CLIENT_ID",
    clientSecret: "PAWS_GITHUB_CLIENT_SECRET",
    privateKeyPath: "GITHUB_APP_PRIVATE_KEY_PATH",
    webhookSecret: "GITHUB_WEBHOOK_SECRET",
  },
  linear: {
    clientId: "LINEAR_CLIENT_ID",
    clientSecret: "LINEAR_CLIENT_SECRET",
    webhookSecret: "LINEAR_WEBHOOK_SECRET",
  },
  slack: {
    clientId: "SLACK_CLIENT_ID",
    clientSecret: "SLACK_CLIENT_SECRET",
    signingSecret: "SLACK_SIGNING_SECRET",
  },
  storage: {
    bucket: "PAWS_S3_BUCKET",
    endpoint: "PAWS_S3_ENDPOINT",
    region: "PAWS_S3_REGION",
    accessKeyId: "PAWS_S3_ACCESS_KEY_ID",
    secretAccessKey: "PAWS_S3_SECRET_ACCESS_KEY",
    sessionToken: "PAWS_S3_SESSION_TOKEN",
  },
  telemetry: { prometheusToken: "PAWS_PROMETHEUS_SD_TOKEN" },
} as const;

export type EnvSettingGroup = keyof typeof ENV_SETTINGS;
export type EnvSettingField<G extends EnvSettingGroup> = keyof (typeof ENV_SETTINGS)[G] & string;
export type SettingSource =
  | { source: "environment"; variable: string }
  | { source: "settings" | "unset" };

function variableOf<G extends EnvSettingGroup>(group: G, field: EnvSettingField<G>): string {
  return (ENV_SETTINGS[group] as Record<string, string>)[field]!;
}

export function envSetting<G extends EnvSettingGroup>(
  env: EnvSource,
  group: G,
  field: EnvSettingField<G>,
): string | undefined {
  const value = env[variableOf(group, field)];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function settingSources<G extends EnvSettingGroup>(
  env: EnvSource,
  group: G,
  stored: Partial<Record<EnvSettingField<G>, unknown>>,
): Record<EnvSettingField<G>, SettingSource> {
  const source = (field: EnvSettingField<G>): SettingSource =>
    envSetting(env, group, field) !== undefined
      ? { source: "environment", variable: variableOf(group, field) }
      : { source: typeof stored[field] === "string" && stored[field] ? "settings" : "unset" };
  const fields = Object.keys(ENV_SETTINGS[group]) as EnvSettingField<G>[];
  return Object.fromEntries(fields.map((field) => [field, source(field)])) as never;
}

export function envSettingRefusal<G extends EnvSettingGroup>(
  env: EnvSource,
  group: G,
  fields: readonly EnvSettingField<G>[] = Object.keys(ENV_SETTINGS[group]) as EnvSettingField<G>[],
): string | null {
  const field = fields.find((name) => envSetting(env, group, name) !== undefined);
  return field === undefined
    ? null
    : `Set by environment variable ${variableOf(group, field)}; remove it from the service environment to edit here`;
}
