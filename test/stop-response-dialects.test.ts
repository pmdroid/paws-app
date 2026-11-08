import { expect, test } from "bun:test";
import {
  enqueueEndedSessionFaceSteps,
  enqueueOutboxSteps,
  getItemBranchStateSteps,
  getItemPullRequestSteps,
  listOutboxSteps,
  recordItemBranchStateSteps,
  recordItemPullRequestSteps,
  stoppedResponseSteps,
  type WorkItemRecord,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const item = {
  id: "item",
  branchName: "paws/item",
  linearIdentifier: "PAS-1",
  checkpoint: null,
} as WorkItemRecord;

forEachDialect((open) => {
  test("the stop response names the branch and pull request Paws last saw", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => stoppedResponseSteps(q, item, "Stopped."))).toBe(
        "Stopped. Branch paws/item has no commits; no PR was opened. Re-delegate to continue.",
      );
      expect(await db.run((q) => stoppedResponseSteps(q, item, "Closed.", { reason: true }))).toBe(
        "Closed.",
      );
      const state = {
        itemId: "item",
        runId: "r1",
        head: "h1",
        base: "b",
        commits: 1,
        recordedAt: 1,
      };
      await db.run((q) => recordItemBranchStateSteps(q, state));
      await db.run((q) =>
        recordItemBranchStateSteps(q, {
          ...state,
          runId: "r2",
          head: "h2",
          commits: 2,
          recordedAt: 2,
        }),
      );
      expect(await db.run((q) => getItemBranchStateSteps(q, "item"))).toEqual({
        itemId: "item",
        runId: "r2",
        head: "h2",
        base: "b",
        commits: 2,
        recordedAt: 2,
      });
      const pull = {
        itemId: "item",
        pullNumber: 12,
        pullUrl: "https://example.test/12",
        openedAt: 3,
      };
      await db.run((q) => recordItemPullRequestSteps(q, pull));
      await db.run((q) => recordItemPullRequestSteps(q, { ...pull, pullUrl: null, openedAt: 4 }));
      expect(await db.run((q) => getItemPullRequestSteps(q, "item"))).toEqual(pull);
      expect(await db.run((q) => getItemPullRequestSteps(q, "none"))).toBeNull();
      expect(
        await db.run((q) => stoppedResponseSteps(q, item, "Stopped.", { pullClosing: true })),
      ).toBe(
        "Stopped. Branch paws/item has 2 commits; PR #12 will be closed. Re-delegate to continue.",
      );
    } finally {
      await close();
    }
  });

  test("an ended session cancels its unfinished plan steps once", async () => {
    const { db, close } = await open();
    try {
      const plan = [
        { content: "Read", status: "completed" },
        { content: "Write", status: "inProgress" },
      ];
      await db.run((q) =>
        enqueueOutboxSteps(q, {
          target: "linear",
          op: "linear.session.plan",
          orderingKey: "session",
          idempotencyKey: "plan-1",
          payload: { sessionId: "session", plan, identifier: "PAS-1" },
          now: 1,
        }),
      );
      await db.run((q) =>
        enqueueOutboxSteps(q, {
          target: "linear",
          op: "linear.session.plan",
          orderingKey: "session",
          idempotencyKey: "plan-other",
          payload: { sessionId: "session", plan: [], identifier: "PAS-2" },
          now: 2,
        }),
      );
      const input = {
        sessionId: "session",
        generation: 1,
        item,
        outcome: "stopped" as const,
        now: 3,
      };
      await db.transaction((q) => enqueueEndedSessionFaceSteps(q, input));
      await db.transaction((q) => enqueueEndedSessionFaceSteps(q, input));
      const ended = (await db.run((q) => listOutboxSteps(q, "session"))).filter(
        (row) => row.idempotencyKey === "session-end:stopped:session:1",
      );
      expect(ended.map((row) => row.payload)).toEqual([
        {
          sessionId: "session",
          plan: [
            { content: "Read", status: "completed" },
            { content: "Write", status: "canceled" },
          ],
          summary: "PAS-1: stopped",
          identifier: "PAS-1",
          itemId: "item",
        },
      ]);
    } finally {
      await close();
    }
  });
});
