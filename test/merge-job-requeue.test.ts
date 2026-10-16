import { expect, test } from "bun:test";
import { cancelOpenJobs, getJob } from "../src/db";
import { enqueueVerifiedMerge } from "../src/loop";
import { tempDb } from "./helpers";

test("a retried item gets a live merge job for the same head after the old one was cancelled", () => {
  const db = tempDb();
  try {
    const input = { itemId: "item", head: "a".repeat(40), summary: "accepted", now: 1_000 };
    const first = enqueueVerifiedMerge(db, input);
    cancelOpenJobs(db, { itemId: "item", reason: "merge", now: 2_000 });
    expect(getJob(db, first)?.status).toBe("cancelled");
    const again = enqueueVerifiedMerge(db, { ...input, summary: "accepted again", now: 3_000 });
    expect(getJob(db, again)).toMatchObject({ status: "pending", attempts: 0 });
    expect(getJob(db, again)?.payload).toMatchObject({ summary: "accepted again" });
  } finally {
    db.close();
  }
});
