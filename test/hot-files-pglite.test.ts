import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "bun:test";
import {
  getCandidatePathsSteps,
  getCandidateRiskSteps,
  latestCandidateRiskSteps,
  latestCandidateRisksSteps,
  hotFilesSteps,
  latestCandidatePathsSteps,
  saveCandidateRiskSteps,
  type Db,
} from "../src/db";
import { describePglite, insertWorkItem, json, seed, type PgliteTestDb } from "./pglite-fixtures";

const open: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const save = (
  db: Db,
  itemId: string,
  head: string,
  paths: string[],
  recordedAt: number,
  base = "base",
) =>
  db.run((q) =>
    saveCandidateRiskSteps(q, {
      itemId,
      head,
      base,
      tier: "normal",
      paths: [],
      changedPaths: paths,
      classifiedAt: recordedAt,
    }),
  );

describePglite((connect) => {
  test("candidate paths are stored per head, sorted and unique, and the latest wins", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await insertWorkItem(db, "ENG-1");
    await insertWorkItem(db, "ENG-2");

    await save(db, "ENG-1", "h1", ["b.ts", "a.ts", "b.ts"], 10);
    await save(db, "ENG-1", "h2", ["c.ts"], 20);
    await save(db, "ENG-1", "h3", ["d.ts"], 20);
    await save(db, "ENG-2", "h1", ["x.ts"], 5);
    await save(db, "ENG-2", "h1", ["y.ts"], 6);

    expect(await db.run((q) => getCandidatePathsSteps(q, "ENG-1", "h1"))).toEqual(["a.ts", "b.ts"]);
    expect(await db.run((q) => getCandidatePathsSteps(q, "ENG-1", "nope"))).toBeNull();
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.candidateRisk)
          .set({ classifiedAt: 100 })
          .where(eq(q.t.candidateRisk.headSha, "h2")),
      ),
    );
    expect((await db.run(latestCandidatePathsSteps)).get("ENG-1")).toEqual(["d.ts"]);
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.candidateRisk).values({
          itemId: "ENG-1",
          headSha: "orphan",
          changedPaths: ["orphan.ts"],
          recordedAt: 30,
        }),
      ),
    );
    expect(await db.run((q) => getCandidateRiskSteps(q, "ENG-1", "orphan"))).toBeNull();
    expect((await db.run((q) => latestCandidateRiskSteps(q, "ENG-1")))?.head).toBe("h2");
    expect((await db.run((q) => latestCandidateRisksSteps(q, ["ENG-1"]))).get("ENG-1")?.head).toBe(
      "h2",
    );
    expect(await db.run((q) => getCandidatePathsSteps(q, "ENG-1", "orphan"))).toEqual([
      "orphan.ts",
    ]);
    expect(await db.run(latestCandidatePathsSteps)).toEqual(
      new Map([
        ["ENG-1", ["orphan.ts"]],
        ["ENG-2", ["y.ts"]],
      ]),
    );
  });

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 30 * DAY;

  async function items(db: Db, ids: string[], repo = "Paws") {
    for (const id of ids) await insertWorkItem(db, id);
    await seed(db, (q) =>
      q.orm.insert(q.t.workItemRepository).values(
        ids.map((itemId) => ({
          itemId,
          owner: "Acme",
          repo,
          remoteUrl: `https://github.com/acme/${repo.toLowerCase()}.git`,
        })),
      ),
    );
  }

  async function merged(db: Db, itemId: string, at: number, paths: string[], repo = "paws") {
    await save(db, itemId, `m-${itemId}`, paths, at - 1);
    await seed(db, (q) =>
      q.orm.insert(q.t.remoteMergeFact).values({
        itemId,
        repositoryOwner: "acme",
        repositoryName: repo,
        pullNumber: 1,
        mergeSha: `sha-${itemId}`,
        confirmedAt: at,
      }),
    );
  }

  let job = 0;
  const returned = (
    db: Db,
    itemId: string,
    reason: string,
    candidate: string | null,
    files: string[] | null,
    recordedAt = NOW - 2_000,
  ) => {
    job += 1;
    return seed(db, (q) =>
      q.orm.insert(q.t.rebaseReturn).values({
        jobId: job,
        activationId: job,
        itemId,
        candidate,
        reason,
        files: files === null ? null : json(db, files),
        recordedAt,
      }),
    );
  };

  test("hot files count recorded files of merge and GitHub queue returns, not push or linear", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await items(db, ["ENG-1", "ENG-2", "ENG-3"]);
    await returned(db, "ENG-1", "push", "a1", ["src/push.ts"]);
    await returned(db, "ENG-1", "linear", "a1", ["src/linear.ts"]);
    await returned(db, "ENG-2", "merge", "b1", ["src/a.ts", "src/b.ts"]);
    await returned(db, "ENG-3", "github_queue", "c1", ["src/a.ts"]);
    await returned(db, "ENG-3", "merge", "c1", ["src/old.ts"], NOW - 8 * DAY);

    expect(await db.run((q) => hotFilesSteps(q, NOW, { conflicts: 1, days: 7 }))).toEqual([
      { repository: "Acme/Paws", path: "src/a.ts", conflicts: 2, items: ["ENG-2", "ENG-3"] },
      { repository: "Acme/Paws", path: "src/b.ts", conflicts: 1, items: ["ENG-2"] },
    ]);
  });

  test("a return without files counts the paths other items merged after its candidate's base", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await items(db, ["OLD", "BASE", "EARLY", "MID", "LATE", "R", "Q", "N"]);
    await items(db, ["OTHER"], "Other");
    const all = ["old", "base", "early", "mid", "late", "other", "self"].map((n) => `src/${n}.ts`);
    await merged(db, "OLD", NOW - 9 * DAY, ["src/old.ts"]);
    await merged(db, "BASE", NOW - 8 * DAY, ["src/base.ts"]);
    await merged(db, "EARLY", NOW - 7.5 * DAY, ["src/early.ts"]);
    await merged(db, "MID", NOW - DAY, ["src/mid.ts"]);
    await merged(db, "LATE", NOW - 1_000, ["src/late.ts"]);
    await merged(db, "OTHER", NOW - DAY, ["src/other.ts"], "other");
    await save(db, "R", "r1", all, NOW - 3 * DAY, "sha-BASE");
    await merged(db, "R", NOW - 2 * DAY, ["src/self.ts"]);
    await save(db, "Q", "q1", ["src/mid.ts", "src/old.ts"], NOW - 3 * DAY, "sha-BASE");
    await save(db, "N", "older", all, NOW - 4 * DAY, "sha-BASE");
    await save(db, "N", "nobase", all, NOW - 3 * DAY, "sha-unknown");
    await seed(db, (q) =>
      q.orm.insert(q.t.candidateRisk).values({
        itemId: "N",
        headSha: "nopaths",
        baseSha: "sha-BASE",
        recordedAt: NOW - 3 * DAY,
      }),
    );
    await returned(db, "R", "merge", "r1", null);
    await returned(db, "Q", "github_queue", "q1", null);
    for (const candidate of [null, "missing", "nopaths", "nobase"])
      await returned(db, "N", "merge", candidate, null);

    expect(await db.run((q) => hotFilesSteps(q, NOW, { conflicts: 1, days: 7 }))).toEqual([
      { repository: "Acme/Paws", path: "src/mid.ts", conflicts: 2, items: ["R", "Q"] },
      { repository: "Acme/Paws", path: "src/early.ts", conflicts: 1, items: ["R"] },
    ]);
  });

  test("a file is hot only with the rule's conflicts inside the rule's days", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await items(db, ["ENG-1", "ENG-2"]);
    await returned(db, "ENG-1", "merge", "a1", ["src/once.ts", "src/twice.ts"]);
    await returned(db, "ENG-2", "merge", "b1", ["src/twice.ts"]);
    await returned(db, "ENG-1", "merge", "a1", ["src/old.ts"], NOW - 2 * DAY);
    await returned(db, "ENG-2", "merge", "b1", ["src/recent.ts"], NOW - 23 * 60 * 60 * 1000);

    const paths = async (rule: { conflicts: number; days: number }) =>
      (await db.run((q) => hotFilesSteps(q, NOW, rule))).map((file) => file.path);
    expect(await paths({ conflicts: 2, days: 7 })).toEqual(["src/twice.ts"]);
    expect(await paths({ conflicts: 1, days: 1 })).toEqual([
      "src/twice.ts",
      "src/once.ts",
      "src/recent.ts",
    ]);
  });
});
