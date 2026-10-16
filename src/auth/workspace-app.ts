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
    installations(): ActiveGitHubApp[] {
      const rows = db
        .query<{ secret_id: string; generation: number }, []>(
          "SELECT secret_id,generation FROM workspace_github_connection WHERE secret_id IS NOT NULL AND installation_id IS NOT NULL",
        )
        .all();
      if (rows.length === 0 && !db.query("SELECT 1 FROM workspace LIMIT 1").get()) {
        const app = loadGitHubAppCredentials(home, env);
        return app?.installationId ? [template()] : [];
      }
      return rows.map((row) => ({
        ...this.read<ActiveGitHubApp>(row.secret_id),
        generation: row.generation,
      }));
    },
    resolve(repository: string): ActiveGitHubApp {
      const rows = db
        .query<{ secret_id: string | null; generation: number; repositories: string }, [string]>(
          `SELECT DISTINCT c.secret_id,c.generation,c.repositories FROM workspace_github_connection c
           WHERE EXISTS(SELECT 1 FROM workspace_repository r WHERE r.workspace_id=c.workspace_id AND lower(r.repository)=lower(?1))
           OR EXISTS(SELECT 1 FROM repository_catalog k WHERE k.repository=lower(?1))`,
        )
        .all(repository);
      const catalogued =
        db.query("SELECT 1 FROM repository_catalog WHERE repository=lower(?)").get(repository) !==
        null;
      if (rows.length === 0) {
        if (db.query("SELECT 1 FROM workspace LIMIT 1").get())
          throw new Error("Connect the workspace GitHub App first.");
        return template();
      }
      if (
        rows.length !== 1 ||
        !rows[0]!.secret_id ||
        (!catalogued &&
          !(JSON.parse(rows[0]!.repositories) as string[]).some(
            (entry) => entry.toLowerCase() === repository.toLowerCase(),
          ))
      )
        throw new Error("Workspace GitHub App scope is unavailable.");
      return {
        ...this.read<ActiveGitHubApp>(rows[0]!.secret_id!),
        generation: rows[0]!.generation,
      };
    },
  };
}
