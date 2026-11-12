import { expect, test } from "bun:test";
import {
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  listJobs,
  settleLinearComments,
} from "../db";
import { reviewHold } from "./orders";
import { tempStore } from "../../test/pglite";

const WAIT = { quietMs: 60_000, maxMs: 300_000 };

test("a queued Linear comment holds the merge until it is handed over or settled", async () => {
  const { db: store, close } = await tempStore();
  await insertQueuedItem(store, { id: "eng-1", now: 1, sessionKey: "s-1" });
  await beginImplementRun(store, "eng-1", 1);
  await enterMergeQueue(store, "eng-1", {
    phase: "merge_queue",
    baseSha: "b",
    wipCommit: "h",
  });
  expect(await reviewHold(store, "eng-1", 10, WAIT)).toBeNull();
  await store.run((q) =>
    q.exec(
      q.orm.insert(q.t.linearComment).values({
        commentId: "c-1",
        issueId: "lin-item-eng-1",
        body: "Hold on.",
        createdAtMs: 2,
        updatedAtMs: 2,
        receivedAt: 2,
        source: "webhook",
        state: "queued",
        itemId: "eng-1",
        sessionId: "s-1",
        generation: 0,
        authority: "person",
      }),
    ),
  );
  expect(await reviewHold(store, "eng-1", 10, WAIT)).toMatchObject({
    kind: "wait",
    reason: "review",
    message: "A comment on the Linear issue goes to the agent before this pull request merges.",
  });
  expect(await listJobs(store)).toEqual([]);
  await settleLinearComments(store, ["c-1"], {
    state: "ignored",
    reason: "superseded",
    now: 20,
  });
  expect(await reviewHold(store, "eng-1", 30, WAIT)).toBeNull();
  await close();
});
