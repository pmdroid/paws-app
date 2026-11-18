import { join } from "node:path";
import { pawsPaths } from "../config";
import {
  readCredentialSteps,
  readScopedCredentialSteps,
  readSecretFile,
  refreshCredential,
  writeCredentialSteps,
  writeScopedCredentialSteps,
  saveSecret,
} from "../credentials";
import { type Db, type Q, type Steps } from "../db";
import { authorizeSlack } from "./authorize";

export const SLACK_BOT_SCOPES = "chat:write,im:write,users:read,users:read.email,channels:read";
export type SlackApp = { clientId: string; clientSecret: string; signingSecret: string };
export type SlackToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
  scope: string;
  teamId: string;
  botUserId: string;
  appId?: string | null;
  teamName?: string | null;
};
export type SlackInstallationKey = { workspaceId: string; teamId: string };
export type SlackFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function readSlackApp(home: string): SlackApp | null {
  return readJson<SlackApp>(home, "slack-app.json");
}

export function resolveSlackApp(
  home: string,
  env: Record<string, string | undefined>,
): SlackApp | null {
  const stored = readSlackApp(home);
  const clientId = env.SLACK_CLIENT_ID ?? stored?.clientId;
  const clientSecret = env.SLACK_CLIENT_SECRET ?? stored?.clientSecret;
  const signingSecret = env.SLACK_SIGNING_SECRET ?? stored?.signingSecret;
  return clientId && clientSecret && signingSecret
    ? { clientId, clientSecret, signingSecret }
    : null;
}

export function slackCredentialKey(installation: SlackInstallationKey) {
  return {
    kind: "slack" as const,
    workspace: `${installation.workspaceId}:${installation.teamId}`,
  };
}

function* readSlackTokenSteps(q: Q, home: string): Steps<SlackToken | null> {
  return parseJson<SlackToken>(yield* readCredentialSteps(q, pawsPaths(home).secretsDir, "slack"));
}

export function* readInstalledSlackTokenSteps(
  q: Q,
  home: string,
  installation: SlackInstallationKey,
): Steps<SlackToken | null> {
  return parseJson<SlackToken>(
    yield* readScopedCredentialSteps(
      q,
      pawsPaths(home).secretsDir,
      slackCredentialKey(installation),
    ),
  );
}

export function* writeInstalledSlackTokenSteps(
  q: Q,
  home: string,
  installation: SlackInstallationKey,
  token: SlackToken,
): Steps<boolean> {
  return yield* writeScopedCredentialSteps(
    q,
    pawsPaths(home).secretsDir,
    slackCredentialKey(installation),
    JSON.stringify(token),
  );
}

export function readSlackToken(store: Db, home: string): Promise<SlackToken | null> {
  return store.run((q) => readSlackTokenSteps(q, home));
}

function writeSlackTokenSteps(q: Q, home: string, token: SlackToken): Steps<boolean> {
  return writeCredentialSteps(q, pawsPaths(home).secretsDir, "slack", JSON.stringify(token));
}

