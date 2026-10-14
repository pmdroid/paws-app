import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ActiveGitHubApp } from "./workspace-app";
import { createFetchGitHubClient, mintInstallationToken, signAppJwt } from "../github";

export function githubAppAuthorization(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: hash(input.verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}
export const newGitHubOAuthSecret = () => ({
  state: randomBytes(32).toString("base64url"),
  verifier: randomBytes(32).toString("base64url"),
  id: randomUUID(),
});
export const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

export async function verifyHostedGitHubApp(input: {
  app: ActiveGitHubApp;
  installationId: string;
  repositories: string[];
  code: string;
  verifier: string;
  redirectUri: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<{ login: string; id: number }> {
  const user = await authorizeHostedGitHubUser(input);
  await verifyHostedGitHubRepositories({ ...input, user });
  return { login: user.login, id: user.id };
}

export async function authorizeHostedGitHubUser(input: {
  app: ActiveGitHubApp;
  code: string;
  verifier: string;
  redirectUri: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<{ login: string; id: number; token: string }> {
  const fetchImpl = input.fetch ?? fetch;
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "error",
    signal: input.signal,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  const grant: unknown = await response.json();
  if (
    !response.ok ||
    !record(grant) ||
    typeof grant.access_token !== "string" ||
    !grant.access_token ||
    /\s/.test(grant.access_token) ||
    grant.error
  )
    throw new Error("GitHub authorization exchange failed.");
  const client = createFetchGitHubClient((url, init) =>
    fetchImpl(String(url), { ...init, signal: input.signal, redirect: "error" }),
  );
  const user = await client.request({ method: "GET", path: "/user", token: grant.access_token });
  if (
    user.status !== 200 ||
    !record(user.body) ||
    typeof user.body.id !== "number" ||
    !Number.isSafeInteger(user.body.id) ||
    user.body.id <= 0 ||
    typeof user.body.login !== "string"
  )
    throw new Error("GitHub identity unavailable.");
  return { login: user.body.login, id: user.body.id, token: grant.access_token };
}

export async function verifyHostedGitHubRepositories(input: {
  app: ActiveGitHubApp;
  installationId: string;
  repositories: string[];
  user: { login: string; id: number; token: string };
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetch ?? fetch;
  const client = createFetchGitHubClient((url, init) =>
    fetchImpl(String(url), { ...init, signal: input.signal, redirect: "error" }),
  );
  const jwt = signAppJwt(input.app.appId, input.app.privateKeyPem);
  const app = await client.request({ method: "GET", path: "/app", token: jwt });
  if (
    app.status !== 200 ||
    !record(app.body) ||
    String(app.body.id) !== input.app.appId ||
    app.body.client_id !== input.app.clientId
  )
    throw new Error("GitHub App identity mismatch.");
  for (const repository of input.repositories) {
    const installation = await client.request({
      method: "GET",
      path: `/repos/${repository}/installation`,
      token: jwt,
    });
    if (
      installation.status !== 200 ||
      !record(installation.body) ||
      String(installation.body.id) !== input.installationId ||
      installation.body.suspended_at != null
    )
      throw new Error("GitHub installation does not match workspace intent.");
    const access = await client.request({
      method: "GET",
      path: `/repos/${repository}`,
      token: input.user.token,
    });
    if (
      access.status !== 200 ||
      !record(access.body) ||
      !record(access.body.permissions) ||
      access.body.permissions.admin !== true ||
      !record(access.body.owner)
    )
      throw new Error("GitHub repository administration required.");
    const owner = access.body.owner;
    if (owner.type === "Organization") {
      const membership = await client.request({
        method: "GET",
        path: `/user/memberships/orgs/${repository.split("/")[0]}`,
        token: input.user.token,
      });
      if (
        membership.status !== 200 ||
        !record(membership.body) ||
        membership.body.state !== "active" ||
        membership.body.role !== "admin"
      )
        throw new Error("GitHub organization installation authority required.");
    } else if (owner.type !== "User" || owner.id !== input.user.id)
      throw new Error("GitHub installation owner required.");
    const [ownerName, repo] = repository.split("/") as [string, string];
    await mintInstallationToken({
      client,
      appId: input.app.appId,
      privateKeyPem: input.app.privateKeyPem,
      installationId: input.installationId,
      owner: ownerName,
      repo,
    });
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
