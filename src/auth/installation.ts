import { journalCaught } from "../journal";
import { loadGitHubAppCredentials } from "../config";
import { isTransient } from "../core";
import { readSecretFile } from "../credentials";
import {
  createFetchGitHubClient,
  GitHubTokenError,
  mintInstallationToken,
  signAppJwt,
} from "../github";
import type { ActiveGitHubApp } from "./workspace-app";
import type { GitHubFetch } from "./provider";

export function createGitHubInstallationCheck(options: {
  home: string;
  env: Record<string, string | undefined>;
  fetch?: GitHubFetch;
  resolve?: (repository: string) => ActiveGitHubApp;
}) {
  return async (
    repository: string,
    access: "read" | "write",
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    try {
      const app =
        options.resolve?.(repository) ?? loadGitHubAppCredentials(options.home, options.env);
      if (!app?.installationId || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))
        return false;
      const [owner, repo] = repository.split("/") as [string, string];
      const privateKeyPem =
        "privateKeyPem" in app ? app.privateKeyPem : readSecretFile(app.privateKeyPath, false);
      if (!privateKeyPem) return false;
      const client = createFetchGitHubClient((url, init) =>
        (options.fetch ?? fetch)(String(url), { ...init, signal }),
      );
      const jwt = signAppJwt(app.appId, privateKeyPem);
      const registered = await client.request({ method: "GET", path: "/app", token: jwt });
      if (
        registered.status !== 200 ||
        !record(registered.body) ||
        String(registered.body.id) !== app.appId ||
        registered.body.client_id !== app.clientId
      )
        return false;
      const installation = await client.request({
        method: "GET",
        path: `/repos/${owner}/${repo}/installation`,
        token: jwt,
      });
      if (
        installation.status !== 200 ||
        !record(installation.body) ||
        String(installation.body.id) !== app.installationId ||
        installation.body.suspended_at != null
      )
        return false;
      await mintInstallationToken({
        client,
        appId: app.appId,
        installationId: app.installationId,
        privateKeyPem,
        owner,
        repo,
        access,
      });
      signal.throwIfAborted();
      if (
        options.resolve &&
        "generation" in app &&
        JSON.stringify(options.resolve(repository)) !== JSON.stringify(app)
      )
        return false;
      return true;
    } catch (caughtError1) {
      signal.throwIfAborted();
      if (!(caughtError1 instanceof GitHubTokenError) || isTransient(caughtError1))
        throw caughtError1;
      journalCaught(caughtError1, "installation.createGitHubInstallationCheck.resolve", null);
      return false;
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
