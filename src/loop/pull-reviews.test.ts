import { describe, expect, test } from "bun:test";
import type { StoredReviewFinding } from "../closeout";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  enterMergeQueue,
  fixRounds,
  getPullReview,
  getWorkItem,
  insertQueuedItem,
  listReviewEscapes,
  markCloseoutAccepted,
  pendingPullComments,
  recordItemPullRequest,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
} from "../db";
import {
  createFakeMergeQueue,
  createFakeReviewThreads,
  leaveGitHubMergeQueue,
  readReviewThreads,
  type FakeReviewThread,
  type GitHubClient,
} from "../github";
import { advanceMerge, type MergeCapabilities } from "../merge";
import { findOpenQuestion } from "../questions";
import { acceptGitHubDelivery } from "./merge-jobs";
import {
  CONTRADICTION_INSTRUCTION,
  REVIEW_FIX_INSTRUCTION,
  handlePullReview,
  type PullReviewCapabilities,
} from "./pull-reviews";
import { worktreeBranch } from "./sources";

const THREADS: FakeReviewThread[] = [
  {
    path: "src/rank.ts",
    line: 12,
    comments: [
      { author: "rev", body: "This sorts the wrong way round.", reviewId: 501 },
      { author: "pascal", body: "Agreed.", reviewId: 502 },
    ],
  },
  { resolved: true, path: "src/old.ts", comments: [{ author: "rev", body: "Done already." }] },
  { path: "README.md", line: 3, comments: [{ author: "rev", body: "Typo here.", reviewId: 777 }] },
];

