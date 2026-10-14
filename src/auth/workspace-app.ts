import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { readSecretFile, writeSecretFile } from "../credentials";
import { loadGitHubAppCredentials } from "../config";

export type ActiveGitHubApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  installationId: string | null;
  generation: number;
};

export function createWorkspaceGitHubActivation(
  db: Database,
  home: string,
  env: Record<string, string | undefined>,
) {
  const path = (id: string) => join(home, "secrets", `github-connect-${id}`);
  function template(): ActiveGitHubApp {
    const app = loadGitHubAppCredentials(home, env);
    if (!app) throw new Error("Configure the GitHub App on the Paws control plane first.");
    const privateKeyPem = readSecretFile(app.privateKeyPath, false);
    if (!privateKeyPem) throw new Error("GitHub App key unavailable.");
    return { ...app, privateKeyPem, generation: 0 };
  }
  return {
    template,
    save(id: string, value: unknown) {
      writeSecretFile(path(id), JSON.stringify(value), true);
    },
    remove(id: string) {
      rmSync(path(id), { force: true });
    },
    read<T>(id: string): T {
      const value = readSecretFile(path(id), false);
      if (!value) throw new Error("GitHub activation secret unavailable.");
      return JSON.parse(value) as T;
    },
    resolve(repository: string): ActiveGitHubApp {
      const rows = db
        .query<{ secret_id: string | null; generation: number; repositories: string }, [string]>(
          "SELECT DISTINCT c.secret_id,c.generation,c.repositories FROM workspace_github_connection c JOIN workspace_repository r ON r.workspace_id=c.workspace_id WHERE lower(r.repository)=lower(?)",
        )
        .all(repository);
      if (rows.length === 0) {
        if (db.query("SELECT 1 FROM workspace LIMIT 1").get())
          throw new Error("Connect the workspace GitHub App first.");
        return template();
      }
      if (
        rows.length !== 1 ||
        !rows[0]!.secret_id ||
        !(JSON.parse(rows[0]!.repositories) as string[]).some(
          (entry) => entry.toLowerCase() === repository.toLowerCase(),
        )
      )
        throw new Error("Workspace GitHub App scope is unavailable.");
      return {
        ...this.read<ActiveGitHubApp>(rows[0]!.secret_id!),
        generation: rows[0]!.generation,
      };
    },
  };
}
