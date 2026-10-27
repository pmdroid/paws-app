import { describe, expect, test } from "bun:test";
import type { StoredReviewFinding } from "../closeout";
import { DEFAULT_IGNORED_COMMENT_BOTS } from "../config";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  bindWorkItemRepository,
  enterMergeQueue,
  fixRounds,
  getPullComment,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listReviewEscapes,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  pendingPullComments,
  recordItemPullRequest,
  PULL_COMMENT_SETTLE_MS,
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
  COMMENT_FIX_INSTRUCTION,
  handlePullComments,
  type PullCommentFilter,
} from "./pull-comments";
import {
  CONTRADICTION_INSTRUCTION,
  handlePullReview,
  type PullReviewCapabilities,
} from "./pull-reviews";
import { worktreeBranch } from "./sources";

const THREADS: FakeReviewThread[] = [
  {
    path: "src/rank.ts",
    line: 12,
    comments: [
      { author: "pascal", body: "This sorts the wrong way round.", reviewId: 601 },
      { author: "rev", body: "Older note on the same line.", reviewId: 500 },
    ],
  },
  {
    path: "src/cache.ts",
    line: 40,
    comments: [
      { author: "cursor[bot]", body: "Bug: the cache key ignores the tenant.", reviewId: 701 },
    ],
  },
  { resolved: true, path: "src/old.ts", comments: [{ author: "rev", body: "Done already." }] },
];

const CLOSEOUT_FINDINGS: StoredReviewFinding[] = [
  {
    reviewId: "independent-review",
    severity: "P3",
    location: "src/rank.ts:30",
    path: "src/rank.ts",
    explanation: "The comparator name is unclear.",
    status: "open",
  },
  {
    reviewId: "independent-review",
    severity: "P1",
    location: "src/cache.ts:41",
    path: "src/cache.ts",
    explanation: "The cache key ignores the tenant, so tenants read each other's entries.",
    status: "fixed",
  },
];

const FILTER: PullCommentFilter = {
  appId: () => "42",
  appLogin: () => "paws-test[bot]",
  ignoredBots: () => DEFAULT_IGNORED_COMMENT_BOTS.map((login) => login.toLowerCase()),
};

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
  recordItemPullRequest(db, { itemId: "eng-1", pullNumber: 7, pullUrl: null, openedAt: 1 });
  const github = createFakeReviewThreads(threads);
  const queue = createFakeMergeQueue();
  const client: GitHubClient = {
    request: async (request) =>
      github.respond(request) ?? (await queue.respond(request)) ?? { status: 404, body: null },
  };
  const tokenProvider = { mode: "app" as const, tokenFor: async () => "token" };
  let busy = false;
  let limit = 3;
  let clock = 1_000;
  let findings: StoredReviewFinding[] = [];
  const caps: PullReviewCapabilities = {
    now: () => clock,
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
  const send = (event: string, payload: Record<string, unknown>) =>
    acceptGitHubDelivery(
      db,
      {
        deliveryId: `d-${(delivery += 1)}`,
        event,
        payload: JSON.stringify({
          repository: { id: 11, name: "one", owner: { login: "acme" } },
          ...payload,
        }),
      },
      clock,
      FILTER,
    );
  const pull = (headRepository = 11) => ({
    number: 7,
    head: {
      ref: worktreeBranch(getWorkItem(db, "eng-1")!),
      sha: "h",
      repo: { id: headRepository },
    },
  });
  /** One inline comment, as GitHub sends it: the comment and its implicit comment-only review. */
  const inline = (input: {
    id: number;
    review: number;
    author: string;
    body: string;
    path?: string;
    action?: string;
    headRepository?: number;
  }) => {
    send("pull_request_review_comment", {
      action: input.action ?? "created",
      comment: {
        id: input.id,
        pull_request_review_id: input.review,
        body: input.body,
        path: input.path ?? "src/rank.ts",
        line: 12,
        user: { login: input.author },
      },
      pull_request: pull(input.headRepository),
    });
    send("pull_request_review", {
      action: input.action === "edited" ? "edited" : "submitted",
      review: { id: input.review, state: "commented", body: null, user: { login: input.author } },
      pull_request: pull(input.headRepository),
    });
  };
  const conversation = (input: {
    id: number;
    author: string;
    body: string;
    action?: string;
    app?: number;
  }) =>
    send("issue_comment", {
      action: input.action ?? "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/one/pulls/7" } },
      comment: {
        id: input.id,
        body: input.body,
        user: { login: input.author },
        ...(input.app === undefined ? {} : { performed_via_github_app: { id: input.app } }),
      },
    });
  return {
    db,
    caps,
    queue,
    send,
    pull,
    inline,
    conversation,
    setBusy: (value: boolean) => (busy = value),
    setLimit: (value: number) => (limit = value),
    setFindings: (value: StoredReviewFinding[]) => (findings = value),
    tick: (ms: number) => (clock += ms),
  };
}

