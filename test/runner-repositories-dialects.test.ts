import { afterEach, expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  listJobsSteps,
  onJobReady,
  recordRunnerRepositoriesAsync,
  recordRunnerRepositoriesSteps,
  runnerRepositoryListsSteps,
  runnerRepositoryRefusalSteps,
  setRunnerAdminRepositoriesAsync,
  setRunnerAdminRepositoriesSteps,
  type Db,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a runner refuses repositories outside its admin list first, then its host list", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerRepositories).values([
        {
          runnerId: "box",
          repositories: json(db, ["acme/paws", "acme/looky"]),
          reportedAt: 1,
          adminRepositories: json(db, ["Acme/Paws", "acme/other"]),
        },
        { runnerId: "open", repositories: null, reportedAt: 1, adminRepositories: null },
      ]),
    );

    expect(await db.run((q) => runnerRepositoryListsSteps(q, "box"))).toEqual({
      admin: ["Acme/Paws", "acme/other"],
      host: ["acme/paws", "acme/looky"],
    });
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "open"))).toEqual({
      admin: null,
      host: null,
    });
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "unknown"))).toEqual({
      admin: null,
      host: null,
    });

    expect(await db.run((q) => runnerRepositoryRefusalSteps(q, "box", "ACME/paws"))).toBeNull();
    expect(await db.run((q) => runnerRepositoryRefusalSteps(q, "box", "acme/looky"))).toEqual({
      list: "admin",
      allowed: ["Acme/Paws", "acme/other"],
    });
    expect(await db.run((q) => runnerRepositoryRefusalSteps(q, "box", "acme/other"))).toEqual({
      list: "host",
      allowed: ["acme/paws", "acme/looky"],
    });
    expect(
      await db.run((q) => runnerRepositoryRefusalSteps(q, "open", "acme/anything")),
    ).toBeNull();
  });

  test("a changed host list checks the waiting repository question once", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const record = (repositories: string[] | null, at: number) =>
      db.transaction((q) => recordRunnerRepositoriesSteps(q, "box", repositories, at));

    expect(await record(["acme/paws"], 1)).toBe(false);
    await askRepository(db);
    expect(await record(["acme/paws"], 2)).toBe(false);
    expect(await record(["acme/paws", "acme/looky"], 3)).toBe(true);
    expect(await record(null, 4)).toBe(false);
    expect(await record(null, 5)).toBe(false);
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "box"))).toEqual({
      admin: null,
      host: null,
    });
    const jobs = await db.run(listJobsSteps);
    expect(jobs.map((job) => [job.queue, job.payload, job.maxAttempts])).toEqual([
      [JOB_KIND.runnerRepositoryCheck, { runnerId: "box", answeredBy: "runner:box" }, 3],
    ]);
  });

  test("an administrator's list is audited and checks the waiting question", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    await seed(db, (q) =>
      q.orm.insert(q.t.runner).values([runner("box", null), runner("revoked", 1)]),
    );
    const choose = (runnerId: string, repositories: string[] | null, now: number) =>
      db.transaction((q) =>
        setRunnerAdminRepositoriesSteps(q, {
          runnerId,
          workspaceId: "acme",
          userId: "admin",
          repositories,
          now,
        }),
      );

    await askRepository(db);
    expect(await choose("box", ["acme/paws"], 10)).toBe(true);
    expect(await choose("box", ["acme/paws"], 11)).toBe(false);
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "box"))).toEqual({
      admin: ["acme/paws"],
      host: null,
    });
    await expect(choose("revoked", null, 12)).rejects.toThrow("Runner is unavailable.");
    const audit = await db.run(function* (q) {
      const table = q.t.workspaceAccessAudit;
      return yield* q.all(
        q.orm
          .select({ action: table.action, subject: table.subject, createdAt: table.createdAt })
          .from(table)
          .orderBy(table.id),
      );
    });
    expect(audit).toEqual([
      { action: "runner.repositories", subject: "box", createdAt: 10 },
      { action: "runner.repositories", subject: "box", createdAt: 11 },
    ]);
    expect((await db.run(listJobsSteps)).map((job) => job.payload)).toEqual([
      { runnerId: "box", answeredBy: "admin" },
    ]);
  });

  test("the async writers wake the job loop only when they enqueue a check", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    await seed(db, (q) => q.orm.insert(q.t.runner).values(runner("box", null)));
    let woken = 0;
    const stopWake = onJobReady((source) => {
      if (source === db) woken += 1;
    });
    try {
      await recordRunnerRepositoriesAsync(db, "box", ["acme/paws"], 1);
      expect(woken).toBe(0);
      await askRepository(db);
      await recordRunnerRepositoriesAsync(db, "box", ["acme/looky"], 2);
      expect(woken).toBe(1);
      const choice = {
        runnerId: "box",
        workspaceId: "acme",
        userId: "admin",
        repositories: ["acme/paws"],
        now: 3,
      };
      await setRunnerAdminRepositoriesAsync(db, choice);
      expect(woken).toBe(2);
      await setRunnerAdminRepositoriesAsync(db, choice);
      expect(woken).toBe(2);
    } finally {
      stopWake();
    }
  });
});

function runner(id: string, revokedAt: number | null) {
  return {
    id,
    workspaceId: "acme",
    ownerUserId: "owner",
    name: id,
    status: "active",
    createdAt: 0,
    revokedAt,
  };
}

function askRepository(db: Db) {
  return seed(db, (q) =>
    q.orm.insert(q.t.question).values({
      id: "question",
      itemId: "item",
      sessionId: "ses",
      body: "Which runner?",
      kind: "runner-repository",
      status: "open",
      createdAt: 0,
    }),
  );
}
