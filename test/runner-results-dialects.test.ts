import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  insertRunnerFollowUpSteps,
  insertRunnerQuestionAnswerSteps,
  insertRunnerResultSteps,
  itemRunnerFollowUpTargetSteps,
  runnerEventPageSteps,
  runnerFollowUpsAfterSteps,
  runnerQuestionAnswersAfterSteps,
  runnerResultForCommandSteps,
  runnerResultMatchesSteps,
  storedRunnerAnswerSteps,
  storedRunnerEventSteps,
  unansweredRunnerQuestionsSteps,
  type Db,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItemSteps,
  json,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";
import { seedRunner, seedWork } from "./runner-rows";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

const key = { runId: "run", generation: 1 };

function seedEvent(db: Db, sequence: number, row: { type?: string; keyId?: string } = {}) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerEvent).values({
      ...key,
      sequence,
      payload: json(db, { sequence }),
      receivedAt: 0,
      ...row,
    }),
  );
}

forEachDialect((connect) => {
  test("a run's result is stored once and read back for its command", async () => {
    const db = await connected(connect);
    const payload = JSON.stringify({ commandId: "command", role: "implementer", ok: true });

    expect(await db.run((q) => runnerResultMatchesSteps(q, key, payload))).toBeNull();
    await db.run((q) =>
      insertRunnerResultSteps(q, { ...key, commandId: "command", payload, receivedAt: 5 }),
    );
    expect(await db.run((q) => runnerResultMatchesSteps(q, key, payload))).toBe(true);
    expect(await db.run((q) => runnerResultMatchesSteps(q, key, '{"ok":false}'))).toBe(false);
    const stored = await db.run((q) => runnerResultForCommandSteps(q, key, "command"));
    expect(JSON.parse(stored!)).toEqual(JSON.parse(payload));
    expect(await db.run((q) => runnerResultForCommandSteps(q, key, "other"))).toBeNull();
  });

  test("a run's events, questions and answers page in sequence order", async () => {
    const db = await connected(connect);
    await seedEvent(db, 1, { type: "activity", keyId: "k" });
    await seedEvent(db, 2, { type: "question", keyId: "k" });
    await seedEvent(db, 3);
    await seedEvent(db, 4, { type: "artifact", keyId: "k" });
    await seedEvent(db, 5, { type: "ci_rerun", keyId: "k" });
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerEvent).values({
        runId: "run",
        generation: 2,
        sequence: 1,
        payload: json(db, {}),
        receivedAt: 0,
        type: "question",
      }),
    );

    const page = await db.run((q) => runnerEventPageSteps(q, key, 1));
    expect(page.map((row) => row.sequence)).toEqual([2, 3, 4, 5]);
    expect(page[0]).toEqual({
      runId: "run",
      generation: 1,
      sequence: 2,
      payload: expect.any(String),
      keyId: "k",
      payloadSha256: null,
    });
    expect(JSON.parse(page[0]!.payload)).toEqual({ sequence: 2 });
    expect((await db.run((q) => storedRunnerEventSteps(q, key, 4)))?.sequence).toBe(4);
    expect(await db.run((q) => storedRunnerEventSteps(q, key, 9))).toBeNull();

    const types = ["question", "artifact", "closeout_policy", "ci_rerun"];
    expect(await db.run((q) => storedRunnerAnswerSteps(q, key, 2))).toBeNull();
    await db.run((q) =>
      insertRunnerQuestionAnswerSteps(q, { ...key, sequence: 2, answer: "yes", createdAt: 1 }),
    );
    await db.run((q) =>
      insertRunnerQuestionAnswerSteps(q, { ...key, sequence: 5, answer: "rerun", createdAt: 1 }),
    );
    expect(await db.run((q) => storedRunnerAnswerSteps(q, key, 2))).toBe("yes");
    const unanswered = await db.run((q) => unansweredRunnerQuestionsSteps(q, key, types));
    expect(unanswered.map((row) => row.sequence)).toEqual([3, 4]);
    expect(await db.run((q) => runnerQuestionAnswersAfterSteps(q, key, 0))).toEqual([
      { sequence: 2, answer: "yes" },
      { sequence: 5, answer: "rerun" },
    ]);
    expect(await db.run((q) => runnerQuestionAnswersAfterSteps(q, key, 2))).toEqual([
      { sequence: 5, answer: "rerun" },
    ]);
  });

  test("a follow-up goes to the item's leased open work and takes the next sequence", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: "box", runnerVersion: "0.1.12", reportedAt: 0 }),
    );
    await db.run((q) => insertWorkItemSteps(q, "item"));
    await db.run((q) => insertWorkItemSteps(q, "idle"));
    await db.run((q) =>
      q.exec(
        q.orm.update(q.t.workItem).set({ currentRunId: "run" }).where(eq(q.t.workItem.id, "item")),
      ),
    );
    await seedWork(db, "run", "box", { leaseUntil: 100 });

    expect(await db.run((q) => itemRunnerFollowUpTargetSteps(q, "item", 99))).toEqual({
      runId: "run",
      generation: 1,
      version: "0.1.12",
    });
    expect(await db.run((q) => itemRunnerFollowUpTargetSteps(q, "item", 100))).toBeNull();
    expect(await db.run((q) => itemRunnerFollowUpTargetSteps(q, "idle", 0))).toBeNull();

    await db.run((q) => insertRunnerFollowUpSteps(q, { ...key, body: "first", createdAt: 1 }));
    await db.run((q) => insertRunnerFollowUpSteps(q, { ...key, body: "second", createdAt: 2 }));
    await db.run((q) =>
      insertRunnerFollowUpSteps(q, { runId: "run", generation: 2, body: "other", createdAt: 3 }),
    );
    expect(await db.run((q) => runnerFollowUpsAfterSteps(q, key, 0))).toEqual([
      { sequence: 1, body: "first" },
      { sequence: 2, body: "second" },
    ]);
    expect(await db.run((q) => runnerFollowUpsAfterSteps(q, key, 1))).toEqual([
      { sequence: 2, body: "second" },
    ]);
  });
});