const commentJobs = (db: ReturnType<typeof setup>["db"]) =>
  listJobs(db).filter((job) => job.queue === JOB_KIND.pullComments);
const resumeJobs = (db: ReturnType<typeof setup>["db"]) =>
  listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
const handoff = (db: ReturnType<typeof setup>["db"]) =>
  (resumeJobs(db)[0]?.payload as { handoff: string; reason: string } | undefined) ?? null;

describe("pull request comments restart the item", () => {
  test("an inline comment from a person restarts once with the comment and its thread", async () => {
    const { db, caps, inline } = setup();
    inline({ id: 9001, review: 601, author: "pascal", body: "This sorts the wrong way round." });
    // A redelivered webhook records nothing new.
    inline({ id: 9001, review: 601, author: "pascal", body: "This sorts the wrong way round." });
    expect(pendingPullComments(db, "eng-1")).toHaveLength(2);
    expect(commentJobs(db)).toHaveLength(1);
    expect(commentJobs(db)[0]?.payload).toEqual({ pullCommentsFor: "eng-1" });

    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(getWorkItem(db, "eng-1")?.state).toBe("queued");
    expect(fixRounds(db, "eng-1")).toBe(1);
    expect(resumeJobs(db)).toHaveLength(1);
    const { handoff: text, reason } = handoff(db)!;
    expect(reason).toBe("review");
    expect(text).toContain("New comments on pull request #7.");
    expect(text).toContain("@pascal reviewed:");
    expect(text).toContain("`src/rank.ts:12`");
    expect(text).toContain("@pascal: This sorts the wrong way round.");
    // The unresolved thread comes with it, not other threads.
    expect(text).toContain("@rev: Older note on the same line.");
    expect(text).not.toContain("cache key");
    expect(text).not.toContain("Done already.");
    expect(text).toEndWith(COMMENT_FIX_INSTRUCTION);
    expect(getPullComment(db, "inline", 9001)?.outcome).toBe("restarted");
    expect(getPullComment(db, "review", 601)?.outcome).toBe("restarted");

    // Redelivered after the restart: nothing.
    inline({ id: 9001, review: 601, author: "pascal", body: "This sorts the wrong way round." });
    expect(pendingPullComments(db, "eng-1")).toHaveLength(0);
    expect(await handlePullComments(db, "eng-1", caps)).toBe("done");
    expect(resumeJobs(db)).toHaveLength(1);
  });

  test("a Bugbot inline finding restarts once with the finding", async () => {
    const { db, caps, inline } = setup();
    inline({
      id: 9101,
      review: 701,
      author: "cursor[bot]",
      body: "Bug: the cache key ignores the tenant.",
      path: "src/cache.ts",
    });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(resumeJobs(db)).toHaveLength(1);
    expect(handoff(db)?.handoff).toContain("@cursor[bot]: Bug: the cache key ignores the tenant.");
    expect(handoff(db)?.handoff).toContain("`src/cache.ts:40`");
  });

  test("a Bugbot comment against a fixed Closeout finding quotes both and asks the team", async () => {
    const { db, caps, inline, setFindings } = setup();
    setFindings(CLOSEOUT_FINDINGS);
    inline({
      id: 9102,
      review: 702,
      author: "cursor[bot]",
      body: "Drop the tenant from the cache key; it splits the cache for no reason.",
      path: "src/cache.ts",
    });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(findOpenQuestion(db, "eng-1")).toBeNull();
    const text = handoff(db)!.handoff;
    expect(text).toContain("Closeout's independent review reported these findings");
    expect(text).toContain(
      "- fixed, P1 at `src/cache.ts:41`: The cache key ignores the tenant, so tenants read each other's entries.",
    );
    expect(text).toContain("- open, P3 at `src/rank.ts:30`: The comparator name is unclear.");
    expect(text).toContain("These comments are on a file a Closeout finding names.");
    expect(text).toContain(
      '- @cursor[bot] at `src/cache.ts:12`: "Drop the tenant from the cache key; it splits the cache for no reason."',
    );
    expect(text).toContain(
      '  Closeout (fixed) at `src/cache.ts:41`: "The cache key ignores the tenant, so tenants read each other\'s entries."',
    );
    expect(text).not.toContain("Closeout (open)");
    expect(text).toContain(CONTRADICTION_INSTRUCTION);
    expect(CONTRADICTION_INSTRUCTION).toContain("do not change the code");
    expect(CONTRADICTION_INSTRUCTION).toContain("ask_team");
    expect(text).toEndWith(COMMENT_FIX_INSTRUCTION);
  });

  test("an unrelated Bugbot comment gets Closeout's findings as context only", async () => {
    const { db, caps, inline, setFindings } = setup();
    setFindings(CLOSEOUT_FINDINGS);
    inline({
      id: 9103,
      review: 703,
      author: "cursor[bot]",
      body: "Bug: the README example uses the old flag.",
      path: "README.md",
    });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(findOpenQuestion(db, "eng-1")).toBeNull();
    const text = handoff(db)!.handoff;
    expect(text).toContain("Bug: the README example uses the old flag.");
    expect(text).toContain("- fixed, P1 at `src/cache.ts:41`");
    expect(text).not.toContain("These comments are on a file a Closeout finding names.");
    expect(text).toContain("Comments that do not touch a finding are handled as usual.");
    expect(text).toEndWith(COMMENT_FIX_INSTRUCTION);
  });

  test("without stored Closeout findings the handoff has no findings note", async () => {
    const { db, caps, conversation } = setup();
    conversation({ id: 3002, author: "pascal", body: "Please also fix the README." });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(handoff(db)!.handoff).not.toContain("Closeout's independent review");
    expect(handoff(db)!.handoff).not.toContain(CONTRADICTION_INSTRUCTION);
  });

  test("a conversation comment from a person restarts once with its text", async () => {
    const { db, caps, conversation } = setup();
    expect(conversation({ id: 3001, author: "pascal", body: "Please also fix the README." })).toBe(
      true,
    );
    conversation({ id: 3001, author: "pascal", body: "Please also fix the README." });
    expect(pendingPullComments(db, "eng-1")).toHaveLength(1);
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(resumeJobs(db)).toHaveLength(1);
    expect(handoff(db)?.handoff).toContain("@pascal in the conversation:");
    expect(handoff(db)?.handoff).toContain("Please also fix the README.");
  });

  test("a comment fix on an accepted head is one candidate review escape, even redelivered", async () => {
    const { db, caps, conversation, inline } = setup();
    markCloseoutAccepted(db, "eng-1", "h");
    conversation({ id: 3001, author: "pascal", body: "This drops the last page." });
    conversation({ id: 3001, author: "pascal", body: "This drops the last page." });
    inline({ id: 9001, review: 601, author: "cursor[bot]", body: "Bug: off by one." });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    conversation({ id: 3001, author: "pascal", body: "This drops the last page." });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("done");
    expect(listReviewEscapes(db)).toEqual([
      expect.objectContaining({
        itemId: "eng-1",
        trigger: "comment",
        acceptedHead: "h",
        pullNumber: 7,
        detail: {
          comments: [
            { id: 3001, author: "pascal", body: "This drops the last page." },
            { id: 9001, author: "cursor[bot]", body: "Bug: off by one." },
          ],
        },
        escape: null,
      }),
    ]);
  });

  test("an inline comment without a readable thread still carries its text", async () => {
    const { db, caps, inline } = setup([]);
    inline({ id: 9201, review: 801, author: "pascal", body: "Rename this.", path: "src/a.ts" });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(handoff(db)?.handoff).toContain("`src/a.ts:12`: Rename this.");
  });
});

