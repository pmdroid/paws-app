import type { ActiveGitHubApp } from "../auth";
import { createFetchGitHubClient, INSTALLATION_PERMISSIONS, signAppJwt } from "../github";

export async function discoverGitHubInstallation(
  app: ActiveGitHubApp,
  repositories: string[],
  signal: AbortSignal,
  http: typeof fetch = fetch,
) {
  if (
    repositories.some(
      (repository) =>
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        repository.split("/").some((part) => part === "." || part === ".."),
    )
  )
    throw new Error("Repository access contains an invalid repository name.");
  const client = createFetchGitHubClient((url, init) => http(String(url), { ...init, signal }));
  const token = signAppJwt(app.appId, app.privateKeyPem);
  const registered = await client.request({ method: "GET", path: "/app", token });
  if (
    registered.status !== 200 ||
    !record(registered.body) ||
    String(registered.body.id) !== app.appId ||
    registered.body.client_id !== app.clientId ||
    typeof registered.body.slug !== "string" ||
    !/^[a-z0-9-]+$/.test(registered.body.slug)
  )
    throw new Error("The GitHub App could not be checked.");
  const installationUrl = `https://github.com/apps/${registered.body.slug}/installations/new`;
  let installationId: string | null = null;
  let installed = repositories.length > 0;
  let permissions = true;
  for (const repository of repositories) {
    const response = await client.request({
      method: "GET",
      path: `/repos/${repository.split("/").map(encodeURIComponent).join("/")}/installation`,
      token,
    });
    if (response.status === 404) {
      installed = false;
      continue;
    }
    if (
      response.status !== 200 ||
      !record(response.body) ||
      !Number.isSafeInteger(response.body.id) ||
      Number(response.body.id) <= 0 ||
      String(response.body.app_id) !== app.appId
    )
      throw new Error("The GitHub installation could not be checked.");
    const id = String(response.body.id);
    if (installationId !== null && installationId !== id)
      throw new Error(
        "Ask an owner to review repository access. These repositories use different GitHub installations.",
      );
    installationId = id;
    if (response.body.suspended_at != null) installed = false;
    const granted = response.body.permissions;
    if (
      !record(granted) ||
      Object.entries(INSTALLATION_PERMISSIONS).some(([key, value]) => granted[key] !== value)
    )
      permissions = false;
  }
  signal.throwIfAborted();
  return { installationId, installationUrl, installed, permissions };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
