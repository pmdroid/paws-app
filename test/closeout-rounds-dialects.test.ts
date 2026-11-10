import { expect, test } from "bun:test";
import {
  listCloseoutRecoveriesSteps,
  listCloseoutRoundsSteps,
  startCloseoutRoundSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem, withoutForeignKeys } from "./dialects";

const round = (head: string, startedAt: number) => ({
  itemId: "item",
  head,
  retryBaseline: ["evidence-1", "evidence-2"],
  startedAt,
});

forEachDialect((open) => {
  test("a Closeout round starts once per head and lists oldest first", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await insertWorkItem(db, "other");
      expect(await db.run((q) => startCloseoutRoundSteps(q, round("b", 20)))).toBe(true);
      expect(
        await db.run((q) => startCloseoutRoundSteps(q, { ...round("b", 30), retryBaseline: [] })),
      ).toBe(false);
      expect(await db.run((q) => startCloseoutRoundSteps(q, round("a", 10)))).toBe(true);
      expect(
        await db.run((q) => startCloseoutRoundSteps(q, { ...round("c", 5), itemId: "other" })),
      ).toBe(true);
      expect(await db.run((q) => listCloseoutRoundsSteps(q, "item"))).toEqual([
        round("a", 10),
        round("b", 20),
      ]);
      expect((await db.run((q) => listCloseoutRoundsSteps(q))).map((row) => row.head)).toEqual([
        "c",
        "a",
        "b",
      ]);
    } finally {
      await close();
    }
  });

  test("Closeout recoveries list with their answers, oldest question first", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await db.run(function* (q) {
        for (const [id, createdAt, answer] of [
          ["later", 20, null],
          ["earlier", 10, "retry"],
        ] as const) {
          yield* q.exec(
            q.orm.insert(q.t.question).values({
              id,
              itemId: "item",
              sessionId: "session",
              body: "Help?",
              status: answer === null ? "open" : "answered",
              answer,
              answeredBy: answer === null ? null : "lead",
              createdAt,
            }),
          );
          yield* q.exec(
            q.orm.insert(q.t.closeoutRecovery).values({
              questionId: id,
              taskId: "task",
              itemId: "item",
              base: "base",
              head: "head",
              policyDigest: "digest",
              failedChecks: q.dialect === "sqlite" ? '["test"]' : ["test"],
              retryBaseline: q.dialect === "sqlite" ? '["evidence"]' : ["evidence"],
              summary: "Failed",
            }),
          );
        }
      });
      const listed = await db.run((q) => listCloseoutRecoveriesSteps(q, "item"));
      expect(listed.map((row) => [row.questionId, row.answer, row.answeredBy])).toEqual([
        ["earlier", "retry", "lead"],
        ["later", null, null],
      ]);
      expect(listed[0]).toMatchObject({ failedChecks: ["test"], retryBaseline: ["evidence"] });
      expect(await db.run((q) => listCloseoutRecoveriesSteps(q, "none"))).toEqual([]);
    } finally {
      await close();
    }
  });
});
