import { afterEach, expect, test } from "bun:test";
import {
  getCandidatePathsSteps,
  hotFilesSteps,
  latestCandidatePathsSteps,
  saveCandidatePathsSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, json, seed, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const save = (db: Db, itemId: string, head: string, paths: string[], recordedAt: number) =>
  db.run((q) => saveCandidatePathsSteps(q, { itemId, head, paths, recordedAt }));

forEachDialect((connect) => {
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
    expect(await db.run(latestCandidatePathsSteps)).toEqual(
      new Map([
        ["ENG-1", ["d.ts"]],
        ["ENG-2", ["y.ts"]],
      ]),
    );
  });

  test("hot files count named conflicts, and the files a returned candidate shared with merges", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    for (const id of ["ENG-1", "ENG-2", "ENG-3"]) await insertWorkItem(db, id);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workItemRepository).values(
          ["ENG-1", "ENG-2", "ENG-3"].map((itemId) => ({
            itemId,
            owner: "Acme",
            repo: "Paws",
            remoteUrl: "https://github.com/acme/paws.git",
          })),
        ),
      (q) =>
        q.orm.insert(q.t.remoteMergeFact).values({
          itemId: "ENG-3",
          repositoryOwner: "acme",
          repositoryName: "paws",
          pullNumber: 1,
          confirmedAt: 1_000,
        }),
      (q) =>
        q.orm.insert(q.t.rebaseReturn).values([
          {
            jobId: 1,
            activationId: 1,
            itemId: "ENG-1",
            candidate: "a1",
            reason: "merge",
            files: json(db, ["src/a.ts", "src/b.ts"]),
            recordedAt: 900,
          },
          {
            jobId: 2,
            activationId: 2,
            itemId: "ENG-2",
            candidate: "b1",
            reason: "github_queue",
            files: null,
            recordedAt: 1_100,
          },
          {
            jobId: 3,
            activationId: 3,
            itemId: "ENG-2",
            candidate: null,
            reason: "merge",
            files: null,
            recordedAt: 1,
          },
        ]),
    );
    await save(db, "ENG-3", "m1", ["src/a.ts", "src/c.ts"], 800);
    await save(db, "ENG-3", "m2", ["src/late.ts"], 1_050);
    await save(db, "ENG-2", "b1", ["src/a.ts", "src/c.ts", "src/d.ts"], 700);

    expect(await db.run((q) => hotFilesSteps(q, 2_000))).toEqual([
      { repository: "Acme/Paws", path: "src/a.ts", conflicts: 2, items: ["ENG-1", "ENG-2"] },
      { repository: "Acme/Paws", path: "src/b.ts", conflicts: 1, items: ["ENG-1"] },
      { repository: "Acme/Paws", path: "src/c.ts", conflicts: 1, items: ["ENG-2"] },
    ]);
    expect(await db.run((q) => hotFilesSteps(q, 900 + 7 * 24 * 60 * 60 * 1000 + 200))).toEqual([]);
  });
});
