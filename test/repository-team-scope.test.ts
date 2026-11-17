import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  listRepositoryCandidatesSteps,
  refreshRepositoryCatalog,
  sessionRepositoriesAllowedSteps,
  teamRepositoryAllowedSql,
  teamRepositoryAllowedSteps,
  type Db,
} from "../src/db";
import { describePglite, seed } from "./pglite-fixtures";

const catalog = ["app", "other"].map((repo) => ({
  owner: "acme",
  repo,
  remoteUrl: `https://github.com/acme/${repo}.git`,
  defaultBranch: "main",
}));

async function prepare(db: Db, mapped: boolean) {
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "Acme", createdAt: 1 }),
    (q) =>
      q.orm.insert(q.t.linearSession).values([
        { sessionId: "repo-session", organizationId: "org", teamId: "repo:42", createdAt: 1 },
        {
          sessionId: "linear-session",
          organizationId: "org",
          teamId: "8f0c5a3e-0d1b-4c55-9a51-3f2f1f6a7b10",
          createdAt: 1,
        },
      ]),
  );
  if (mapped)
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: "acme/app", teamId: "repo:42" }),
    );
  await refreshRepositoryCatalog(db, async () => catalog);
}

function allowedSteps(db: Db, team: string, repository: string) {
  return db.run((q) => teamRepositoryAllowedSteps(q, "ws", team, repository));
}

async function allowedSql(db: Db, team: string, repository: string) {
  return db.run(function* (q) {
    const rows = yield* q.all(
      q.orm
        .select({ one: sql`1` })
        .from(q.t.workspace)
        .where(
          sql`workspace.id = 'ws' AND ${sql.raw(
            teamRepositoryAllowedSql("workspace.id", `'${team}'`, `'${repository}'`),
          )}`,
        ),
    );
    return rows.length > 0;
  });
}

describePglite((open) => {
  test("a repository team with no mapping is denied every catalog repository", async () => {
    const { db, close } = await open();
    try {
      await prepare(db, false);
      for (const repository of ["acme/app", "acme/other"]) {
        expect(await allowedSteps(db, "repo:42", repository)).toBe(false);
        expect(await allowedSql(db, "repo:42", repository)).toBe(false);
      }
      expect(
        await db.run((q) =>
          sessionRepositoriesAllowedSteps(q, ["repo-session"], ["acme/app", "acme/other"]),
        ),
      ).toEqual(new Set());
      expect(
        await db.run((q) =>
          listRepositoryCandidatesSteps(q, "repo-session", [
            { owner: "acme", repo: "configured", remoteUrl: "https://github.com/acme/configured" },
          ]),
        ),
      ).toEqual([]);
    } finally {
      await close();
    }
  });

  test("a repository team mapped to a repository is allowed only that one", async () => {
    const { db, close } = await open();
    try {
      await prepare(db, true);
      expect(await allowedSteps(db, "repo:42", "acme/app")).toBe(true);
      expect(await allowedSteps(db, "repo:42", "acme/other")).toBe(false);
      expect(await allowedSql(db, "repo:42", "acme/app")).toBe(true);
      expect(await allowedSql(db, "repo:42", "acme/other")).toBe(false);
      expect(
        await db.run((q) =>
          sessionRepositoriesAllowedSteps(q, ["repo-session"], ["acme/app", "acme/other"]),
        ),
      ).toEqual(new Set(["acme/app"]));
      expect(await db.run((q) => listRepositoryCandidatesSteps(q, "repo-session", []))).toEqual([
        { owner: "acme", repo: "app", remoteUrl: "https://github.com/acme/app.git" },
      ]);
    } finally {
      await close();
    }
  });

  test("a Linear team with no mapping keeps every catalog repository", async () => {
    const { db, close } = await open();
    try {
      await prepare(db, true);
      const team = "8f0c5a3e-0d1b-4c55-9a51-3f2f1f6a7b10";
      expect(await allowedSteps(db, team, "acme/other")).toBe(true);
      expect(await allowedSql(db, team, "acme/other")).toBe(true);
      expect(
        await db.run((q) =>
          sessionRepositoriesAllowedSteps(q, ["linear-session"], ["acme/app", "acme/other"]),
        ),
      ).toEqual(new Set(["acme/app", "acme/other"]));
      expect(
        (await db.run((q) => listRepositoryCandidatesSteps(q, "linear-session", []))).map(
          (candidate) => candidate.repo,
        ),
      ).toEqual(["app", "other"]);
    } finally {
      await close();
    }
  });
});
