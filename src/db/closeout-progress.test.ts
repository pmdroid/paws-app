import { expect, test } from "bun:test";
import {
  acceptedCloseoutReviews,
  closeoutHeadsStarted,
  ensureCloseoutProgress,
  finishCloseoutProgress,
  closeoutPolicyDigests,
} from "./closeout-progress";
import {
  insertQueuedItem,
  migrate,
  openDatabase,
  markCloseoutAccepted,
  getWorkItem,
  recordCarriedAccept,
  sqliteDb,
} from "./index";

test("each head of an item is ordered by when Closeout first evaluated it", async () => {
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
  expect(await closeoutHeadsStarted(sqliteDb(db), "eng-1")).toEqual(
    new Map([
      ["h1", 10],
      ["h2", 20],
    ]),
  );
});

for (const changedIdentity of [false, true]) {
  test(`a rejection retires acceptance with ${changedIdentity ? "a new" : "the same"} progress identity`, async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    insertQueuedItem(db, { id: "item" });
    const identity = { taskId: "task", base: "b", head: "s", policyDigest: "p", policyPath: null };
    finishCloseoutProgress(db, "item", identity, "accepted", 10);
    await markCloseoutAccepted(sqliteDb(db), "item", "s");
    finishCloseoutProgress(
      db,
      "item",
      { ...identity, policyDigest: changedIdentity ? "q" : "p" },
      "rejected",
      20,
    );
    expect(getWorkItem(db, "item")?.acceptedHead).toBeNull();
    expect(closeoutPolicyDigests(db, "item", "s")?.decision).toBe("rejected");
    expect(await acceptedCloseoutReviews(sqliteDb(db), "item", "s")).toBeNull();
    db.close();
  });
}

for (const decision of ["exhausted", "blocked"] as const) {
  test(`a ${decision} verdict ${decision === "exhausted" ? "retires" : "keeps"} the accepted head`, async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    insertQueuedItem(db, { id: "item" });
    const identity = { taskId: "task", base: "b", head: "s", policyDigest: "p", policyPath: null };
    finishCloseoutProgress(db, "item", identity, "accepted", 10);
    await markCloseoutAccepted(sqliteDb(db), "item", "s");
    finishCloseoutProgress(db, "item", { ...identity, base: "c" }, decision, 20);
    expect(getWorkItem(db, "item")?.acceptedHead).toBe(decision === "exhausted" ? null : "s");
    // Either way the older acceptance is not resurrected by the newer identity's row.
    expect(await acceptedCloseoutReviews(sqliteDb(db), "item", "s")).toBeNull();
    db.close();
  });
}

test("rejecting a carried head retires its source acceptance", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item" });
  await markCloseoutAccepted(sqliteDb(db), "item", "s");
  await recordCarriedAccept(sqliteDb(db), {
    itemId: "item",
    head: "rebased",
    acceptedHead: "s",
    base: "new-main",
    now: 10,
  });
  finishCloseoutProgress(
    db,
    "item",
    { taskId: "task", base: "new-main", head: "rebased", policyDigest: "p", policyPath: null },
    "rejected",
    20,
  );
  expect(getWorkItem(db, "item")?.acceptedHead).toBeNull();
  db.close();
});
