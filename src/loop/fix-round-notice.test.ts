import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND, type RestartReason } from "../core";
import {
  OutboxDispatcher,
  beginImplementRun,
  bindWorkItemRepository,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  pendingPullComments,
  settlePullComments,
  recordItemPullRequest,
  sqliteDb,
} from "../db";
import {
  commentOnPullRequest,
  createFakeReviewReplies,
  reactToComment,
  type GitHubClient,
} from "../github";
import { createFakeTracker } from "../linear";
import { REBASE_CONFLICT_INSTRUCTION } from "../merge";
import { deliverLinearOutbox } from "./dispatch";
import { deliverGitHubOutbox, fixRoundNoticeSteps } from "./fix-round-notice";
import { acceptGitHubDelivery } from "./merge-jobs";
import { restart } from "./operations";
import { recordReplyTargets } from "./review-replies";
import { worktreeBranch } from "./sources";

async function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
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
  const github = createFakeReviewReplies();
  const client: GitHubClient = {
    request: async (request) => github.respond(request) ?? { status: 404, body: null },
  };
  const access = {
    client,
    owner: "acme",
    repo: "one",
    tokenProvider: { mode: "app" as const, tokenFor: async () => "token" },
  };
  const outbox = new OutboxDispatcher(db, clock);
  const tracker = createFakeTracker();
  outbox.setHandler((row) =>
    row.target === "linear"
      ? deliverLinearOutbox(row, tracker, async () => {}, undefined, sqliteDb(db))
      : deliverGitHubOutbox(row, {
          commentOnPullRequest: (prNumber, body) =>
            commentOnPullRequest({ ...access, prNumber, body }),
          reactToComment: (commentId, on) => reactToComment({ ...access, commentId, on }),
        }),
  );
  const startRestart = async (reason: RestartReason, body: string, jobKey: string) => {
    await restart(sqliteDb(db), (await getWorkItem(sqliteDb(db), "eng-1"))!, {
      reason,
      body,
      jobKey,
      now: clock.now(),
    });
  };
  const turnStarts = async () => {
    const job = (await listJobs(sqliteDb(db))).find((entry) => entry.queue === JOB_KIND.resume)!;
    await sqliteDb(db).transaction((q) => fixRoundNoticeSteps(q, job, clock.now()));
    await drain();
  };
  const drain = async () => {
    while ((await outbox.tick()).length > 0) await outbox.idle();
  };
  return { db, github, tracker, clock, startRestart, turnStarts, drain };
}

const target = (number: number, kind: "thread" | "conversation", commentId: number) => ({
  number,
  pullNumber: 7,
  target: kind,
  commentId,
  threadId: kind === "thread" ? `T${commentId}` : null,
  author: "pascal",
  excerpt: "Please fix.",
});

test("a review restart posts one working-on-it comment and 👀 on each comment, once", async () => {
  const { db, github, clock, startRestart, turnStarts } = await setup();
  await startRestart("review", "Fix the review.", "review:eng-1:601");
  await recordReplyTargets(
    sqliteDb(db),
    "eng-1",
    "review:eng-1:601",
    [target(1, "thread", 9001), target(2, "thread", 9101), target(3, "conversation", 5001)],
    clock.now(),
  );

  await turnStarts();
  await turnStarts();

  expect(github.comments).toHaveLength(1);
  expect(github.comments[0]!.prNumber).toBe(7);
  expect(github.comments[0]!.body).toStartWith("🐾 Paws is working on this: 3 review comments.");
  expect(github.reactions).toEqual([
    { on: "review", commentId: 9001, content: "eyes" },
    { on: "review", commentId: 9101, content: "eyes" },
    { on: "conversation", commentId: 5001, content: "eyes" },
  ]);
});

test("a conflict restart names the merge conflict and reacts to nothing", async () => {
  const { github, startRestart, turnStarts } = await setup();
  await startRestart("conflict", REBASE_CONFLICT_INSTRUCTION, "conflict:eng-1:recheck:h");

  await turnStarts();

  expect(github.comments.map((comment) => comment.body.split("\n")[0])).toEqual([
    "🐾 Paws is working on this: a merge conflict with main.",
  ]);
  expect(github.reactions).toEqual([]);
});

test("Paws does not read its own working-on-it comment back as a new comment", async () => {
  const { db, github, clock, startRestart, turnStarts } = await setup();
  await startRestart("conflict", REBASE_CONFLICT_INSTRUCTION, "conflict:eng-1:recheck:h");
  await turnStarts();

  const comment = (id: number, body: string) =>
    acceptGitHubDelivery(
      sqliteDb(db),
      {
        deliveryId: `d-${id}`,
        event: "issue_comment",
        payload: JSON.stringify({
          action: "created",
          repository: { id: 11, name: "one", owner: { login: "acme" } },
          issue: {
            number: 7,
            pull_request: { url: "https://api.github.com/repos/acme/one/pulls/7" },
          },
          comment: { id, body, user: { login: "pascal" } },
        }),
      },
      clock.now(),
      {
        appId: async () => "42",
        appLogin: () => "paws-test[bot]",
        ignoredBots: () => [],
        ignoredMarkers: () => [],
      },
    );
  await comment(6001, github.comments[0]!.body);
  await comment(6002, "And rename the helper.");

  expect(
    (await pendingPullComments(sqliteDb(db), "eng-1")).map((entry) => entry.commentId),
  ).toEqual([6002]);
});

