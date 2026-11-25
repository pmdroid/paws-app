import { expect, test } from "bun:test";
import { observeDb, type Db } from "./db";

test("observeDb times run and transaction without changing their results", async () => {
  let at = 0;
  const inner = {
    orm: {},
    run: async () => {
      at += 30;
      return "ran";
    },
    transaction: async () => {
      at += 70;
      throw new Error("rolled back");
    },
  } as unknown as Db;
  const recorded: number[] = [];
  const db = observeDb(
    inner,
    (ms) => recorded.push(ms),
    () => at,
  );
  expect(
    await db.run(function* () {
      yield* [];
      return "ran";
    }),
  ).toBe("ran");
  await expect(db.transaction(function* () {})).rejects.toThrow("rolled back");
  expect(db.orm).toBe(inner.orm);
  expect(recorded).toEqual([30, 70]);
});