function setup(threads = THREADS, options: { commentsPerPage?: number } = {}) {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  bindWorkItemRepository(db, "eng-1", {
    owner: "acme",
    repo: "one",
    remoteUrl: "https://github.com/acme/one.git",
  });
  beginImplementRun(db, "eng-1", 1);
  enterMergeQueue(db, "eng-1", { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  const github = createFakeReviewThreads(threads, options);
  const queue = createFakeMergeQueue();
  const client: GitHubClient = {
    request: async (request) =>
      github.respond(request) ?? (await queue.respond(request)) ?? { status: 404, body: null },
  };
  const tokenProvider = { mode: "app" as const, tokenFor: async () => "token" };
  let busy = false;
  let limit = 3;
  let findings: StoredReviewFinding[] = [];
  const caps: PullReviewCapabilities = {
    now: () => 10,
    busy: () => busy,
    threads: (_, pullNumber) =>
      readReviewThreads({
        client,
        owner: "acme",
        repo: "one",
        prNumber: pullNumber,
        tokenProvider,
      }),
    leaveMergeQueue: (_, pullNumber) =>
      leaveGitHubMergeQueue({
        client,
        owner: "acme",
        repo: "one",
        prNumber: pullNumber,
        tokenProvider,
      }),
    fixRoundLimit: () => limit,
    closeoutFindings: async () => findings,
    session: (item) => item.sessionKey,
    flush: async () => {},
  };
  let delivery = 0;
  const deliver = (review: {
    id: number;
    state: string;
    body?: string;
    action?: string;
    branch?: string;
    headRepository?: number | null;
    pull?: number;
  }) =>
    acceptGitHubDelivery(
      db,
      {
        deliveryId: `d-${(delivery += 1)}`,
        event: "pull_request_review",
        payload: JSON.stringify({
          action: review.action ?? "submitted",
          review: {
            id: review.id,
            state: review.state,
            body: review.body ?? "",
            commit_id: "h",
            user: { login: "rev" },
          },
          pull_request: {
            number: review.pull ?? 7,
            head: {
              ref: review.branch ?? worktreeBranch(getWorkItem(db, "eng-1")!),
              sha: "h",
              repo: review.headRepository === null ? null : { id: review.headRepository ?? 11 },
            },
          },
          repository: { id: 11, name: "one", owner: { login: "acme" } },
        }),
      },
      5,
    );
  return {
    db,
    github,
    queue,
    caps,
    deliver,
    setBusy: (value: boolean) => (busy = value),
    setLimit: (value: number) => (limit = value),
    setFindings: (value: StoredReviewFinding[]) => (findings = value),
  };
}

const reviewJobs = (db: ReturnType<typeof setup>["db"]) =>
  listJobs(db).filter((job) => job.queue === JOB_KIND.pullReview);
const resumeJobs = (db: ReturnType<typeof setup>["db"]) =>
  listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
const feedbackActivities = (db: ReturnType<typeof setup>["db"]) =>
  listOutbox(db)
    .filter((row) => row.op === "activity" && row.idempotencyKey.startsWith("pull-feedback:"))
    .map((row) => {
      const payload = row.payload as { kind: string; body: string };
      return { key: row.idempotencyKey, kind: payload.kind, body: payload.body };
    });

describe("changes-requested reviews", () => {
  test("restart the item once per review id with the review and its unresolved threads", async () => {
    const { db, caps, deliver, github } = setup();
    deliver({ id: 501, state: "changes_requested", body: "Please fix the ranking." });
    deliver({ id: 501, state: "changes_requested", body: "Please fix the ranking." });
    expect(reviewJobs(db).map((job) => [job.jobKey, job.payload])).toEqual([
      ["pull-review:501", { reviewId: 501 }],
    ]);

    expect(await handlePullReview(db, 501, caps)).toBe("restarted");
    expect(getWorkItem(db, "eng-1")?.state).toBe("queued");
    expect(fixRounds(db, "eng-1")).toBe(1);
    const [resume] = resumeJobs(db);
    expect(resume?.jobKey).toBe("review:eng-1:501");
    const payload = resume?.payload as { reason: string; handoff: string };
    expect(payload.reason).toBe("review");
    expect(payload.handoff).toContain("@rev requested changes on pull request #7.");
    expect(payload.handoff).toContain("Please fix the ranking.");
    expect(payload.handoff).toContain("`src/rank.ts:12`");
    expect(payload.handoff).toContain("@rev: This sorts the wrong way round.");
    expect(payload.handoff).toContain("@pascal: Agreed.");
    expect(payload.handoff).toContain("Typo here.");
    expect(payload.handoff).not.toContain("Done already.");
    expect(payload.handoff).toContain(`${REVIEW_FIX_INSTRUCTION}\n\nReply list.`);
    expect(getPullReview(db, 501)?.outcome).toBe("restarted");
    // The Linear session wakes with a thought the post-PR activity gate lets through.
    expect(feedbackActivities(db)).toEqual([
      {
        key: "pull-feedback:review:eng-1:501",
        kind: "thought",
        body: "@rev requested changes on pull request #7. The agent is working on them.",
      },
    ]);

    // A redelivered webhook after the restart does nothing.
    expect(deliver({ id: 501, state: "changes_requested" })).toBe(true);
    expect(await handlePullReview(db, 501, caps)).toBe("done");
    expect(reviewJobs(db)).toHaveLength(1);
    expect(resumeJobs(db)).toHaveLength(1);
    expect(feedbackActivities(db)).toHaveLength(1);
    expect(github.reads).toBe(1);
  });

  test("a review thread on a file an open Closeout finding names is quoted beside it", async () => {
    const { db, caps, deliver, setFindings } = setup();
    setFindings([
      {
        reviewId: "independent-review",
        severity: "P2",
        location: "src/rank.ts:14",
        path: "src/rank.ts",
        explanation: "Ties must keep insertion order.",
        status: "open",
      },
    ]);
    deliver({ id: 501, state: "changes_requested", body: "Please fix the ranking." });
    expect(await handlePullReview(db, 501, caps)).toBe("restarted");
    const { handoff } = resumeJobs(db)[0]!.payload as { handoff: string };
    expect(handoff).toContain("- open, P2 at `src/rank.ts:14`: Ties must keep insertion order.");
    expect(handoff).toContain(
      '- @rev at `src/rank.ts:12`: "This sorts the wrong way round."\n  Closeout (open) at `src/rank.ts:14`: "Ties must keep insertion order."',
    );
    expect(handoff).not.toContain('Typo here."');
    expect(handoff).toContain(CONTRADICTION_INSTRUCTION);
    expect(handoff).toContain(`${REVIEW_FIX_INSTRUCTION}\n\nReply list.`);
  });

  test("a review fix on an accepted head is one candidate review escape, even redelivered", async () => {
    const { db, caps, deliver } = setup();
    markCloseoutAccepted(db, "eng-1", "h");
    deliver({ id: 501, state: "changes_requested", body: "The ranking is reversed." });
    deliver({ id: 501, state: "changes_requested", body: "The ranking is reversed." });
    expect(await handlePullReview(db, 501, caps)).toBe("restarted");
    expect(await handlePullReview(db, 501, caps)).toBe("done");
    deliver({ id: 501, state: "changes_requested", body: "The ranking is reversed." });
    expect(await handlePullReview(db, 501, caps)).toBe("done");
    expect(listReviewEscapes(db)).toEqual([
      expect.objectContaining({
        triggerKey: "review:eng-1:501",
        trigger: "review",
        acceptedHead: "h",
        pullNumber: 7,
        detail: { comments: [{ id: 501, author: "rev", body: "The ranking is reversed." }] },
      }),
    ]);
  });

  test("wait for a running turn or evaluation, and hold the merge until the restart", async () => {
    const { db, caps, deliver, setBusy } = setup();
    db.run("UPDATE work_item SET state='verifying' WHERE id='eng-1'");
    deliver({ id: 501, state: "changes_requested" });
    expect(await handlePullReview(db, 501, caps)).toBe("wait");

    applyWorkItemEvent(db, "eng-1", "closeout_accepted");
    expect(getWorkItem(db, "eng-1")?.state).toBe("merge_queue");
    setBusy(true);
    expect(await handlePullReview(db, 501, caps)).toBe("wait");
    const step = await advanceMerge(
      db,
      { itemId: "eng-1", payload: {}, jobId: 1 },
      laneCapabilities(),
    );
    expect(step).toMatchObject({ kind: "wait", reason: "review", queued: true });

    setBusy(false);
    expect(await handlePullReview(db, 501, caps)).toBe("restarted");
    expect(resumeJobs(db)).toHaveLength(1);
  });

  test("take the pull request out of GitHub's merge queue before anything else", async () => {
    const { db, caps, deliver, queue, setBusy } = setup();
    // GitHub's queue holds the reviewed head, and a merge attempt is running.
    queue.move(7, 1, "AWAITING_CHECKS");
    queue.calls.length = 0;
    setBusy(true);
    deliver({ id: 501, state: "changes_requested" });
    expect(await handlePullReview(db, 501, caps)).toBe("wait");
    expect(queue.calls).toEqual(["entry", "dequeue"]);
    expect(queue.isQueued(7)).toBe(false);

    // The merge step that finds the pull request gone waits for the review instead.
    const step = await advanceMerge(
      db,
      { itemId: "eng-1", payload: {}, jobId: 1 },
      laneCapabilities(),
    );
    expect(step).toMatchObject({ kind: "wait", reason: "review" });

    setBusy(false);
    expect(await handlePullReview(db, 501, caps)).toBe("restarted");
    expect(queue.calls).toEqual(["entry", "dequeue", "entry"]);
  });

  test("a pull request GitHub already merged drops the review", async () => {
    const { db, caps, deliver, queue } = setup();
    queue.merge(7);
    deliver({ id: 501, state: "changes_requested" });
    expect(await handlePullReview(db, 501, caps)).toBe("dropped");
    expect(resumeJobs(db)).toHaveLength(0);
  });

  test("a spent fix budget asks the team instead of restarting", async () => {
    const { db, caps, deliver, setLimit } = setup();
    setLimit(0);
    deliver({ id: 501, state: "changes_requested", body: "Rename it." });
    expect(await handlePullReview(db, 501, caps)).toBe("asked");
    expect(feedbackActivities(db)).toEqual([]);
    expect(getWorkItem(db, "eng-1")?.state).toBe("awaiting_input");
    expect(resumeJobs(db)).toHaveLength(0);
    const question = findOpenQuestion(db, "s-1");
    expect(question?.kind).toBe("ci-help");
    expect(question?.body).toContain("all 0 fix rounds are spent");
    expect(question?.body).toContain("Rename it.");
    expect(getPullReview(db, 501)?.outcome).toBe("asked");
  });

  test("a review of an ended item is dropped", async () => {
    const { db, caps, deliver } = setup();
    deliver({ id: 501, state: "changes_requested" });
    db.run("UPDATE work_item SET state='cancelled' WHERE id='eng-1'");
    expect(await handlePullReview(db, 501, caps)).toBe("dropped");
    expect(resumeJobs(db)).toHaveLength(0);
  });
});

describe("other reviews", () => {
  test("a comment-only review is a comment, not a change request", () => {
    const { db, deliver } = setup();
    deliver({ id: 777, state: "commented" });
    expect(getPullReview(db, 777)).toBeNull();
    expect(reviewJobs(db)).toHaveLength(0);
    expect(pendingPullComments(db, "eng-1").map((comment) => comment.commentId)).toEqual([777]);
  });

  test("approvals, edits and other branches record nothing", () => {
    const { db, deliver } = setup();
    deliver({ id: 1, state: "approved" });
    deliver({ id: 2, state: "changes_requested", action: "edited" });
    deliver({ id: 3, state: "changes_requested", branch: "someone/else" });
    expect(reviewJobs(db)).toHaveLength(0);
  });

  test("a fork's pull request with the same branch name, or another pull request, is ignored", () => {
    const { db, deliver } = setup();
    deliver({ id: 4, state: "changes_requested", headRepository: 99 });
    deliver({ id: 5, state: "changes_requested", headRepository: null });
    recordItemPullRequest(db, { itemId: "eng-1", pullNumber: 7, pullUrl: null, openedAt: 1 });
    deliver({ id: 6, state: "changes_requested", pull: 8 });
    expect(reviewJobs(db)).toHaveLength(0);
    deliver({ id: 7, state: "changes_requested" });
    expect(getPullReview(db, 7)).toMatchObject({ itemId: "eng-1", pullNumber: 7 });
  });
});

/** The merge lane reads only these before a review holds it. */
function laneCapabilities(): MergeCapabilities {
  const caps: Partial<MergeCapabilities> = { now: () => 10, mergedOutsideLane: async () => null };
  return caps as MergeCapabilities;
}
