import { describe, expect, test } from "bun:test";
import { DEFAULT_IGNORED_COMMENT_BOTS } from "../config";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  enterMergeQueue,
  fixRounds,
  getPullComment,
  getWorkItem,
  getWorkItemSteps,
  insertQueuedItem,
  listJobs,
  listOutbox,
  listRebaseReturns,
  migrate,
  openDatabase,
  pendingPullComments,
  recordItemPullRequest,
  sqliteDb,
  syncSteps,
} from "../db";
import { REBASE_CONFLICT_INSTRUCTION, ciFixHandoff, returnToAgent } from "../merge";
import { findOpenQuestion } from "../questions";
import { acceptGitHubDelivery } from "./merge-jobs";
import {
  REBASED_LINES_NOTE,
  readPendingFeedback,
  restartWithFeedbackSteps,
  storedFeedbackReadsSteps,
  type FeedbackCapabilities,
} from "./pending-feedback";
import {
  COMMENT_FIX_INSTRUCTION,
  handlePullComments,
  type PullCommentFilter,
} from "./pull-comments";
import type { PullReviewCapabilities } from "./pull-reviews";
import { worktreeBranch } from "./sources";

const FILTER: PullCommentFilter = {
  appId: async () => "42",
  appLogin: () => "paws-test[bot]",
  ignoredBots: () => DEFAULT_IGNORED_COMMENT_BOTS.map((login) => login.toLowerCase()),
  ignoredMarkers: () => [],
};

const FINDINGS = "Closeout found: `src/rank.ts:30` sorts the wrong way round.";
const CHECKS = [{ name: "test (0/2)", url: "https://ci.example/acme/one/1" }];

async function setup(state: "running" | "verifying" | "merge_queue") {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  await bindWorkItemRepository(sqliteDb(db), "eng-1", {
    owner: "acme",
    repo: "one",
    remoteUrl: "https://github.com/acme/one.git",
  });
  await beginImplementRun(sqliteDb(db), "eng-1", 1);
  if (state === "verifying") applyWorkItemEvent(db, "eng-1", "turn_ended");
  if (state === "merge_queue")
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
  let clock = 1_000;
  let limit = 3;
  let busy = false;
  let conflict: { head: string; base: string } | null = null;
  const caps: PullReviewCapabilities & FeedbackCapabilities = {
    now: () => clock,
    busy: async () => busy,
    threads: async () => [],
    pullHead: async () => null,
    pullConflict: async () => conflict,
    leaveMergeQueue: async () => "not_queued",
    fixRoundLimit: () => syncSteps(() => limit),
    closeoutFindings: async () => [],
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
  const pull = () => ({
    number: 7,
    head: { ref: worktreeBranch(getWorkItem(db, "eng-1")!), sha: "h", repo: { id: 11 } },
  });
  const inline = async (id: number, author: string, body: string) => {
    await send("pull_request_review_comment", {
      action: "created",
      comment: {
        id,
        pull_request_review_id: id + 1,
        body,
        path: "src/cache.ts",
        line: 40,
        user: { login: author },
      },
      pull_request: pull(),
    });
    await send("pull_request_review", {
      action: "submitted",
      review: { id: id + 1, state: "commented", body: null, user: { login: author } },
      pull_request: pull(),
    });
  };
  const conversation = (id: number, author: string, body: string) =>
    send("issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/one/pulls/7" } },
      comment: { id, body, user: { login: author } },
    });
  const sendBack = async (
    reason: "conflict" | "ci" | "findings",
    lead: string,
  ): Promise<number | null> => {
    const reads = await readPendingFeedback(db, getWorkItem(db, "eng-1")!, caps);
    const restarted = await sqliteDb(db).transaction(function* (q) {
      const current = (yield* getWorkItemSteps(q, "eng-1"))!;
      return yield* restartWithFeedbackSteps(q, current, {
        reason,
        lead: [lead],
        reads,
        ...(reason === "ci" ? { ci: false } : {}),
        fixRoundLimit: limit,
        sessionId: current.sessionKey,
        now: clock,
        jobKey: `${reason}:eng-1:recheck:h`,
      });
    });
    return restarted?.id ?? null;
  };
  return {
    db,
    caps,
    inline,
    conversation,
    sendBack,
    setLimit: (value: number) => (limit = value),
    setBusy: (value: boolean) => (busy = value),
    setConflict: (value: typeof conflict) => (conflict = value),
    tick: (ms: number) => (clock += ms),
  };
}

type Db = Awaited<ReturnType<typeof setup>>["db"];
const resumeJobs = async (db: Db) =>
  (await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.resume);
const handoffs = async (db: Db) =>
  (await resumeJobs(db)).map((job) => job.payload as { handoff: string; reason: string });
