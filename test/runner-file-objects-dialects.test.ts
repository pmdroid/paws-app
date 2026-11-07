import { afterEach, expect, test } from "bun:test";
import {
  forgetRunnerFileObjectSteps,
  prunableRunnerFileObjectsSteps,
  recordRunnerFileObjectSteps,
  runnerCommandRunsSteps,
  runnerFileObjectNamesSteps,
  type RunnerFileObject,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, json, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const file = (key: string, runId: string, createdAt: number): RunnerFileObject => ({
  key,
  runId,
  commandId: "command-1",
  kind: "artifact",
  name: `${key}.txt`,
  digest: `digest-${key}`,
  sha256: `sha-${key}`,
  createdAt,
});

forEachDialect((connect) => {
  test("a file object records once, keeps its digest, lists its names and prunes with its run", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    await seed(db, (q) =>
      q.orm.insert(q.t.run).values([
        {
          id: "run-ended",
          itemId: "item",
          kind: "implement",
          agent: "codex",
          status: "ended",
          createdAt: 0,
          updatedAt: 10,
        },
        {
          id: "run-active",
          itemId: "item",
          kind: "implement",
          agent: "codex",
          status: "active",
          createdAt: 0,
          updatedAt: 10,
        },
      ]),
    );

    expect(await db.run((q) => recordRunnerFileObjectSteps(q, file("a", "run-ended", 5)))).toBe(
      true,
    );
    expect(await db.run((q) => recordRunnerFileObjectSteps(q, file("a", "run-ended", 5)))).toBe(
      true,
    );
    expect(
      await db.run((q) =>
        recordRunnerFileObjectSteps(q, { ...file("a", "run-ended", 5), sha256: "other" }),
      ),
    ).toBe(false);
    await db.run((q) => recordRunnerFileObjectSteps(q, file("b", "run-active", 5)));
    await db.run((q) => recordRunnerFileObjectSteps(q, file("c", "run-gone", 5)));
    await db.run((q) =>
      recordRunnerFileObjectSteps(q, { ...file("d", "run-gone", 5), name: "a.txt" }),
    );

    expect(
      (await db.run((q) => runnerFileObjectNamesSteps(q, "command-1", "artifact"))).sort(),
    ).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(await db.run((q) => runnerFileObjectNamesSteps(q, "command-1", "input"))).toEqual([]);

    expect((await db.run((q) => prunableRunnerFileObjectsSteps(q, 20))).sort()).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(await db.run((q) => prunableRunnerFileObjectsSteps(q, 20, 1))).toHaveLength(1);
    expect(await db.run((q) => prunableRunnerFileObjectsSteps(q, 5))).toEqual([]);

    await db.run((q) => forgetRunnerFileObjectSteps(q, "a"));
    expect((await db.run((q) => prunableRunnerFileObjectsSteps(q, 20))).sort()).toEqual(["c", "d"]);
  });

  test("runner commands list the runs of run, review and task commands", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const command = (id: string, kind: string, runId: string | null) => ({
      id,
      runnerId: "box",
      runId,
      generation: 1,
      kind,
      envelope: json(db, {}),
      expiresAt: 0,
    });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerCommand)
        .values([
          command("c-run", "run", "run-1"),
          command("c-task", "task", "run-2"),
          command("c-cancel", "cancel", "run-1"),
          command("c-probe", "run", null),
        ]),
    );
    expect(await db.run(runnerCommandRunsSteps)).toEqual([
      { id: "c-run", runId: "run-1" },
      { id: "c-task", runId: "run-2" },
    ]);
  });
});
