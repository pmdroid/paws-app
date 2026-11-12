import { expect, test } from "bun:test";
import {
  acceptedCloseoutReviews,
  closeoutHeadsStarted,
  ensureCloseoutProgress,
  finishCloseoutProgress,
  closeoutPolicyDigests,
} from "./closeout-progress";
import { insertQueuedItem, markCloseoutAccepted, getWorkItem, recordCarriedAccept } from "./index";
import { tempStore } from "../../test/pglite";

test("each head of an item is ordered by when Closeout first evaluated it", async () => {
  const db = (await tempStore()).db;
  await insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  await insertQueuedItem(db, { id: "eng-2", now: 1, sessionKey: "s-2" });
  const identity = (head: string, policyDigest = "p") => ({
    taskId: "ENG-1",
    base: "b",
    head,
    policyDigest,
    policyPath: null,
  });
  await ensureCloseoutProgress(db, "eng-1", identity("h1"), 10, false);
  await ensureCloseoutProgress(db, "eng-1", identity("h2"), 20, false);
  await ensureCloseoutProgress(db, "eng-1", identity("h1", "q"), 30, false);
  await ensureCloseoutProgress(db, "eng-2", identity("h3"), 5, false);
  expect(await closeoutHeadsStarted(db, "eng-1")).toEqual(
    new Map([
      ["h1", 10],
      ["h2", 20],
    ]),
  );
});

for (const changedIdentity of [false, true]) {
  test(`a rejection retires acceptance with ${changedIdentity ? "a new" : "the same"} progress identity`, async () => {
    const { db, close } = await tempStore();
    await insertQueuedItem(db, { id: "item" });
    const identity = { taskId: "task", base: "b", head: "s", policyDigest: "p", policyPath: null };
    await finishCloseoutProgress(db, "item", identity, "accepted", 10);
    await markCloseoutAccepted(db, "item", "s");
    await finishCloseoutProgress(
      db,
      "item",
      { ...identity, policyDigest: changedIdentity ? "q" : "p" },
      "rejected",
      20,
    );
    expect((await getWorkItem(db, "item"))?.acceptedHead).toBeNull();
    expect((await closeoutPolicyDigests(db, "item", "s"))?.decision).toBe("rejected");
    expect(await acceptedCloseoutReviews(db, "item", "s")).toBeNull();
    await close();
  });
}

for (const decision of ["exhausted", "blocked"] as const) {
  test(`a ${decision} verdict ${decision === "exhausted" ? "retires" : "keeps"} the accepted head`, async () => {
    const { db, close } = await tempStore();
    await insertQueuedItem(db, { id: "item" });
    const identity = { taskId: "task", base: "b", head: "s", policyDigest: "p", policyPath: null };
    await finishCloseoutProgress(db, "item", identity, "accepted", 10);
    await markCloseoutAccepted(db, "item", "s");
    await finishCloseoutProgress(db, "item", { ...identity, base: "c" }, decision, 20);
    expect((await getWorkItem(db, "item"))?.acceptedHead).toBe(
      decision === "exhausted" ? null : "s",
    );
    // Either way the older acceptance is not resurrected by the newer identity's row.
    expect(await acceptedCloseoutReviews(db, "item", "s")).toBeNull();
    await close();
  });
}

test("rejecting a carried head retires its source acceptance", async () => {
  const { db, close } = await tempStore();
  await insertQueuedItem(db, { id: "item" });
  await markCloseoutAccepted(db, "item", "s");
  await recordCarriedAccept(db, {
    itemId: "item",
    head: "rebased",
    acceptedHead: "s",
    base: "new-main",
    now: 10,
  });
  await finishCloseoutProgress(
    db,
    "item",
    { taskId: "task", base: "new-main", head: "rebased", policyDigest: "p", policyPath: null },
    "rejected",
    20,
  );
  expect((await getWorkItem(db, "item"))?.acceptedHead).toBeNull();
  await close();
});
