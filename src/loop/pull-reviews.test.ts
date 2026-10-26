import { describe, expect, test } from "bun:test";
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
  recordItemPullRequest,
  listJobs,
  migrate,
  openDatabase,
} from "../db";
import {
  createFakeReviewThreads,
  readReviewThreads,
  type FakeReviewThread,
  type GitHubClient,
} from "../github";
import { advanceMerge, type MergeCapabilities } from "../merge";
import { findOpenQuestion } from "../questions";
import { AFTER_PULL_REQUEST_RESPONSE } from "./activity-policy";
import { acceptGitHubDelivery } from "./merge-jobs";
import {
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

function setup(threads = THREADS) {
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
  const github = createFakeReviewThreads(threads);
  const client: GitHubClient = {
    request: async (request) => github.respond(request) ?? { status: 404, body: null },
  };
  const posts: { body: string; key: string }[] = [];
  let busy = false;
  let limit = 3;
  const caps: PullReviewCapabilities = {
    now: () => 10,
    busy: () => busy,
    threads: (_, pullNumber) =>
      readReviewThreads({
        client,
        owner: "acme",
        repo: "one",
        prNumber: pullNumber,
        tokenProvider: { mode: "app", tokenFor: async () => "token" },
      }),
    fixRoundLimit: () => limit,
    session: (item) => item.sessionKey,
    post: (_, body, key) => posts.push({ body, key }),
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
    caps,
    posts,
    deliver,
    setBusy: (value: boolean) => (busy = value),
    setLimit: (value: number) => (limit = value),
  };
}

const reviewJobs = (db: ReturnType<typeof setup>["db"]) =>
  listJobs(db).filter((job) => job.queue === JOB_KIND.pullReview);
const resumeJobs = (db: ReturnType<typeof setup>["db"]) =>
  listJobs(db).filter((job) => job.queue === JOB_KIND.resume);

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
    expect(payload.handoff).toEndWith(REVIEW_FIX_INSTRUCTION);
    expect(getPullReview(db, 501)?.outcome).toBe("restarted");

    // A redelivered webhook after the restart does nothing.
    expect(deliver({ id: 501, state: "changes_requested" })).toBe(true);
    expect(await handlePullReview(db, 501, caps)).toBe("done");
    expect(reviewJobs(db)).toHaveLength(1);
    expect(resumeJobs(db)).toHaveLength(1);
    expect(github.reads).toBe(1);
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
    const step = await advanceMerge(db, { itemId: "eng-1", payload: {}, jobId: 1 }, {
      now: () => 10,
    } as MergeCapabilities);
    expect(step).toMatchObject({ kind: "wait", reason: "review", queued: true });

    setBusy(false);
    expect(await handlePullReview(db, 501, caps)).toBe("restarted");
    expect(resumeJobs(db)).toHaveLength(1);
  });

  test("a spent fix budget asks the team instead of restarting", async () => {
    const { db, caps, deliver, setLimit } = setup();
    setLimit(0);
    deliver({ id: 501, state: "changes_requested", body: "Rename it." });
    expect(await handlePullReview(db, 501, caps)).toBe("asked");
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

describe("comment-only and other reviews", () => {
  test("a comment-only review posts its own threads once and changes nothing else", async () => {
    const { db, caps, deliver, posts } = setup();
    deliver({ id: 777, state: "commented" });
    expect(await handlePullReview(db, 777, caps)).toBe("posted");
    deliver({ id: 777, state: "commented" });
    expect(await handlePullReview(db, 777, caps)).toBe("done");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.key).toBe("pull-review:777");
    expect(AFTER_PULL_REQUEST_RESPONSE.test(posts[0]!.key)).toBe(true);
    expect(posts[0]?.body).toContain("@rev commented on pull request #7.");
    expect(posts[0]?.body).toContain("Typo here.");
    expect(posts[0]?.body).not.toContain("wrong way round");
    expect(getWorkItem(db, "eng-1")?.state).toBe("merge_queue");
    expect(resumeJobs(db)).toHaveLength(0);
    // Nothing waits on a comment-only review; open threads keep readiness pending instead.
    const step = await advanceMerge(db, { itemId: "eng-1", payload: {}, jobId: 1 }, {
      now: () => 10,
      publish: async () => ({ kind: "obsolete" }),
    } as unknown as MergeCapabilities);
    expect(step).toEqual({ kind: "obsolete" });
  });

  test("an empty comment-only review posts nothing", async () => {
    const { db, caps, deliver, posts } = setup([]);
    deliver({ id: 9, state: "commented" });
    expect(await handlePullReview(db, 9, caps)).toBe("posted");
    expect(posts).toHaveLength(0);
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
