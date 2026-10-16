import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceGitHubActivation } from "../src/auth";
import {
  listTeamRepositories,
  refreshRepositoryCatalog,
  teamRepositoryAllowedSql,
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

function seed() {
  const db = tempDb();
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
  );
  db.run(
    "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('ws','acme/linked','limited')",
  );
  return db;
}

function allowed(db: ReturnType<typeof tempDb>, team: string, repository: string): boolean {
  return (
    db
      .query(`SELECT 1 WHERE ${teamRepositoryAllowedSql("?1", "?2", "lower(?3)")}`)
      .get("ws", team, repository) !== null
  );
}

test("a team with linked repositories may only use those", async () => {
  const db = seed();
  try {
    await refreshRepositoryCatalog(db, async () => [
      {
        owner: "acme",
        repo: "other",
        remoteUrl: "https://github.com/acme/other.git",
        defaultBranch: "main",
      },
    ]);
    expect(allowed(db, "limited", "acme/linked")).toBe(true);
    expect(allowed(db, "limited", "ACME/Linked")).toBe(true);
    expect(allowed(db, "limited", "acme/other")).toBe(false);
  } finally {
    db.close();
  }
});

test("a team without linked repositories may use any repository Paws can access", async () => {
  const db = seed();
  try {
    await refreshRepositoryCatalog(db, async () => [
      {
        owner: "acme",
        repo: "paws-app",
        remoteUrl: "https://github.com/acme/paws-app.git",
        defaultBranch: "main",
      },
    ]);
    expect(allowed(db, "open", "acme/paws-app")).toBe(true);
    expect(allowed(db, "open", "acme/unknown")).toBe(false);
    expect(allowed(db, "open", "acme/linked")).toBe(false);
  } finally {
    db.close();
  }
});

test("the workspace GitHub App resolves a repository found in the access catalog", async () => {
  const db = seed();
  const home = tempHome();
  try {
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    const activation = createWorkspaceGitHubActivation(db, home, {});
    activation.save("secret-1", {
      appId: "1",
      clientId: "client",
      clientSecret: "client-secret",
      privateKeyPem: PEM,
      installationId: "42",
      generation: 0,
    });
    db.run(
      `INSERT INTO workspace_github_connection(workspace_id,generation,secret_id,installation_id,repositories)
       VALUES('ws',1,'secret-1','42','["acme/linked"]')`,
    );
    await refreshRepositoryCatalog(db, async () => [
      {
        owner: "acme",
        repo: "paws-app",
        remoteUrl: "https://github.com/acme/paws-app.git",
        defaultBranch: "main",
      },
    ]);
    expect(activation.resolve("acme/paws-app")).toMatchObject({ installationId: "42" });
    expect(activation.resolve("acme/linked")).toMatchObject({ installationId: "42" });
    expect(() => activation.resolve("acme/unknown")).toThrow();
  } finally {
    db.close();
  }
});

test("a session's team links are the repositories it may choose from", () => {
  const db = seed();
  try {
    db.run(
      "INSERT INTO linear_session(session_id,organization_id,team_id,created_at) VALUES('limited-session','org','limited',0),('open-session','org','open',0)",
    );
    expect(listTeamRepositories(db, "limited-session")).toEqual(["acme/linked"]);
    expect(listTeamRepositories(db, "open-session")).toEqual([]);
  } finally {
    db.close();
  }
});