const feedbackThoughts = async (db: Db) =>
  (await listOutbox(sqliteDb(db)))
    .filter((row) => row.op === "activity" && row.idempotencyKey.startsWith("pull-feedback:"))
    .map((row) => (row.payload as { body: string }).body);
const BOT_FINDING = "Medium: the cache key ignores the tenant.";

function backToMergeQueue(db: Db) {
  applyWorkItemEvent(db, "eng-1", "dispatched");
  applyWorkItemEvent(db, "eng-1", "turn_ended");
  applyWorkItemEvent(db, "eng-1", "closeout_accepted");
}

describe("a send-back carries the feedback waiting on the item", () => {
  test("a re-check conflict restarts once with the rebase, then the comment and its reply", async () => {
    const h = await setup("verifying");
    await h.inline(9001, "cursor[bot]", BOT_FINDING);

    expect(await h.sendBack("conflict", REBASE_CONFLICT_INSTRUCTION)).not.toBeNull();
    expect(await handoffs(h.db)).toHaveLength(1);
    const { reason, handoff } = (await handoffs(h.db))[0]!;
    expect(reason).toBe("conflict");
    const rebase = handoff.indexOf(REBASE_CONFLICT_INSTRUCTION);
    const note = handoff.indexOf(REBASED_LINES_NOTE);
    const digest = handoff.indexOf("New comments on pull request #7.");
    const replies = handoff.indexOf("Reply list.");
    expect(rebase).toBe(0);
    expect(note).toBeGreaterThan(rebase);
    expect(digest).toBeGreaterThan(note);
    expect(handoff).toContain(`\`src/cache.ts:40\`: ${BOT_FINDING}`);
    expect(handoff.indexOf(COMMENT_FIX_INSTRUCTION)).toBeGreaterThan(digest);
    expect(replies).toBeGreaterThan(digest);
    expect((await getPullComment(sqliteDb(h.db), "inline", 9001))?.outcome).toBe("restarted");
    expect(await feedbackThoughts(h.db)).toEqual([
      "@cursor[bot] commented on pull request #7. The agent is working on the comments.",
    ]);
    expect(fixRounds(h.db, "eng-1")).toBe(1);

    backToMergeQueue(h.db);
    expect(await handlePullComments(h.db, "eng-1", h.caps)).toBe("done");
    expect(await handoffs(h.db)).toHaveLength(1);
  });

  test("a Closeout findings restart carries the comment", async () => {
    const h = await setup("verifying");
    await h.conversation(9101, "pascal", "Please also rename the comparator.");
    await h.sendBack("findings", FINDINGS);
    const [restarted] = await handoffs(h.db);
    expect(await handoffs(h.db)).toHaveLength(1);
    expect(restarted?.reason).toBe("findings");
    expect(restarted?.handoff.startsWith(FINDINGS)).toBe(true);
    expect(restarted?.handoff).toContain("@pascal in the conversation:");
    expect(restarted?.handoff).not.toContain(REBASED_LINES_NOTE);
    expect((await getPullComment(sqliteDb(h.db), "conversation", 9101))?.outcome).toBe("restarted");
    expect(fixRounds(h.db, "eng-1")).toBe(1);
  });

  test("a CI restart carries the failed checks and the comment, in one fix round", async () => {
    const h = await setup("verifying");
    await h.inline(9201, "cursor[bot]", BOT_FINDING);
    await h.sendBack("ci", ciFixHandoff(CHECKS));
    const [restarted] = await handoffs(h.db);
    expect(await handoffs(h.db)).toHaveLength(1);
    expect(restarted?.reason).toBe("ci");
    expect(restarted?.handoff.indexOf("CI failed on the pull request.")).toBe(0);
    expect(restarted?.handoff).toContain("- test (0/2)");
    expect(restarted?.handoff).toContain(BOT_FINDING);
    expect((await getPullComment(sqliteDb(h.db), "inline", 9201))?.outcome).toBe("restarted");
    expect(fixRounds(h.db, "eng-1")).toBe(1);
  });

  test("with the fix rounds spent, the conflict goes back alone and the comment asks", async () => {
    const h = await setup("verifying");
    h.setLimit(0);
    await h.inline(9301, "cursor[bot]", BOT_FINDING);
    await h.sendBack("conflict", REBASE_CONFLICT_INSTRUCTION);
    expect(await handoffs(h.db)).toEqual([
      expect.objectContaining({ reason: "conflict", handoff: REBASE_CONFLICT_INSTRUCTION }),
    ]);
    expect(fixRounds(h.db, "eng-1")).toBe(0);
    expect(await pendingPullComments(sqliteDb(h.db), "eng-1")).toHaveLength(2);

    backToMergeQueue(h.db);
    expect(await handlePullComments(h.db, "eng-1", h.caps)).toBe("asked");
    expect(findOpenQuestion(h.db, "s-1")?.body).toContain(BOT_FINDING);
    expect(getWorkItem(h.db, "eng-1")?.state).toBe("awaiting_input");
    expect(await handoffs(h.db)).toHaveLength(1);
  });

  test("a comment during a turn waits, then rides the next restart", async () => {
    const h = await setup("running");
    h.setBusy(true);
    await h.inline(9401, "cursor[bot]", BOT_FINDING);
    expect(await handlePullComments(h.db, "eng-1", h.caps)).toBe("wait");
    expect(await handoffs(h.db)).toHaveLength(0);
    expect(getWorkItem(h.db, "eng-1")?.state).toBe("running");

    applyWorkItemEvent(h.db, "eng-1", "turn_ended");
    await h.sendBack("conflict", REBASE_CONFLICT_INSTRUCTION);
    expect((await handoffs(h.db))[0]?.handoff).toContain(BOT_FINDING);
    expect((await getPullComment(sqliteDb(h.db), "inline", 9401))?.outcome).toBe("restarted");
  });

  test("an ignored bot's comment is not carried", async () => {
    const h = await setup("verifying");
    await h.conversation(9501, "codecov[bot]", "Coverage: 91%.");
    await h.sendBack("conflict", REBASE_CONFLICT_INSTRUCTION);
    expect((await handoffs(h.db))[0]?.handoff).toBe(REBASE_CONFLICT_INSTRUCTION);
    expect(fixRounds(h.db, "eng-1")).toBe(0);
    expect(await feedbackThoughts(h.db)).toEqual([]);
  });
});