describe("comments that do not restart", () => {
  test("the Paws App's own comments, edits, deletions and ignored bots record nothing", () => {
    const { db, conversation, inline } = setup();
    conversation({ id: 1, author: "someone[bot]", body: "Opened by Paws.", app: 42 });
    conversation({ id: 2, author: "paws-test[bot]", body: "Paws again." });
    conversation({ id: 3, author: "pascal", body: "Edited.", action: "edited" });
    conversation({ id: 4, author: "pascal", body: "Gone.", action: "deleted" });
    conversation({ id: 5, author: "cloudflare-workers-and-pages[bot]", body: "Deploying…" });
    conversation({ id: 6, author: "Linear-Code[bot]", body: "PAS-1" });
    inline({ id: 7, review: 70, author: "pascal", body: "Edited inline.", action: "edited" });
    expect(pendingPullComments(db, "eng-1")).toHaveLength(0);
    expect(commentJobs(db)).toHaveLength(0);
  });

  test("a fork's pull request, another pull request and an ended item record nothing", () => {
    const { db, inline, send, conversation } = setup();
    inline({ id: 1, review: 10, author: "pascal", body: "Fork.", headRepository: 99 });
    send("issue_comment", {
      action: "created",
      issue: { number: 8, pull_request: {} },
      comment: { id: 2, body: "Other pull request.", user: { login: "pascal" } },
    });
    send("issue_comment", {
      action: "created",
      issue: { number: 7 },
      comment: { id: 3, body: "Plain issue.", user: { login: "pascal" } },
    });
    db.run("UPDATE work_item SET state='merged' WHERE id='eng-1'");
    conversation({ id: 4, author: "pascal", body: "Too late." });
    expect(pendingPullComments(db, "eng-1")).toHaveLength(0);
  });

  test("a comment on an item that ended before its turn is dropped", async () => {
    const { db, caps, conversation } = setup();
    conversation({ id: 1, author: "pascal", body: "Fix this." });
    db.run("UPDATE work_item SET state='cancelled' WHERE id='eng-1'");
    expect(await handlePullComments(db, "eng-1", caps)).toBe("dropped");
    expect(resumeJobs(db)).toHaveLength(0);
  });

  test("the inline comments of a changes-requested review go with that review", async () => {
    const { db, caps, send, pull } = setup();
    send("pull_request_review_comment", {
      action: "created",
      comment: {
        id: 5001,
        pull_request_review_id: 601,
        body: "This sorts the wrong way round.",
        path: "src/rank.ts",
        line: 12,
        user: { login: "pascal" },
      },
      pull_request: pull(),
    });
    send("pull_request_review", {
      action: "submitted",
      review: { id: 601, state: "changes_requested", body: "Fix.", user: { login: "pascal" } },
      pull_request: pull(),
    });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("done");
    expect(getPullComment(db, "inline", 5001)?.outcome).toBe("covered");
    expect(await handlePullReview(db, 601, caps)).toBe("restarted");
    expect(resumeJobs(db)).toHaveLength(1);
  });
});

