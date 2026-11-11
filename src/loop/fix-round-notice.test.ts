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
  recordItemPullRequest,
  sqliteDb,
} from "../db";
import {
  commentOnPullRequest,
  createFakeReviewReplies,
  reactToComment,
  type GitHubClient,
} from "../github";
import { REBASE_CONFLICT_INSTRUCTION } from "../merge";
import { deliverGitHubOutbox, fixRoundNoticeSteps } from "./fix-round-notice";
import { acceptGitHubDelivery } from "./merge-jobs";
import { restart } from "./operations";
import { recordReplyTargets } from "./review-replies";

async function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
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
  outbox.setHandler((row) =>
    deliverGitHubOutbox(row, {
      commentOnPullRequest: (prNumber, body) => commentOnPullRequest({ ...access, prNumber, body }),
      reactToComment: (commentId, on) => reactToComment({ ...access, commentId, on }),
    }),
  );
  const startRestart = (reason: RestartReason, body: string, jobKey: string) => {
    restart(db, getWorkItem(db, "eng-1")!, { reason, body, jobKey, now: clock.now() });
  };
  const turnStarts = async () => {
    const job = listJobs(db).find((entry) => entry.queue === JOB_KIND.resume)!;
    await sqliteDb(db).transaction((q) => fixRoundNoticeSteps(q, job, clock.now()));
    while ((await outbox.tick()).length > 0) await outbox.idle();
  };
  return { db, github, clock, startRestart, turnStarts };
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
  startRestart("review", "Fix the review.", "review:eng-1:601");
  await recordReplyTargets(
    db,
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
  startRestart("conflict", REBASE_CONFLICT_INSTRUCTION, "conflict:eng-1:recheck:h");

  await turnStarts();

  expect(github.comments.map((comment) => comment.body.split("\n")[0])).toEqual([
    "🐾 Paws is working on this: a merge conflict with main.",
  ]);
  expect(github.reactions).toEqual([]);
});

test("Paws does not read its own working-on-it comment back as a new comment", async () => {
  const { db, github, clock, startRestart, turnStarts } = await setup();
  startRestart("conflict", REBASE_CONFLICT_INSTRUCTION, "conflict:eng-1:recheck:h");
  await turnStarts();

  const comment = (id: number, body: string) =>
    acceptGitHubDelivery(
      db,
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
