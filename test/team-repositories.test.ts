import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceGitHubActivation } from "../src/auth";
import {
  listTeamRepositories,
  refreshRepositoryCatalog,
  teamRepositoryAllowed,
  type Db,
} from "../src/db";
import { seed as insert } from "./dialects";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

const closers = new Map<Db, () => Promise<void>>();

async function seed() {
  const { db, close } = await tempStore();
  closers.set(db, close);
  await insert(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: "acme/linked", teamId: "limited" }),
  );
  return db;
}

function allowed(db: Db, team: string, repository: string): Promise<boolean> {
  return teamRepositoryAllowed(db, "ws", team, repository.toLowerCase());
}

test("a team with linked repositories may only use those", async () => {
  const db = await seed();
  try {
    await refreshRepositoryCatalog(db, async () => [
      {
        owner: "acme",
        repo: "other",
        remoteUrl: "https://github.com/acme/other.git",
        defaultBranch: "main",
      },
    ]);
    expect(await allowed(db, "limited", "acme/linked")).toBe(true);
    expect(await allowed(db, "limited", "ACME/Linked")).toBe(true);
    expect(await allowed(db, "limited", "acme/other")).toBe(false);
  } finally {
    await closers.get(db)!();
  }
});

test("a team without linked repositories may use any repository Paws can access", async () => {
  const db = await seed();
  try {
    await refreshRepositoryCatalog(db, async () => [
      {
        owner: "acme",
        repo: "paws-app",
        remoteUrl: "https://github.com/acme/paws-app.git",
        defaultBranch: "main",
      },
    ]);
    expect(await allowed(db, "open", "acme/paws-app")).toBe(true);
    expect(await allowed(db, "open", "acme/unknown")).toBe(false);
    expect(await allowed(db, "open", "acme/linked")).toBe(false);
  } finally {
    await closers.get(db)!();
  }
});

test("the workspace GitHub App resolves a repository found in the access catalog", async () => {
  const db = await seed();
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
    await insert(db, (q) =>
      q.orm.insert(q.t.workspaceGithubConnection).values({
        workspaceId: "ws",
        generation: 1,
        secretId: "secret-1",
        installationId: "42",
        repositories: JSON.stringify(["acme/linked"]),
      }),
    );
    await refreshRepositoryCatalog(db, async () => [
      {
        owner: "acme",
        repo: "paws-app",
        remoteUrl: "https://github.com/acme/paws-app.git",
        defaultBranch: "main",
      },
    ]);
    expect(await activation.resolve("acme/paws-app")).toMatchObject({ installationId: "42" });
    expect(await activation.resolve("acme/linked")).toMatchObject({ installationId: "42" });
    await expect(activation.resolve("acme/unknown")).rejects.toThrow();
  } finally {
    await closers.get(db)!();
  }
});

test("a session's team links are the repositories it may choose from", async () => {
  const db = await seed();
  try {
    await insert(db, (q) =>
      q.orm.insert(q.t.linearSession).values([
        { sessionId: "limited-session", organizationId: "org", teamId: "limited", createdAt: 0 },
        { sessionId: "open-session", organizationId: "org", teamId: "open", createdAt: 0 },
      ]),
    );
    expect(await listTeamRepositories(db, "limited-session")).toEqual(["acme/linked"]);
    expect(await listTeamRepositories(db, "open-session")).toEqual([]);
  } finally {
    await closers.get(db)!();
  }
});
