import { expect, test } from "bun:test";
import { workItemForSession } from "../src/db";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

test("workItemForSession prefers the in-flight item over a newer queued or failed sibling", async () => {
  const { db, close } = await tempStore();
  try {
    await seed(db, (q) =>
      q.orm.insert(q.t.workItem).values([
        {
          id: "older-running",
          delegationId: "queue-epic",
          linearIssueId: "older-running",
          linearIdentifier: "QR",
          title: "Running",
          state: "running",
          branchName: "paws/older-running",
          position: 0,
          createdAt: 1,
          sessionKey: "queue-session",
        },
        {
          id: "newer-queued",
          delegationId: "queue-epic",
          linearIssueId: "newer-queued",
          linearIdentifier: "QQ",
          title: "Queued",
          state: "queued",
          branchName: "paws/newer-queued",
          position: 1,
          createdAt: 2,
          sessionKey: "queue-session",
        },
        {
          id: "older-live",
          delegationId: "fail-epic",
          linearIssueId: "older-live",
          linearIdentifier: "FR",
          title: "Running",
          state: "running",
          branchName: "paws/older-live",
          position: 0,
          createdAt: 1,
          sessionKey: "fail-session",
        },
        {
          id: "newer-failed",
          delegationId: "fail-epic",
          linearIssueId: "newer-failed",
          linearIdentifier: "FF",
          title: "Failed",
          state: "failed",
          branchName: "paws/newer-failed",
          position: 1,
          createdAt: 2,
          sessionKey: "fail-session",
        },
      ]),
    );
    expect((await workItemForSession(db, "queue-session"))?.id).toBe("older-running");
    expect((await workItemForSession(db, "fail-session"))?.id).toBe("older-live");
  } finally {
    await close();
  }
});
