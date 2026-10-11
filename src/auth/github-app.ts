import { readSecretFile } from "../credentials";
import {
  loadGitHubAppCredentials,
  pawsPaths,
  saveGitHubAppCredentials,
  writeGitHubAuth,
} from "../config";
import {
  createFetchGitHubClient,
  mintInstallationToken,
  signAppJwt,
  type GitHubClient,
} from "../github";
import { fetchGitHubAccount, openVerificationPage } from "./github-device";
import { createTokenStore } from "./store";
import type { LoginIO } from "./login";

import { authorizeGitHubApp } from "./authorize";

export async function loginGitHubApp(options: LoginIO): Promise<{ login: string; id: number }> {
  const home = options.home ?? options.env?.PAWS_HOME ?? `${process.env.HOME ?? ""}/.paws`;
  const app = loadGitHubAppCredentials(home, options.env ?? process.env);
  if (app === null)
    throw new Error(
      "Set GITHUB_APP_ID, PAWS_GITHUB_CLIENT_ID, PAWS_GITHUB_CLIENT_SECRET, and GITHUB_APP_PRIVATE_KEY_PATH before running paws login github --app.",
    );
  const repo = options.repo;
  if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    throw new Error("Set github.repo or pass paws login github --app --repo owner/name.");
  const [owner, name] = repo.split("/") as [string, string];
  const privateKeyPem = readSecretFile(app.privateKeyPath, false)!;
  const fetchImpl = options.fetch ?? fetch;
  const client = createFetchGitHubClient((url, init) => fetchImpl(String(url), init));
  const jwt = signAppJwt(app.appId, privateKeyPem);
  const registered = await client.request({ method: "GET", path: "/app", token: jwt });
  if (
    registered.status !== 200 ||
    !isRecord(registered.body) ||
    registered.body.client_id !== app.clientId
  )
    throw new Error(
      "The GitHub App private key, app ID, and client ID must belong to the same app.",
    );
  const installation = await client.request({
    method: "GET",
    path: `/repos/${owner}/${name}/installation`,
    token: jwt,
  });
  if (
    installation.status !== 200 ||
    !isRecord(installation.body) ||
    typeof installation.body.id !== "number"
  ) {
    const slug = registered.body.slug;
    const link =
      typeof slug === "string" && /^[a-z0-9-]+$/.test(slug)
        ? `https://github.com/apps/${slug}/installations/new`
        : "https://github.com/settings/installations";
    throw new Error(
      `Install the GitHub App on ${repo} at ${link}, then run paws login github --app again.`,
    );
  }
  const grant = await authorizeGitHubApp({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    fetch: fetchImpl,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async onAuthorize(url) {
      options.stdout?.(`Authorize Paws: ${url}`);
      await (options.openBrowser ?? openVerificationPage)(url);
    },
  });
  const account = await fetchGitHubAccount({
    token: grant.accessToken,
    fetch: fetchImpl,
    app: true,
  });
  const accessible = await client.request({
    method: "GET",
    path: `/repos/${owner}/${name}`,
    token: grant.accessToken,
  });
  if (
    accessible.status !== 200 ||
    !isRecord(accessible.body) ||
    !isRecord(accessible.body.permissions) ||
    accessible.body.permissions.push !== true
  )
    throw new Error(`The signed-in user must have push access to ${repo} through this GitHub App.`);
  const installationId = String(installation.body.id);
  if (
    options.env?.GITHUB_APP_INSTALLATION_ID &&
    options.env.GITHUB_APP_INSTALLATION_ID !== installationId
  )
    throw new Error(
      "GITHUB_APP_INSTALLATION_ID must match the repository's GitHub App installation.",
    );
  await mintInstallationToken({
    client,
    appId: app.appId,
    installationId,
    privateKeyPem,
    owner,
    repo: name,
  });
  await (options.store ?? createTokenStore({ home })).save({
    appId: app.appId,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    scope: "",
    expiresAtMs:
      grant.expiresIn === null ? null : (options.now ?? Date.now)() + grant.expiresIn * 1000,
    login: account.login,
    id: account.id,
    invalid: false,
  });
  saveGitHubAppCredentials(home, { ...app, installationId });
  writeGitHubAuth(pawsPaths(home).configFile, "app", app.clientId, repo);
  return { login: account.login, id: account.id };
}

export async function gitHubAppBot(input: {
  client: GitHubClient;
  appId: string;
  privateKeyPem: string;
  token: string;
}): Promise<{ login: string; id: number }> {
  const app = await input.client.request({
    method: "GET",
    path: "/app",
    token: signAppJwt(input.appId, input.privateKeyPem),
  });
  if (
    app.status !== 200 ||
    !isRecord(app.body) ||
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
    typeof user.body.id !== "number" ||
    !Number.isSafeInteger(user.body.id) ||
    user.body.id <= 0
  )
    throw new Error("Could not read the GitHub App bot account.");
  return { login, id: user.body.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
