import { afterEach, expect, test } from "bun:test";
import { JOB_KIND, type WorkItemState } from "../src/core";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  beginImplementRun,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  recordItemPullRequest,
  type Db,
} from "../src/db";
import { parseAgentEvent, parseLinearIssueClosed } from "../src/linear";
import { closeClosedIssueTasks } from "../src/loop";
import { tempStore } from "./pglite";

const ITEM = "ACME-12";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function itemIn(state: WorkItemState) {
  const { db, close } = await tempStore();
  open.push(close);
  await insertQueuedItem(db, { id: ITEM, sessionKey: "session", now: 0 });
  const { run } = await beginImplementRun(db, ITEM, 0);
  if (state !== "running") await applyWorkItemEvent(db, ITEM, "turn_ended");
  if (state === "awaiting_input") await applyWorkItemEvent(db, ITEM, "blocking_question");
  if (state === "merge_queue") await applyWorkItemEvent(db, ITEM, "closeout_accepted");
  expect((await getWorkItem(db, ITEM))?.state).toBe(state);
  await recordItemPullRequest(db, {
    itemId: ITEM,
    pullNumber: 42,
    pullUrl: null,
    openedAt: 0,
  });
  return { db, runId: run.id };
}

const close = (db: Db, stateType: "completed" | "canceled") =>
  closeClosedIssueTasks(
    db,
    {
      issueId: `lin-item-${ITEM}`,
      organizationId: null,
      identifier: ITEM,
      stateType,
      closedAtMs: 1,
    },
    { notify: () => {}, now: () => 10 },
  );

const responses = async (db: Db) =>
  (await listOutbox(db))
    .filter((row) => (row.payload as { kind?: string }).kind === "response")
    .map((row) => (row.payload as { body: string }).body);

const closeJobs = async (db: Db) =>
  (await listJobs(db))
    .filter((job) => job.queue === JOB_KIND.closeStoppedPull)
    .map((job) => job.payload);

for (const state of ["running", "verifying", "awaiting_input", "merge_queue"] as const)
  test(`an issue canceled in Linear while ${state} stops the run and closes its PR with a comment`, async () => {
    const { db, runId } = await itemIn(state);
    expect(await close(db, "canceled")).toEqual([{ itemId: ITEM, outcome: "cancelled" }]);
    expect((await getWorkItem(db, ITEM))?.state).toBe("cancelled");
    if (state === "running") expect((await getRun(db, runId))?.status).toBe("lost");
    expect(await responses(db)).toEqual([
      "Canceled in Linear. PR #42 was closed; the branch is kept.",
    ]);
    expect(await closeJobs(db)).toEqual([
      {
        itemId: ITEM,
        comment:
          "Closed because ACME-12 was canceled in Linear. The branch `paws/acme-12` is kept.",
      },
    ]);
  });

test("a Duplicate issue arrives as canceled and closes the PR the same way", async () => {
  const { db } = await itemIn("running");
  const at = new Date(1_000).toISOString();
  const event = parseAgentEvent(
    JSON.stringify({
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      type: "Issue",
      action: "update",
      createdAt: at,
      data: {
        id: `lin-item-${ITEM}`,
        identifier: ITEM,
        stateId: "duplicate",
        state: { id: "duplicate", type: "duplicate", name: "Duplicate" },
        canceledAt: at,
      },
      updatedFrom: { stateId: "old" },
    }),
    "duplicate",
    1_000,
  )!;
  const closed = parseLinearIssueClosed(event)!;
  expect(closed.stateType).toBe("canceled");
  await closeClosedIssueTasks(db, closed, { notify: () => {}, now: () => 10 });
  expect(await responses(db)).toEqual([
    "Canceled in Linear. PR #42 was closed; the branch is kept.",
  ]);
  expect(await closeJobs(db)).toHaveLength(1);
});

test("a Linear session stop of the same item still pauses it and keeps the PR", async () => {
  const { db } = await itemIn("running");
  const stop = { type: "stop", itemId: ITEM, source: "linear", requestedAt: 10 } as const;
  expect((await applyLinearCommand(db, stop)).applied).toBe(true);
  expect((await getWorkItem(db, ITEM))?.state).toBe("paused");
  expect(await closeJobs(db)).toEqual([]);
});

test("Done without a merge cancels the item and leaves its PR open", async () => {
  const { db } = await itemIn("running");
  expect(await close(db, "completed")).toEqual([{ itemId: ITEM, outcome: "cancelled" }]);
  expect(await closeJobs(db)).toEqual([]);
  expect(await responses(db)).toEqual([
    "Closed: the issue was completed outside this task. Branch paws/ACME-12 has no commits; PR #42 stays open.",
  ]);
});
