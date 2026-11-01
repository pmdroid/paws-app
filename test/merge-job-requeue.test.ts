import { expect, test } from "bun:test";
import { cancelOpenJobs, getJob } from "../src/db";
import { enqueueVerifiedMerge } from "../src/loop";
import { tempDb } from "./helpers";

test.each(["done", "cancelled", "dead"] as const)(
  "a retried item revives a %s merge job for the same head",
  (status) => {
    const db = tempDb();
    try {
      const input = { itemId: "item", head: "a".repeat(40), summary: "accepted", now: 1_000 };
      const first = enqueueVerifiedMerge(db, input);
      cancelOpenJobs(db, { itemId: "item", reason: "merge", now: 2_000 });
      db.run("UPDATE job SET status=?, attempts=5 WHERE id=?", [status, first]);
      const again = enqueueVerifiedMerge(db, { ...input, summary: "accepted again", now: 3_000 });
      expect(again).toBe(first);
      expect(getJob(db, again)).toMatchObject({ status: "pending", attempts: 0, runAt: 3_000 });
      expect(getJob(db, again)?.payload).toMatchObject({ summary: "accepted again" });
    } finally {
      db.close();
    }
  },
);
