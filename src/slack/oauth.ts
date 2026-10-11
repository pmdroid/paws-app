import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { pawsPaths } from "../config";
import { readSecretFile, refreshCredential, writeSecretFile } from "../credentials";
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
};
export type SlackFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function readSlackApp(home: string): SlackApp | null {
  return readJson<SlackApp>(home, "slack-app.json");
}

export function readSlackToken(home: string): SlackToken | null {
  return readJson<SlackToken>(home, "slack-oauth.json");
}

export async function loginSlack(input: {
  home: string;
  env: Record<string, string | undefined>;
  port?: number;
  timeoutMs?: number;
  fetch?: SlackFetch;
  onAuthorize: (url: string, port: number) => void | Promise<void>;
}): Promise<SlackToken> {
  const stored = readSlackApp(input.home);
  const app = {
    clientId: input.env.SLACK_CLIENT_ID ?? stored?.clientId,
    clientSecret: input.env.SLACK_CLIENT_SECRET ?? stored?.clientSecret,
    signingSecret: input.env.SLACK_SIGNING_SECRET ?? stored?.signingSecret,
  };
  if (!app.clientId || !app.clientSecret || !app.signingSecret)
    throw new Error(
      "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET before paws login slack.",
    );
  const publicUrl = input.env.PAWS_PUBLIC_URL;
  if (!publicUrl)
    throw new Error(
      "Set PAWS_PUBLIC_URL to the HTTPS tunnel forwarding to Paws before paws login slack.",
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
  writeSecretFile(join(pawsPaths(input.home).secretsDir, "slack-app.json"), JSON.stringify(app));
  writeSecretFile(
    join(pawsPaths(input.home).secretsDir, "slack-oauth.json"),
    JSON.stringify(token),
  );
  return token;
}

export function createSlackAuth(input: { home: string; db: Database; fetch?: SlackFetch }) {
  return {
    async ensureFresh(): Promise<string> {
      const current = readSlackToken(input.home);
      if (current === null) throw new Error("Run paws login slack.");
      if (current.expiresAtMs === null || current.expiresAtMs > Date.now() + 60_000)
        return current.accessToken;
      const app = readSlackApp(input.home);
      if (app === null) throw new Error("Run paws login slack.");
      const path = join(pawsPaths(input.home).secretsDir, "slack-oauth.json");
      const saved = await refreshCredential({
        db: input.db,
        identity: path,
        read: () => readSlackToken(input.home),
        write: (token) => writeSecretFile(path, JSON.stringify(token)),
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
  if (!SLACK_BOT_SCOPES.split(",").every((required) => scopes.has(required)))
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
  };
}

function readJson<T>(home: string, name: string): T | null {
  const text = readSecretFile(join(pawsPaths(home).secretsDir, name));
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
