import { join } from "node:path";
import { openSecretAt } from "../credentials";
import { secretRowsSteps, type Db } from "../db";
import { journalCaught } from "../journal";
import { ENV_SETTINGS, type RuntimeConfig } from "../config";

export type LinearSecretSource = "environment" | "settings" | "unset";

export type LinearClientResolution = {
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  client: LinearSecretSource;
  webhook: LinearSecretSource;
  error: string | null;
  pending: boolean;
};

const CLIENT_ROWS = ["linear-browser-client.json", "linear-client.json"];

export async function resolveLinearClient(
  db: Db,
  secretsDir: string,
  source: Record<string, string | undefined> = {},
): Promise<LinearClientResolution> {
  const rows = await db.run(secretRowsSteps);
  const read = (name: string) => {
    const row = rows.find((entry) => entry.name === name);
    return row ? openSecretAt(join(secretsDir, name), row.ciphertext) : null;
  };
  const env = (name: string) => source[name]?.trim() || null;
  const envId = env(ENV_SETTINGS.linear.clientId);
  const envSecret = env(ENV_SETTINGS.linear.clientSecret);
  const envWebhook = env(ENV_SETTINGS.linear.webhookSecret);
  const stored = CLIENT_ROWS.map(read)
    .map((text) => (text === null ? null : storedPair(text)))
    .find((pair) => pair !== null);
  const storedWebhook = read("linear-webhook")?.trim() || null;
  const webhook = {
    webhookSecret: envWebhook ?? storedWebhook,
    webhook: envWebhook ? "environment" : storedWebhook ? "settings" : "unset",
    pending: read("linear-setup-pending") !== null,
  } as const;
  if (envId && envSecret)
    return {
      clientId: envId,
      clientSecret: envSecret,
      client: "environment",
      error: null,
      ...webhook,
    };
  if (envId || envSecret) {
    const [set, other] = envId
      ? [ENV_SETTINGS.linear.clientId, "client secret"]
      : [ENV_SETTINGS.linear.clientSecret, "client id"];
    return {
      clientId: null,
      clientSecret: null,
      client: "unset",
      error: `The Linear client id and secret must come from one source: ${set} is set in the environment, but the ${other} ${stored ? "comes from Settings" : "is not set"}. Set ${ENV_SETTINGS.linear.clientId} and ${ENV_SETTINGS.linear.clientSecret} together, or remove ${set} to use Settings.`,
      ...webhook,
    };
  }
  return stored
    ? { ...stored, client: "settings", error: null, ...webhook }
    : { clientId: null, clientSecret: null, client: "unset", error: null, ...webhook };
}

function storedPair(text: string): { clientId: string; clientSecret: string } | null {
  try {
    const parsed = JSON.parse(text) as { clientId?: unknown; clientSecret?: unknown };
    const { clientId, clientSecret } = parsed;
    return typeof clientId === "string" &&
      clientId &&
      typeof clientSecret === "string" &&
      clientSecret
      ? { clientId, clientSecret }
      : null;
  } catch (error) {
    journalCaught(error, "setup-runtime.storedPair.parse", null);
    return null;
  }
}

export async function browserSetupRuntime(
  db: Db,
  runtime: RuntimeConfig,
  source: Record<string, string | undefined> = {},
) {
  const resolved = await resolveLinearClient(db, join(runtime.env.home, "secrets"), source);
  return {
    pending: resolved.pending,
    runtime: {
      ...runtime,
      linearClientId: resolved.clientId,
      linearClientSecret: resolved.clientSecret,
      env: { ...runtime.env, linearWebhookSecret: resolved.webhookSecret },
    },
  };
}
