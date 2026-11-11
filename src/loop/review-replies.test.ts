import { describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  fixRounds,
  enterMergeQueue,
  getPullComment,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  PULL_COMMENT_SETTLE_MS,
  recordItemPullRequest,
  unpostedReviewReplies,
  unreportedReviewReplies,
  type PullFeedbackWait,
  sqliteDb,
  syncSteps,
} from "../db";
import {
  commentOnPullRequest,
  createFakeMergeQueue,
  createFakeReviewReplies,
  createFakeReviewThreads,
  leaveGitHubMergeQueue,
  readReviewThreads,
  replyToReviewComment,
  resolveReviewThread,
  type FakeReviewThread,
  type GitHubClient,
} from "../github";
import { findOpenQuestion } from "../questions";
import { acceptGitHubDelivery } from "./merge-jobs";
import { handlePullComments, type PullCommentFilter } from "./pull-comments";
import { handlePullReview, type PullReviewCapabilities } from "./pull-reviews";
import {
  REVIEW_REPLY_MARKER,
  checkReviewReplies,
  parseReviewReplies,
  postReviewReplies,
  recordReplyTargets,
  type ReviewReplyGitHub,
} from "./review-replies";
import { worktreeBranch } from "./sources";

const THREADS: FakeReviewThread[] = [
  {
    path: "src/rank.ts",
    line: 12,
    comments: [
      {
        author: "pascal",
        body: "This sorts the wrong way round.",
        reviewId: 601,
        databaseId: 9001,
      },
    ],
  },
  {
    path: "src/cache.ts",
    line: 40,
    comments: [
      {
        author: "cursor[bot]",
        body: "Bug: the cache key ignores the tenant.",
        reviewId: 701,
        databaseId: 9101,
      },
    ],
  },
  {
    path: "src/old.ts",
    line: 3,
    comments: [{ author: "rev", body: "From an earlier round.", reviewId: 500, databaseId: 8001 }],
  },
];

const FILTER: PullCommentFilter = {
  appId: async () => "42",
  appLogin: () => "paws-test[bot]",
  ignoredBots: () => [],
  ignoredMarkers: () => [],
};

async function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  await insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  await bindWorkItemRepository(sqliteDb(db), "eng-1", {
    owner: "acme",
    repo: "one",
    remoteUrl: "https://github.com/acme/one.git",
  });
  await beginImplementRun(sqliteDb(db), "eng-1", 1);
  await enterMergeQueue(sqliteDb(db), "eng-1", {
    phase: "merge_queue",
    baseSha: "b",
    wipCommit: "h",
  });
  await recordItemPullRequest(sqliteDb(db), {
    itemId: "eng-1",
    pullNumber: 7,
    pullUrl: null,
    openedAt: 1,
  });
  const threads = createFakeReviewThreads(THREADS);
  const queue = createFakeMergeQueue();
  const replies = createFakeReviewReplies();
  const client: GitHubClient = {
    request: async (request) =>
      threads.respond(request) ??
      replies.respond(request) ??
      (await queue.respond(request)) ?? { status: 404, body: null },
  };
  const tokenProvider = { mode: "app" as const, tokenFor: async () => "token" };
  let clock = 1_000;
  const caps: PullReviewCapabilities = {
    now: () => clock,
    busy: async () => false,
    threads: (_, prNumber) =>
      readReviewThreads({ client, owner: "acme", repo: "one", prNumber, tokenProvider }),
    pullHead: async () => null,
    leaveMergeQueue: (_, prNumber) =>
      leaveGitHubMergeQueue({ client, owner: "acme", repo: "one", prNumber, tokenProvider }),
    fixRoundLimit: () => syncSteps(() => 3),
    closeoutFindings: async () => [],
    session: (item) => item.sessionKey,
    flush: async () => {},
  };
  const access = { client, owner: "acme", repo: "one", tokenProvider };
  const github: ReviewReplyGitHub = {
    replyToReviewComment: (prNumber, commentId, body) =>
      replyToReviewComment({ ...access, prNumber, commentId, body }),
    commentOnPullRequest: (prNumber, body) => commentOnPullRequest({ ...access, prNumber, body }),
    resolveReviewThread: (threadId) => resolveReviewThread({ ...access, threadId }),
  };
  let delivery = 0;
  let wait: PullFeedbackWait | undefined;
  const send = (event: string, payload: Record<string, unknown>) =>
    acceptGitHubDelivery(
      sqliteDb(db),
      {
        deliveryId: `d-${(delivery += 1)}`,
        event,
        payload: JSON.stringify({
          repository: { id: 11, name: "one", owner: { login: "acme" } },
          ...payload,
        }),
      },
      clock,
      wait ? { ...FILTER, commentWait: () => wait! } : FILTER,
    );
  const pull = async () => ({
    number: 7,
    head: {
      ref: worktreeBranch((await getWorkItem(sqliteDb(db), "eng-1"))!),
      sha: "h",
      repo: { id: 11 },
    },
  });
  const review = async (input: { id: number; author: string; state: string; body: string }) =>
    send("pull_request_review", {
      action: "submitted",
      review: {
        id: input.id,
        state: input.state,
        body: input.body,
        commit_id: "h",
        user: { login: input.author },
      },
      pull_request: await pull(),
    });
  const inline = async (input: {
    id: number;
    review: number;
    author: string;
    body: string;
    path: string;
  }) =>
    send("pull_request_review_comment", {
      action: "created",
      comment: {
        id: input.id,
        pull_request_review_id: input.review,
        body: input.body,
        path: input.path,
        line: 12,
        user: { login: input.author },
      },
      pull_request: await pull(),
    });
  const conversation = (input: { id: number; author: string; body: string }) =>
    send("issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/one/pulls/7" } },
      comment: { id: input.id, body: input.body, user: { login: input.author } },
    });
  return {
    db,
    caps,
    github,
    replies,
    review,
    inline,
    conversation,
    tick: (ms: number) => (clock += ms),
    setWait: (value: PullFeedbackWait) => (wait = value),
  };
}

