import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  beginMergeCallSteps,
  endMergeCallSteps,
  enqueueJobSteps,
  getConfirmedRemoteMergeSteps,
  mergeCallInFlightSteps,
  mergeStopRequestedSteps,
  recordConfirmedRemoteMergeSteps,
  type ConfirmedRemoteMerge,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const merge: ConfirmedRemoteMerge = {
  itemId: "item",
  repositoryOwner: "acme",
  repositoryName: "app",
  pullNumber: 7,
  pullUrl: null,
  mergeSha: "sha",
  confirmedAt: 10,
};

forEachDialect((open) => {
  test("a confirmed remote merge records once and refuses a conflicting one", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => getConfirmedRemoteMergeSteps(q, "item"))).toBeNull();
      expect(await db.transaction((q) => recordConfirmedRemoteMergeSteps(q, merge))).toEqual(merge);
      expect(
        await db.transaction((q) =>
          recordConfirmedRemoteMergeSteps(q, { ...merge, confirmedAt: 20 }),
        ),
      ).toEqual(merge);
      await expect(
        db.transaction((q) => recordConfirmedRemoteMergeSteps(q, { ...merge, mergeSha: "other" })),
      ).rejects.toThrow("conflicts with its saved task history");
    } finally {
      await close();
    }
  });

  test("a merge call is in flight between its begin and end", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await db.run((q) => beginMergeCallSteps(q, "item", "h1", 1));
      await db.run((q) => beginMergeCallSteps(q, "item", "h2", 2));
      expect(await db.run((q) => mergeCallInFlightSteps(q, "item"))).toBe(true);
      await db.run((q) => endMergeCallSteps(q, "item"));
      expect(await db.run((q) => mergeCallInFlightSteps(q, "item"))).toBe(false);
    } finally {
      await close();
    }
  });

  test("a pending stop or cancel command for the item stops a merge", async () => {
    const { db, close } = await open();
    try {
      const command = (payload: object) =>
        db.run((q) => enqueueJobSteps(q, { queue: JOB_KIND.command, payload, now: 0 }));
      await command({ itemId: "item", type: "resume" });
      await command({ itemId: "other", type: "stop" });
      expect(await db.run((q) => mergeStopRequestedSteps(q, "item"))).toBe(false);
      await command({ itemId: "item", type: "cancel" });
      expect(await db.run((q) => mergeStopRequestedSteps(q, "item"))).toBe(true);
    } finally {
      await close();
    }
  });
});
