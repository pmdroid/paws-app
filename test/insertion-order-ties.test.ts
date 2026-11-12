import { afterEach, expect, test } from "bun:test";
import {
  finishRunnerExecutionUsageSteps,
  insertRunnerExecutionUsageSteps,
  insertRunnerHelperSteps,
  lastSuccessfulImplementationSteps,
  markQuestionAnsweredSteps,
  pendingAnswerHandoffsSteps,
  unacknowledgedRunnerHelpersSteps,
} from "../src/db";
import { openQuestion } from "../src/questions";
import { forEachDialect, insertWorkItem, withoutForeignKeys, type DialectDb } from "./dialects";

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

forEachDialect((connect) => {
  test("answers with the same answer time hand off in the order they were asked", async () => {
    const db = await connected(connect);
    await insertWorkItem(db, "item");
    const ids: string[] = [];
    for (const body of ["first", "second"]) {
      const asked = await openQuestion(db, { itemId: "item", sessionId: "ses", body, now: 10 });
      expect(asked.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      ids.push(asked.id);
      const answer = { answer: body, answeredBy: "ann", answeredAt: 20, answerEventKey: body };
      await db.run((q) => markQuestionAnsweredSteps(q, asked.id, answer));
    }
    const handoffs = await db.run((q) => pendingAnswerHandoffsSteps(q, "item", "ses", []));
    expect(handoffs.map((row) => row.id)).toEqual(ids);
  });

  test("helpers come back in the order they were dispatched", async () => {
    const db = await connected(connect);
    const ids = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    for (const id of ids)
      await db.run((q) =>
        insertRunnerHelperSteps(q, {
          id,
          runnerId: "box",
          workspaceId: "acme",
          sessionId: "session",
          sessionGeneration: 1,
          runnerFence: 1,
          envelope: "{}",
          expiresAt: 100,
          purpose: "conversation",
        }),
      );
    expect(await db.run((q) => unacknowledgedRunnerHelpersSteps(q, "box", 50))).toEqual(ids);
  });

  test("the last implementation is the later of two turns that ended together", async () => {
    const db = await connected(connect);
    for (const model of ["older", "newer"]) {
      const commandId = Bun.randomUUIDv7();
      await db.run(function* (q) {
        yield* insertRunnerExecutionUsageSteps(q, {
          commandId,
          runnerId: model,
          ownerUserId: "owner",
          itemId: "item",
          runId: "run",
          agent: "codex",
          model: null,
          role: "implementer",
          purpose: "work",
          startedAt: 10,
          placementReason: null,
        });
        yield* finishRunnerExecutionUsageSteps(q, {
          commandId,
          endedAt: 50,
          outcome: "success",
          resolvedModel: model,
          outputBytes: 0,
          resetsAt: null,
        });
      });
    }
    expect(await db.run((q) => lastSuccessfulImplementationSteps(q, "item"))).toEqual({
      runnerId: "newer",
      model: "newer",
    });
  });
});
