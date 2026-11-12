import { afterEach, expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  latestRunUpdateSteps,
  readDependencyScopeSteps,
  readDependencySnapshotSteps,
  restartsSinceHumanTurnSteps,
  saveDependencySnapshotSteps,
  type Db,
} from "../src/db";
import { itemDependenciesCurrentSteps, recordItemDependenciesSteps } from "../src/intake";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function seeded(connect: () => Promise<DialectDb>): Promise<Db> {
  const handle = await connect();
  open.push(handle);
  const db = handle.db;
  await withoutForeignKeys(db);
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "a",
        delegationId: "d1",
        linearIssueId: "issue-a",
        linearIdentifier: "PAS-a",
        title: "a",
        state: "queued",
        branchName: "paws/a",
        position: 0,
        sessionKey: "s1",
        createdAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: "s1",
        organizationId: "o1",
        oauthClientId: "c1",
        appUserId: "u1",
        teamId: "t1",
        generation: 7,
        createdAt: 0,
      }),
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "w1", linearOrganizationId: "o1", name: "w", createdAt: 0 }),
    (q) =>
      q.orm.insert(q.t.run).values({
        id: "r1",
        itemId: "a",
        kind: "work",
        agent: "codex",
        status: "active",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_123,
      }),
    (q) =>
      q.orm.insert(q.t.job).values({
        queue: JOB_KIND.resume,
        jobKey: "ci:a:1",
        payload: json(db, { itemId: "a" }),
        status: "done",
        runAt: 0,
        createdAt: 0,
        activationId: 1,
      }),
  );
  return db;
}

forEachDialect((connect) => {
  test("bigint values read through raw sql come back as numbers", async () => {
    const db = await seeded(connect);
    const scope = await db.run((q) => readDependencyScopeSteps(q, "a", "w1"));
    const count = await db.run((q) => restartsSinceHumanTurnSteps(q, "a", "ci:"));
    const at = await db.run((q) => latestRunUpdateSteps(q, ["a"]));
    expect(typeof scope?.cancelRequested).toBe("number");
    expect(typeof scope?.sessionGeneration).toBe("number");
    expect(typeof count).toBe("number");
    expect(typeof at).toBe("number");
    expect([scope?.cancelRequested, scope?.sessionGeneration, count, at]).toEqual([
      0, 7, 1, 1_700_000_000_123,
    ]);
  });

  test("a saved dependency scope matches whether it stored the session generation as text or a number", async () => {
    const db = await seeded(connect);
    const target = { itemId: "a", workspaceId: "w1" };
    await db.run((q) =>
      recordItemDependenciesSteps(
        q,
        { ...target, expectedGeneration: 0 },
        { edges: [], states: new Map(), identifiers: new Map() },
      ),
    );
    const saved = (await db.run((q) => readDependencySnapshotSteps(q, "a")))!;
    for (const generation of ["7", 7]) {
      const scope = JSON.parse(saved.scope) as [unknown, unknown, unknown, Record<string, unknown>];
      scope[3].sessionGeneration = generation;
      await db.run((q) =>
        saveDependencySnapshotSteps(q, { ...saved, ...target, scope: JSON.stringify(scope) }),
      );
      expect(await db.run((q) => itemDependenciesCurrentSteps(q, target))).toBe(true);
    }
  });
});
