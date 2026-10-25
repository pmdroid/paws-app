import type { AppBotIdentity } from "../core";
import { signAppJwt, type GitHubClient } from "../github";

export async function gitHubAppBot(input: {
  client: GitHubClient;
  appId: string;
  privateKeyPem: string;
  token: string;
}): Promise<AppBotIdentity> {
  const app = await input.client.request({
    method: "GET",
    path: "/app",
    token: signAppJwt(input.appId, input.privateKeyPem),
  });
  if (
    app.status !== 200 ||
    !isRecord(app.body) ||
    typeof app.body.id !== "number" ||
    !Number.isSafeInteger(app.body.id) ||
    app.body.id <= 0 ||
    String(app.body.id) !== input.appId ||
    typeof app.body.slug !== "string" ||
    !/^[a-z0-9-]+$/.test(app.body.slug)
  )
    throw new Error("Could not read the GitHub App identity.");
  const login = `${app.body.slug}[bot]`;
  const user = await input.client.request({
    method: "GET",
    path: `/users/${encodeURIComponent(login)}`,
    token: input.token,
  });
  if (
    user.status !== 200 ||
    !isRecord(user.body) ||
    user.body.login !== login ||
    user.body.type !== "Bot" ||
    typeof user.body.id !== "number" ||
    !Number.isSafeInteger(user.body.id) ||
    user.body.id <= 0
  )
    throw new Error("Could not read the GitHub App bot account.");
  return { appId: input.appId, login, id: user.body.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