const jobs = async (db: Awaited<ReturnType<typeof setup>>["db"], queue: string) =>
  (await listJobs(sqliteDb(db))).filter((job) => job.queue === queue);
const report = async (
  db: Awaited<ReturnType<typeof setup>>["db"],
  finalMessage: string,
  sessionId: string | null = "s-1",
) => {
  const item = (await getWorkItem(sqliteDb(db), "eng-1"))!;
  return checkReviewReplies(sqliteDb(db), {
    item,
    runId: item.currentRunId ?? "",
    sessionId,
    finalMessage,
    now: 2_000,
  });
};
const handoffText = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  ((await jobs(db, JOB_KIND.resume))[0]?.payload as { handoff: string } | undefined)?.handoff ?? "";

describe("a review and the comments after it reach the agent together", () => {
  test("a changes-requested review waits a quiet minute, and a later comment moves both jobs", async () => {
    const { db, review, inline, tick } = await setup();
    await inline({
      id: 9001,
      review: 601,
      author: "pascal",
      body: "This sorts the wrong way round.",
      path: "src/rank.ts",
    });
    await review({
      id: 601,
      author: "pascal",
      state: "changes_requested",
      body: "Please fix the ranking.",
    });
    const reviewJob = async () => (await jobs(db, JOB_KIND.pullReview))[0]!;
    expect((await reviewJob()).runAt).toBe(1_000 + PULL_COMMENT_SETTLE_MS);

    tick(40_000);
    await inline({
      id: 9101,
      review: 701,
      author: "cursor[bot]",
      body: "Bug: the cache key ignores the tenant.",
      path: "src/cache.ts",
    });
    expect((await reviewJob()).runAt).toBe(41_000 + PULL_COMMENT_SETTLE_MS);
    expect((await jobs(db, JOB_KIND.pullComments))[0]!.runAt).toBe(41_000 + PULL_COMMENT_SETTLE_MS);
  });

  test("the wait from Settings › Merging replaces the default quiet minute and five-minute cap", async () => {
    const { db, review, inline, tick, setWait } = await setup();
    setWait({ quietMs: 10_000, maxMs: 25_000 });
    await review({
      id: 601,
      author: "pascal",
      state: "changes_requested",
      body: "Please fix the ranking.",
    });
    const reviewJob = async () => (await jobs(db, JOB_KIND.pullReview))[0]!;
    expect((await reviewJob()).runAt).toBe(11_000);
    tick(8_000);
    await inline({
      id: 9101,
      review: 701,
      author: "cursor[bot]",
      body: "Bug: the tenant.",
      path: "src/cache.ts",
    });
    expect((await reviewJob()).runAt).toBe(19_000);
    tick(8_000);
    await inline({
      id: 9102,
      review: 702,
      author: "cursor[bot]",
      body: "Bug: another.",
      path: "src/cache.ts",
    });
    // Capped at 25 seconds after the review job was created.
    expect((await reviewJob()).runAt).toBe(26_000);
  });

  test("the review restart carries the bot comment, and the comment job then has nothing left", async () => {
    const { db, caps, review, inline } = await setup();
    await inline({
      id: 9001,
      review: 601,
      author: "pascal",
      body: "This sorts the wrong way round.",
      path: "src/rank.ts",
    });
    await review({
      id: 601,
      author: "pascal",
      state: "changes_requested",
      body: "Please fix the ranking.",
    });
    await inline({
      id: 9101,
      review: 701,
      author: "cursor[bot]",
      body: "Bug: the cache key ignores the tenant.",
      path: "src/cache.ts",
    });
    // The comment job runs first and leaves the comments to the waiting review.
    expect(await handlePullComments(sqliteDb(db), "eng-1", caps)).toBe("wait");
    expect(await handlePullReview(sqliteDb(db), 601, caps)).toBe("restarted");
    const text = await handoffText(db);
    expect(text).toContain("@pascal requested changes on pull request #7.");
    expect(text).toContain("Bug: the cache key ignores the tenant.");
    expect(await jobs(db, JOB_KIND.resume)).toHaveLength(1);
    expect((await getPullComment(sqliteDb(db), "inline", 9101))?.outcome).toBe("covered");
    expect(await handlePullComments(sqliteDb(db), "eng-1", caps)).toBe("done");
  });
});