describe("timing", () => {
  test("three comments within a minute make one restart", async () => {
    const { db, caps, conversation, inline, tick } = setup();
    conversation({ id: 1, author: "pascal", body: "First." });
    const [job] = commentJobs(db);
    expect(job?.runAt).toBe(1_000 + PULL_COMMENT_SETTLE_MS);
    tick(25_000);
    inline({ id: 2, review: 601, author: "pascal", body: "This sorts the wrong way round." });
    tick(30_000);
    conversation({ id: 3, author: "rev", body: "Third." });
    // One job, moved to a minute after the last comment.
    expect(commentJobs(db)).toHaveLength(1);
    expect(commentJobs(db)[0]?.runAt).toBe(1_000 + 55_000 + PULL_COMMENT_SETTLE_MS);

    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
    expect(resumeJobs(db)).toHaveLength(1);
    const text = handoff(db)!.handoff;
    expect(text).toContain("1. @pascal in the conversation:");
    expect(text).toContain("2. @pascal reviewed:");
    expect(text).toContain("3. @rev in the conversation:");
    expect(fixRounds(db, "eng-1")).toBe(1);
  });

  test("a comment during a turn or evaluation waits, and holds the merge", async () => {
    const { db, caps, conversation, setBusy } = setup();
    db.run("UPDATE work_item SET state='verifying' WHERE id='eng-1'");
    conversation({ id: 1, author: "pascal", body: "Also this." });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("wait");
    db.run("UPDATE work_item SET state='merge_queue' WHERE id='eng-1'");
    setBusy(true);
    expect(await handlePullComments(db, "eng-1", caps)).toBe("wait");
    const step = await advanceMerge(
      db,
      { itemId: "eng-1", payload: {}, jobId: 1 },
      laneCapabilities(),
    );
    expect(step).toMatchObject({ kind: "wait", reason: "review" });
    setBusy(false);
    expect(await handlePullComments(db, "eng-1", caps)).toBe("restarted");
  });

  test("with the fix rounds spent, the next comment asks and does not restart", async () => {
    const { db, caps, conversation, setLimit } = setup();
    setLimit(0);
    conversation({ id: 1, author: "pascal", body: "Rename it." });
    expect(await handlePullComments(db, "eng-1", caps)).toBe("asked");
    expect(getWorkItem(db, "eng-1")?.state).toBe("awaiting_input");
    expect(resumeJobs(db)).toHaveLength(0);
    const question = findOpenQuestion(db, "s-1");
    expect(question?.body).toContain("@pascal commented on pull request #7");
    expect(question?.body).toContain("all 0 fix rounds are spent");
    expect(question?.body).toContain("Rename it.");
    expect(getPullComment(db, "conversation", 1)?.outcome).toBe("asked");
  });
});

/** The merge lane reads only these before a review holds it. */
function laneCapabilities(): MergeCapabilities {
  const caps: Partial<MergeCapabilities> = { now: () => 10, mergedOutsideLane: async () => null };
  return caps as MergeCapabilities;
}