const FILTER = {
  appId: async () => "42",
  appLogin: () => "paws-test[bot]",
  ignoredBots: () => ["linter[bot]"],
  ignoredMarkers: () => ["<!-- status -->"],
};

async function inlineComment(
  db: Parameters<typeof sqliteDb>[0],
  now: number,
  input: { id: number; author: string; body: string; app?: number },
) {
  const branch = worktreeBranch((await getWorkItem(sqliteDb(db), "eng-1"))!);
  return acceptGitHubDelivery(
    sqliteDb(db),
    {
      deliveryId: `inline-${input.id}`,
      event: "pull_request_review_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { id: 11, name: "one", owner: { login: "acme" } },
        comment: {
          id: input.id,
          pull_request_review_id: 601,
          body: input.body,
          path: "src/rank.ts",
          line: 12,
          user: { login: input.author },
          ...(input.app === undefined ? {} : { performed_via_github_app: { id: input.app } }),
        },
        pull_request: { number: 7, head: { ref: branch, sha: "h", repo: { id: 11 } } },
      }),
    },
    now,
    FILTER,
  );
}

test("an inline comment gets 👀 when it arrives, and the fix round adds no second one", async () => {
  const { db, github, clock, startRestart, turnStarts, drain } = await setup();
  expect(await inlineComment(db, clock.now(), { id: 9001, author: "pascal", body: "Fix." })).toBe(
    true,
  );
  await drain();

  expect(github.reactions).toEqual([{ on: "review", commentId: 9001, content: "eyes" }]);
  expect(github.comments).toEqual([]);
  expect((await listJobs(sqliteDb(db))).some((job) => job.queue === JOB_KIND.resume)).toBe(false);

  await startRestart("review", "Fix the review.", "review:eng-1:601");
  await recordReplyTargets(
    sqliteDb(db),
    "eng-1",
    "review:eng-1:601",
    [target(1, "thread", 9001)],
    clock.now(),
  );
  await turnStarts();

  expect(github.comments.map((comment) => comment.body.split("\n")[0])).toEqual([
    "🐾 Paws is working on this: 1 review comment.",
  ]);
  expect(github.reactions).toHaveLength(1);
});

test("comments Paws ignores get no 👀 and no Linear thought", async () => {
  const { db, github, tracker, clock, drain } = await setup();
  await inlineComment(db, clock.now(), { id: 1, author: "someone", body: "Mine.", app: 42 });
  await inlineComment(db, clock.now(), { id: 2, author: "paws-test[bot]", body: "Mine." });
  await inlineComment(db, clock.now(), { id: 3, author: "linter[bot]", body: "Lint." });
  await inlineComment(db, clock.now(), { id: 4, author: "pascal", body: "<!-- status --> ok" });
  await drain();

  expect(await pendingPullComments(sqliteDb(db), "eng-1")).toEqual([]);
  expect(github.reactions).toEqual([]);
  expect(tracker.progress).toEqual([]);
});

const SEEN =
  "Received review feedback on the pull request (1 comment from @pascal); Paws will address it when the current step finishes.";

test("an inline comment tells the Linear session before the fix round starts", async () => {
  const { db, tracker, clock, drain } = await setup();
  await inlineComment(db, clock.now(), { id: 9001, author: "pascal", body: "Fix." });
  await drain();

  expect(tracker.progress).toMatchObject([{ sessionId: "s-1", kind: "thought", body: SEEN }]);
  expect((await listJobs(sqliteDb(db))).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
});

test("three comments in one collection window post one thought, the next window another", async () => {
  const { db, tracker, clock, startRestart, drain } = await setup();
  for (const id of [1, 2, 3]) {
    await inlineComment(db, clock.now(), { id, author: "pascal", body: `Fix ${id}.` });
    clock.advance(10_000);
    await drain();
  }
  expect(tracker.progress.map((update) => update.body)).toEqual([SEEN]);

  await startRestart("review", "Fix the review.", "review:eng-1:601");
  await settlePullComments(
    sqliteDb(db),
    await pendingPullComments(sqliteDb(db), "eng-1"),
    "restarted",
    clock.now(),
  );
  await inlineComment(db, clock.now(), { id: 4, author: "kyoto", body: "One more." });
  await drain();
  expect(tracker.progress.map((update) => update.body)).toEqual([
    SEEN,
    SEEN.replace("@pascal", "@kyoto"),
  ]);
});
