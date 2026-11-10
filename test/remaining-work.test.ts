import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { parsePullRequest } from "../src/acp";
import { JOB_KIND } from "../src/core";
import {
  beginImplementRun,
  completeMergedItem,
  enqueueJob,
  enterMergeQueue,
  getPullRequestDraft,
  insertQueuedItem,
  listOutbox,
  recordConfirmedRemoteMerge,
  savePullRequestDraft,
  sqliteDb,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";
import { tempDb } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const PULL_URL = "https://github.com/acme/app/pull/7";

function itemWithReport(report: Record<string, unknown>) {
  const db = tempDb();
  databases.push(db);
  const { item } = beginImplementRun(db, insertQueuedItem(db, { id: "ACME-1" }).id, 1);
  enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: item.id }, now: 1 });
  enterMergeQueue(db, item.id, { phase: "merge_queue" });
  savePullRequestDraft(db, item.id, parsePullRequest(report), 2);
  const tracker = createFakeTracker([
    {
      linearIssueId: item.linearIssueId,
      identifier: "ACME-1",
      title: "Move acme queries to Steps",
      description: "",
      subIssues: [],
    },
  ]);
  return { db, item, tracker };
}

async function merge(db: Database, itemId: string) {
  recordConfirmedRemoteMerge(db, {
    itemId,
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 7,
    pullUrl: PULL_URL,
    mergeSha: "abc",
    confirmedAt: 3,
  });
  expect((await completeMergedItem(sqliteDb(db), { itemId, now: 4 }))?.state).toBe("merged");
}

async function deliverAll(db: Database, tracker: ReturnType<typeof createFakeTracker>) {
  for (const row of listOutbox(db).filter((message) => message.target === "linear"))
    await deliverLinearOutbox(row, tracker, async () => {}, undefined, db);
}

test("two parts left for later become two delegated sub-issues after the merge, not before", async () => {
  const { db, item, tracker } = itemWithReport({
    title: "Move acme pull queries to Steps, part 1",
    body: "Moved `pull-drafts.ts`.",
    remaining: [
      { title: "Move pull-ci.ts to Steps", scope: "`src/db/pull-ci.ts`: every query." },
      { title: "Move pull-reviews.ts to Steps", scope: "`src/db/pull-reviews.ts`: the reads." },
    ],
  });
  expect(getPullRequestDraft(db, item.id)?.remaining).toHaveLength(2);

  await deliverAll(db, tracker);
  expect(listOutbox(db).filter((row) => row.op === "linear.remaining_issues")).toEqual([]);
  expect(tracker.subIssueRequests).toEqual([]);

  await merge(db, item.id);
  await deliverAll(db, tracker);
  await deliverAll(db, tracker);

  const filed = tracker.subIssues.get(item.linearIssueId) ?? [];
  expect(filed.map((issue) => issue.identifier)).toEqual(["ACME-1-1", "ACME-1-2"]);
  const request = tracker.subIssueRequests[0]!;
  expect(request).toMatchObject({
    parentIssueId: item.linearIssueId,
    delegate: true,
    repository: "acme/app",
  });
  expect(request.drafts.map((draft) => draft.title)).toEqual([
    "Move pull-ci.ts to Steps",
    "Move pull-reviews.ts to Steps",
  ]);
  for (const draft of request.drafts) {
    expect(draft.description).toContain(PULL_URL);
    expect(draft.description).toContain("Continues ACME-1");
  }
  expect(request.drafts[0]!.description).toStartWith("`src/db/pull-ci.ts`: every query.");
});

test("a report without remaining files nothing after the merge", async () => {
  const { db, item, tracker } = itemWithReport({ title: "Fix acme", body: "Fixed it." });
  expect(getPullRequestDraft(db, item.id)).toEqual({ title: "Fix acme", body: "Fixed it." });
  await merge(db, item.id);
  await deliverAll(db, tracker);
  expect(listOutbox(db).filter((row) => row.op === "linear.remaining_issues")).toEqual([]);
  expect(tracker.subIssueRequests).toEqual([]);
});

test("a fourth part is refused and tells the agent to ask a person", () => {
  const part = (n: number) => ({ title: `Part ${n}`, scope: `\`src/acme-${n}.ts\`` });
  expect(() =>
    parsePullRequest({ title: "Acme", body: "Body", remaining: [1, 2, 3, 4].map(part) }),
  ).toThrow(
    "remaining lists at most 3 parts, and this lists 4. Ship this pull request with 3 parts or fewer and call ask_team about the rest.",
  );
  expect(
    parsePullRequest({ title: "Acme", body: "Body", remaining: [1, 2, 3].map(part) }).remaining,
  ).toHaveLength(3);
});
