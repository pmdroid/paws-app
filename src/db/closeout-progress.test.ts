import { expect, test } from "bun:test";
import { closeoutHeadsStarted, ensureCloseoutProgress } from "./closeout-progress";
import { insertQueuedItem, migrate, openDatabase } from "./index";

test("each head of an item is ordered by when Closeout first evaluated it", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  insertQueuedItem(db, { id: "eng-2", now: 1, sessionKey: "s-2" });
  const identity = (head: string, policyDigest = "p") => ({
    taskId: "ENG-1",
    base: "b",
    head,
    policyDigest,
    policyPath: null,
  });
  ensureCloseoutProgress(db, "eng-1", identity("h1"), 10, false);
  ensureCloseoutProgress(db, "eng-1", identity("h2"), 20, false);
  ensureCloseoutProgress(db, "eng-1", identity("h1", "q"), 30, false);
  ensureCloseoutProgress(db, "eng-2", identity("h3"), 5, false);
  expect(closeoutHeadsStarted(db, "eng-1")).toEqual(
    new Map([
      ["h1", 10],
      ["h2", 20],
    ]),
  );
});