describe("Paws replies to every handed-off comment", () => {
  test("the handoff lists each thread, review body and conversation comment to reply to", async () => {
    const { db, caps, review, inline, conversation } = await setup();
    await inline({
      id: 9001,
      review: 601,
      author: "pascal",
      body: "This sorts the wrong way round.",
      path: "src/rank.ts",
    });
    await review({
      id: 601,
      author: "pascal",
      state: "changes_requested",
      body: "Please fix the ranking.",
    });
    await conversation({ id: 3001, author: "pascal", body: "Why does this skip the cache?" });
    expect(await handlePullReview(sqliteDb(db), 601, caps)).toBe("restarted");
    const text = await handoffText(db);
    expect(text).toContain("End your final message with a `Review replies` section");
    expect(text).toContain(
      "R1. Thread by @pascal: src/rank.ts:12: This sorts the wrong way round.",
    );
    expect(text).toContain("R2. Review by @pascal: Please fix the ranking.");
    expect(text).toContain("R3. Comment by @pascal: Why does this skip the cache?");
    // A thread from an earlier round is not asked about again.
    expect(text).not.toContain("R4.");
    expect(
      (await unreportedReviewReplies(sqliteDb(db), "eng-1")).map((reply) => [
        reply.number,
        reply.target,
      ]),
    ).toEqual([
      [1, "thread"],
      [2, "review"],
      [3, "conversation"],
    ]);
  });

  test("replies are posted once after the fix is published; only fixed threads are resolved", async () => {
    const { db, caps, github, replies, review, inline, conversation } = await setup();
    await inline({
      id: 9001,
      review: 601,
      author: "pascal",
      body: "This sorts the wrong way round.",
      path: "src/rank.ts",
    });
    await inline({
      id: 9101,
      review: 601,
      author: "pascal",
      body: "And the cache key ignores the tenant.",
      path: "src/cache.ts",
    });
    await review({ id: 601, author: "pascal", state: "changes_requested", body: "" });
    await conversation({ id: 3001, author: "pascal", body: "Why does this skip the cache?" });
    expect(await handlePullReview(sqliteDb(db), 601, caps)).toBe("restarted");

    const final = [
      "I fixed the sort order and left the cache key alone.",
      "",
      "## Review replies",
      "R1 fixed: Sort descending by score, with a test.",
      "R2 not changed: The tenant is already part of the key prefix.",
      "R3 not changed: The cache is bypassed for a fresh read.",
    ].join("\n");
    expect(await report(db, final)).toBe("complete");

    const head = "abcdef1234567890";
    expect(
      await postReviewReplies(
        sqliteDb(db),
        { itemId: "eng-1", pullNumber: 7, head, now: () => 3_000 },
        github,
      ),
    ).toBe(3);
    expect(replies.replies).toEqual([
      {
        prNumber: 7,
        commentId: 9001,
        body: `**Fixed** in abcdef1. Sort descending by score, with a test.\n\n${REVIEW_REPLY_MARKER}`,
      },
      {
        prNumber: 7,
        commentId: 9101,
        body: `**Not changed.** The tenant is already part of the key prefix.\n\n${REVIEW_REPLY_MARKER}`,
      },
    ]);
    // The fixed thread is resolved; the one left unchanged stays open for the reviewer.
    expect(replies.resolved).toEqual(["RT_0"]);
    expect(replies.comments).toHaveLength(1);
    expect(replies.comments[0]!.body).toStartWith("> @pascal: Why does this skip the cache?");
    expect(replies.comments[0]!.body).toContain(
      "**Not changed.** The cache is bypassed for a fresh read.",
    );

    expect(await unpostedReviewReplies(sqliteDb(db), "eng-1", 7)).toEqual([]);
    expect(
      await postReviewReplies(
        sqliteDb(db),
        { itemId: "eng-1", pullNumber: 7, head, now: () => 4_000 },
        github,
      ),
    ).toBe(0);
  });

  test("answered and unreported threads stay open", async () => {
    const { db, github, replies } = await setup();
    await recordReplyTargets(
      sqliteDb(db),
      "eng-1",
      "restart-answers",
      [1, 2].map((number) => ({
        number,
        pullNumber: 7,
        target: "thread" as const,
        commentId: 9000 + number,
        threadId: `RT_${number}`,
        author: "pascal",
        excerpt: "Why bypass the cache?",
      })),
      1_000,
    );
    // Without a tracker session to ask in, a missing entry is stored as unreported.
    expect(await report(db, "R1 answered: A fresh read is required.", null)).toBe("complete");
    await postReviewReplies(
      sqliteDb(db),
      {
        itemId: "eng-1",
        pullNumber: 7,
        head: "abcdef1234567890",
        now: () => 3_000,
      },
      github,
    );
    expect(replies.replies[0]!.body).toContain("**Answered.** A fresh read is required.");
    expect(replies.replies[1]!.body).toContain("did not report on it");
    expect(replies.resolved).toEqual([]);
    expect(await unpostedReviewReplies(sqliteDb(db), "eng-1", 7)).toEqual([]);
  });

  test("a permanently failed resolution leaves later replies and resolutions independent", async () => {
    const { db, github, replies } = await setup();
    await recordReplyTargets(
      sqliteDb(db),
      "eng-1",
      "restart-fix",
      [
        {
          number: 1,
          pullNumber: 7,
          target: "thread",
          commentId: 9001,
          threadId: "RT_0",
          author: "pascal",
          excerpt: "Fix the sorting.",
        },
        {
          number: 2,
          pullNumber: 7,
          target: "thread",
          commentId: 9002,
          threadId: "RT_1",
          author: "pascal",
          excerpt: "Fix the cache.",
        },
        {
          number: 3,
          pullNumber: 7,
          target: "conversation",
          commentId: 9003,
          threadId: null,
          author: "pascal",
          excerpt: "Why bypass the cache?",
        },
      ],
      1_000,
    );
    await report(
      db,
      "R1 fixed: Sort descending.\nR2 fixed: Include the tenant.\nR3 not changed: A fresh read is required.",
    );
    const input = { itemId: "eng-1", pullNumber: 7, head: "abcdef1234567890", now: () => 3_000 };
    const attempts: string[] = [];
    const failing = {
      ...github,
      resolveReviewThread: async (threadId: string) => {
        attempts.push(threadId);
        if (threadId === "RT_0") throw new Error("GitHub unavailable");
        await github.resolveReviewThread(threadId);
      },
    };
    await expect(postReviewReplies(sqliteDb(db), input, failing)).rejects.toThrow(
      "GitHub review replies failed",
    );
    expect(replies.replies).toHaveLength(2);
    expect(replies.comments).toHaveLength(1);
    expect(replies.resolved).toEqual(["RT_1"]);
    expect(attempts).toEqual(["RT_0", "RT_1"]);
    expect(await unpostedReviewReplies(sqliteDb(db), "eng-1", 7)).toEqual([]);
    expect(await postReviewReplies(sqliteDb(db), input, failing)).toBe(0);
    expect(replies.replies).toHaveLength(2);
    expect(replies.comments).toHaveLength(1);
    expect(attempts).toEqual(["RT_0", "RT_1"]);
  });

  test.each([
    ["paws-test[bot]", "A reply without a marker."],
    ["pascal", `**Fixed** in abcdef1.\n\n${REVIEW_REPLY_MARKER}`],
  ])("Paws replies from %s never come back as new comments", async (author, body) => {
    const { db, conversation } = await setup();
    await conversation({ id: 3002, author, body });
    expect(await getPullComment(sqliteDb(db), "conversation", 3002)).toBeNull();
  });
});