describe("a comment restart on a conflicting pull request", () => {
  test("adds the rebase instruction and records one rebase return", async () => {
    const h = await setup("merge_queue");
    h.setConflict({ head: "h", base: "main-2" });
    await h.inline(9601, "cursor[bot]", BOT_FINDING);
    expect(await handlePullComments(h.db, "eng-1", h.caps)).toBe("restarted");
    const [restarted] = await handoffs(h.db);
    expect(await handoffs(h.db)).toHaveLength(1);
    expect(restarted?.reason).toBe("review");
    expect(restarted?.handoff.indexOf(REBASE_CONFLICT_INSTRUCTION)).toBe(0);
    expect(restarted?.handoff).toContain(REBASED_LINES_NOTE);
    expect(restarted?.handoff).toContain(BOT_FINDING);
    expect(listRebaseReturns(h.db, "eng-1", 0)).toEqual([
      expect.objectContaining({ reason: "merge", base: "main-2" }),
    ]);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
  });

  test("without a conflict has no rebase instruction", async () => {
    const h = await setup("merge_queue");
    await h.inline(9701, "cursor[bot]", BOT_FINDING);
    expect(await handlePullComments(h.db, "eng-1", h.caps)).toBe("restarted");
    expect((await handoffs(h.db))[0]?.handoff).not.toContain(REBASE_CONFLICT_INSTRUCTION);
    expect(listRebaseReturns(h.db, "eng-1", 0)).toEqual([]);
  });
});

test("the merge lane's rebase return carries the stored comment", async () => {
  const h = await setup("merge_queue");
  h.setBusy(true);
  await h.inline(9801, "cursor[bot]", BOT_FINDING);
  const returned = await returnToAgent(sqliteDb(h.db), {
    itemId: "eng-1",
    reason: "rebase-conflict",
    admit: () => syncSteps(() => true),
    handoff: REBASE_CONFLICT_INSTRUCTION,
    now: 2_000,
    record: () => syncSteps(() => {}),
    announce: () => syncSteps(() => {}),
    restart: function* (q, item, handoff) {
      return yield* restartWithFeedbackSteps(q, item, {
        reason: handoff.reason,
        now: handoff.now,
        ...(handoff.jobKey === undefined ? {} : { jobKey: handoff.jobKey }),
        lead: [handoff.body],
        reads: yield* storedFeedbackReadsSteps(q, item, handoff.now),
        ci: false,
        fixRoundLimit: 3,
        sessionId: item.sessionKey,
      });
    },
  });
  expect(returned).toBe(true);
  const [restarted] = await handoffs(h.db);
  expect(restarted?.reason).toBe("conflict");
  expect(restarted?.handoff.indexOf(REBASE_CONFLICT_INSTRUCTION)).toBe(0);
  expect(restarted?.handoff).toContain(`\`src/cache.ts:40\`: ${BOT_FINDING}`);
  expect((await getPullComment(sqliteDb(h.db), "inline", 9801))?.outcome).toBe("restarted");
  expect(fixRounds(h.db, "eng-1")).toBe(1);
});