export async function loginSlack(input: {
  db: Db;
  home: string;
  env: Record<string, string | undefined>;
  port?: number;
  timeoutMs?: number;
  fetch?: SlackFetch;
  onAuthorize: (url: string, port: number) => void | Promise<void>;
}): Promise<SlackToken> {
  const app = resolveSlackApp(input.home, input.env);
  if (!app)
    throw new Error(
      "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET before paws login slack.",
    );
  const publicUrl = input.env.PAWS_PUBLIC_URL;
  if (!publicUrl)
    throw new Error(
      "Set PAWS_PUBLIC_URL to the public HTTPS origin of Paws before paws login slack.",
    );
  const token = await authorizeSlack({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    redirectUri: new URL("/oauth/slack/callback", publicUrl).href,
    port: input.port ?? Number(input.env.PAWS_PORT ?? 8787),
    onAuthorize: input.onAuthorize,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  await saveSecret(join(pawsPaths(input.home).secretsDir, "slack-app.json"), JSON.stringify(app));
  await input.db.run((q) => writeSlackTokenSteps(q, input.home, token));
  return token;
}

export function createSlackAuth(input: {
  home: string;
  db: Db;
  fetch?: SlackFetch;
  installation?: SlackInstallationKey;
  env?: Record<string, string | undefined>;
}) {
  const installation = input.installation;
  const missing = installation
    ? "Reconnect Slack in Workspace › Integrations."
    : "Run paws login slack.";
  const read = (q: Q) =>
    installation
      ? readInstalledSlackTokenSteps(q, input.home, installation)
      : readSlackTokenSteps(q, input.home);
  return {
    async ensureFresh(): Promise<string> {
      const current = await input.db.run(read);
      if (current === null) throw new Error(missing);
      if (current.expiresAtMs === null || current.expiresAtMs > Date.now() + 60_000)
        return current.accessToken;
      const app = resolveSlackApp(input.home, input.env ?? {});
      if (app === null) throw new Error(missing);
      const saved = await refreshCredential({
        db: input.db,
        identity: installation ? slackCredentialKey(installation).workspace : "slack",
        read,
        write: (q, token) =>
          installation
            ? writeInstalledSlackTokenSteps(q, input.home, installation, token)
            : writeSlackTokenSteps(q, input.home, token),
        refresh: (token, signal) =>
          requestSlackToken(
            app,
            new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: token.refreshToken!,
            }),
            input.fetch ?? fetch,
            signal,
            token,
            installation ? [] : undefined,
          ),
      });
      return saved.accessToken;
    },
  };
}

export async function requestSlackToken(
  app: Pick<SlackApp, "clientId" | "clientSecret">,
  body: URLSearchParams,
  fetchImpl: SlackFetch,
  signal: AbortSignal,
  previous?: SlackToken,
  required: readonly string[] = SLACK_BOT_SCOPES.split(","),
): Promise<SlackToken> {
  const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
    },
    body,
  });
  if (!response.ok) throw new Error("Slack token exchange failed.");
  const data: unknown = await response.json();
  if (
    !isRecord(data) ||
    data.ok !== true ||
    data.token_type !== "bot" ||
    !nonempty(data.access_token)
  )
    throw new Error("Slack did not return a bot token.");
  const scope = nonempty(data.scope) ? data.scope : (previous?.scope ?? "");
  const scopes = new Set(scope.split(/[ ,]+/));
  if (!required.every((name) => scopes.has(name)))
    throw new Error("Slack did not grant the required bot scopes.");
  const teamId = isRecord(data.team) && nonempty(data.team.id) ? data.team.id : previous?.teamId;
  const botUserId = nonempty(data.bot_user_id) ? data.bot_user_id : previous?.botUserId;
  if (!teamId || !botUserId) throw new Error("Slack did not identify the workspace and bot.");
  if (previous && (teamId !== previous.teamId || botUserId !== previous.botUserId))
    throw new Error("Slack refresh returned a different installation.");
  const refreshToken = nonempty(data.refresh_token) ? data.refresh_token : null;
  const expiry = data.expires_in;
  if (refreshToken !== null || previous?.refreshToken != null || expiry !== undefined) {
    if (!refreshToken || typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0)
      throw new Error("Slack did not return a rotating token and expiry.");
  }
  return {
    accessToken: data.access_token,
    refreshToken,
    scope,
    teamId,
    botUserId,
    expiresAtMs: typeof expiry === "number" ? Date.now() + expiry * 1000 : null,
    appId: nonempty(data.app_id) ? data.app_id : (previous?.appId ?? null),
    teamName:
      isRecord(data.team) && typeof data.team.name === "string"
        ? data.team.name
        : (previous?.teamName ?? null),
  };
}

function readJson<T>(home: string, name: string): T | null {
  return parseJson<T>(readSecretFile(join(pawsPaths(home).secretsDir, name)));
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error();
    return value as T;
  } catch {
    throw new Error("Slack credentials are unreadable. Run paws login slack.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/\s/.test(value);
}