describe("a fix turn cannot end until every comment has its own reply", () => {
  async function handedOff() {
    const context = await setup();
    const { db, caps, review, inline, conversation } = context;
    await inline({
      id: 9001,
      review: 601,
      author: "pascal",
      body: "Wrong order.",
      path: "src/rank.ts",
    });
    await review({
      id: 601,
      author: "pascal",
      state: "changes_requested",
      body: "Fix the ranking.",
    });
    await conversation({ id: 3001, author: "pascal", body: "Why skip the cache?" });
    expect(await handlePullReview(sqliteDb(db), 601, caps)).toBe("restarted");
    return context;
  }
  // The turn the restart handed the reply list to ends with `finalMessage`.
  async function turnEnds(
    db: Awaited<ReturnType<typeof setup>>["db"],
    finalMessage: string,
    now = 5_000,
  ) {
    await applyWorkItemEvent(sqliteDb(db), "eng-1", "dispatched");
    const item = (await getWorkItem(sqliteDb(db), "eng-1"))!;
    return checkReviewReplies(sqliteDb(db), {
      item,
      runId: item.currentRunId!,
      sessionId: "s-1",
      finalMessage,
      now,
    });
  }
  const latestHandoff = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
    (await jobs(db, JOB_KIND.resume)).at(-1)!.payload as { handoff: string; reason: string };

  test("a missing entry sends the turn straight back with that entry, spending no fix round", async () => {
    const { db } = await handedOff();
    const rounds = await fixRounds(sqliteDb(db), "eng-1");
    const final = "## Review replies\nR1 fixed: Sorted descending.\nR3 not changed: A fresh read.";
    const runId = (await getWorkItem(sqliteDb(db), "eng-1"))!.currentRunId!;
    expect(await turnEnds(db, final)).toBe("sent_back");
    expect((await getRun(sqliteDb(db), runId))!.status).toBe("ended");
    const sentBack = await latestHandoff(db);
    expect(sentBack.reason).toBe("follow_up");
    expect(sentBack.handoff).toContain("R2. Review by @pascal: Fix the ranking.");
    expect(sentBack.handoff).not.toContain("R1.");
    expect(sentBack.handoff).not.toContain("R3.");
    expect(sentBack.handoff).toContain("A summary saying you fixed everything is not a reply");
    expect(await fixRounds(sqliteDb(db), "eng-1")).toBe(rounds);
    // Closeout does not start: the item waits for the agent again.
    expect((await getWorkItem(sqliteDb(db), "eng-1"))!.state).toBe("queued");
    // The replies given are kept; only R2 still waits for one.
    expect(
      (await unreportedReviewReplies(sqliteDb(db), "eng-1")).map((reply) => reply.number),
    ).toEqual([2]);
  });

  test("the third incomplete end in the same round asks the team", async () => {
    const { db } = await handedOff();
    expect(await turnEnds(db, "R1 fixed: Sorted.\nR3 not changed: Fresh read.")).toBe("sent_back");
    expect(await turnEnds(db, "I fixed everything.")).toBe("sent_back");
    expect(await turnEnds(db, "All comments are addressed.")).toBe("asked");
    expect((await getWorkItem(sqliteDb(db), "eng-1"))!.state).toBe("awaiting_input");
    expect(
      (await getRun(sqliteDb(db), (await getWorkItem(sqliteDb(db), "eng-1"))!.currentRunId!))!
        .status,
    ).toBe("ended");
    const question = (await findOpenQuestion(sqliteDb(db), "s-1"))!;
    expect(question.body).toContain("R2. Review by @pascal: Fix the ranking.");
    expect(question.body).not.toContain("R1.");
    expect(
      (await unreportedReviewReplies(sqliteDb(db), "eng-1")).map((reply) => reply.number),
    ).toEqual([2]);
  });

  test("an entry without text is missing", async () => {
    const { db } = await handedOff();
    const final = "R1 fixed: Sorted.\nR2 fixed: **\nR3 not changed: Fresh read.";
    expect(await turnEnds(db, final)).toBe("sent_back");
    expect((await latestHandoff(db)).handoff).toContain("R2. Review by @pascal");
    expect(
      (await unreportedReviewReplies(sqliteDb(db), "eng-1")).map((reply) => reply.number),
    ).toEqual([2]);
  });

  test("an emoji is a reply", async () => {
    const { db } = await handedOff();
    expect(
      await turnEnds(db, "R1 fixed: ✅\nR2 not changed: 👍\nR3 not changed: Fresh read."),
    ).toBe("complete");
  });

  test("a turn end another writer overtook keeps nothing and sends nothing", async () => {
    const { db } = await handedOff();
    await applyWorkItemEvent(sqliteDb(db), "eng-1", "dispatched");
    const item = (await getWorkItem(sqliteDb(db), "eng-1"))!;
    const resumes = (await jobs(db, JOB_KIND.resume)).length;
    await applyWorkItemEvent(sqliteDb(db), "eng-1", "turn_ended");
    const final = "R1 fixed: Sorted.";
    expect(
      await checkReviewReplies(sqliteDb(db), {
        item,
        runId: item.currentRunId!,
        sessionId: "s-1",
        finalMessage: final,
        now: 5_000,
      }),
    ).toBe("stale");
    expect(await jobs(db, JOB_KIND.resume)).toHaveLength(resumes);
    expect(
      (await unreportedReviewReplies(sqliteDb(db), "eng-1")).map((reply) => reply.number),
    ).toEqual([1, 2, 3]);
  });

  test("a complete section goes on to Closeout", async () => {
    const { db } = await handedOff();
    const resumes = (await jobs(db, JOB_KIND.resume)).length;
    const final = "R1 fixed: Sorted.\nR2 fixed: Ranked.\nR3 not changed: Fresh read.";
    expect(await turnEnds(db, final)).toBe("complete");
    expect(await jobs(db, JOB_KIND.resume)).toHaveLength(resumes);
    expect((await getWorkItem(sqliteDb(db), "eng-1"))!.state).toBe("running");
    expect(await unreportedReviewReplies(sqliteDb(db), "eng-1")).toEqual([]);
  });
});

describe("parseReviewReplies", () => {
  test("reads the outcome and reply of each numbered line, in the forms agents write them", () => {
    const reports = parseReviewReplies(
      [
        "Review replies:",
        "- R1 fixed: Sorted descending.",
        "**R2** answered — It runs on every push.",
        "R3. Not changed: Out of scope here.",
        "R4 declined: Would break the cache.",
        "R5 fixed:",
        "Some other line R6 fixed: not at the start",
      ].join("\n"),
    );
    expect([...reports.entries()]).toEqual([
      [1, { outcome: "fixed", reply: "Sorted descending." }],
      [2, { outcome: "answered", reply: "It runs on every push." }],
      [3, { outcome: "not_changed", reply: "Out of scope here." }],
      [4, { outcome: "not_changed", reply: "Would break the cache." }],
    ]);
  });
});
