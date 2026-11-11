import { describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  enterMergeQueue,
  fixRounds,
  getJob,
  getPullCiFailure,
  getWorkItem,
  getWorkItemSteps,
  applyWorkItemEventSteps,
  syncSteps,
  insertQueuedItem,
  listCiRounds,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  pendingPullCiFailures,
  recordItemPullRequest,
  saveCheckpoint,
  unreportedReviewReplies,
  type PullFeedbackWait,
  sqliteDb,
} from "../db";
import {
  createFakeMergeQueue,
  createFakeReviewThreads,
  fakeMergeReadiness,
  fakeRequiredChecks,
  leaveGitHubMergeQueue,
  readPullCi,
  readReviewThreads,
  type FakeReviewThread,
  type GitHubClient,
  type GitHubResponse,
} from "../github";
import { advanceMerge, type MergeCapabilities, type MergeStep } from "../merge";
import { askSteps as rawAsk, findOpenQuestion } from "../questions";
import { acceptGitHubDelivery, enqueueVerifiedMerge } from "./merge-jobs";
import { CI_REVIEW_WAIT_SOURCE } from "./pull-ci";
import { handlePullComments, type PullCommentFilter } from "./pull-comments";
import { handlePullReview, type PullReviewCapabilities } from "./pull-reviews";
import { worktreeBranch } from "./sources";

const HEAD = "a".repeat(40);
const LOG = "bun test v1.4.2\n✗ ranks ties by name\n 1 fail";
const THREADS: FakeReviewThread[] = [
  {
    path: "src/rank.ts",
    line: 12,
    comments: [{ author: "pascal", body: "This sorts the wrong way round.", reviewId: 601 }],
  },
];

type Nodes = { name: string; conclusion: string | null; detailsUrl: string | null }[];

const failing = (): Nodes => [
  { name: "lint", conclusion: "SUCCESS", detailsUrl: "https://ci.example/0" },
  {
    name: "test",
    conclusion: "FAILURE",
    detailsUrl: "https://ci.example/1",
    databaseId: 77,
    checkSuite: { app: { slug: "github-actions" } },
  } as Nodes[number],
];

async function setup(wait: PullFeedbackWait = { quietMs: 60_000, maxMs: 300_000 }) {
  const db = openDatabase(":memory:");
  migrate(db);
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
    wipCommit: HEAD,
  });
  await markCloseoutAccepted(sqliteDb(db), "eng-1", HEAD);
  await recordItemPullRequest(sqliteDb(db), {
    itemId: "eng-1",
    pullNumber: 7,
    pullUrl: "https://github.com/acme/one/pull/7",
    openedAt: 1,
  });
  const threads = createFakeReviewThreads(THREADS);
  const queue = createFakeMergeQueue();
  const state = {
    review: "REVIEW_REQUIRED" as "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED",
    ci: failing as () => Nodes,
    readable: true,
    ciReads: [] as string[],
    limit: 3,
    /** The pull request's head as the feedback jobs read it; null when GitHub cannot be read. */
    pullHead: HEAD as string | null,
    /** Runs while a feedback job awaits GitHub, before it reads the head. */
    during: null as (() => Promise<void>) | null,
  };
  const client: GitHubClient = {
    async request(request): Promise<GitHubResponse> {
      const handled = threads.respond(request) ?? (await queue.respond(request));
      if (handled) return handled;
      if (request.path.endsWith("/actions/jobs/77/logs")) return { status: 200, body: `${LOG}\n` };
      if (request.path === "/graphql") {
        const variables = (request.body as { variables: { head?: string } }).variables;
        if (variables.head === undefined)
          return {
            status: 200,
            body: { data: { repository: { pullRequest: { reviewDecision: state.review } } } },
          };
        if (!state.readable) return { status: 502, body: {} };
        state.ciReads.push(variables.head);
        const body = fakeMergeReadiness(variables.head);
        body.data.repository.object.statusCheckRollup.contexts.nodes = state.ci();
        return { status: 200, body };
      }
      return fakeRequiredChecks(request) ?? { status: 404, body: {} };
    },
  };
  const tokenProvider = { mode: "app" as const, tokenFor: async () => "token" };
  let clock = 1_000_000;
  const feedback: PullReviewCapabilities = {
    now: () => clock,
    busy: async () => false,
    threads: (_, prNumber) =>
      readReviewThreads({ client, owner: "acme", repo: "one", prNumber, tokenProvider }),
    leaveMergeQueue: (_, prNumber) =>
      leaveGitHubMergeQueue({ client, owner: "acme", repo: "one", prNumber, tokenProvider }),
    pullHead: async () => state.pullHead,
    fixRoundLimit: () => syncSteps(() => state.limit),
    closeoutFindings: async () => {
      const during = state.during;
      state.during = null;
      await during?.();
      return [];
    },
    session: (item) => item.sessionKey,
    flush: async () => {},
  };
  const unused = (name: string) => () => {
    throw new Error(`${name} was not expected`);
  };
  const lane: MergeCapabilities = {
    ask,
    now: () => clock,
    stopped: async () => {
      const item = await sqliteDb(db).run((q) => getWorkItemSteps(q, "eng-1"));
      return item === null || item.state === "cancelled" || item.cancelRequested;
    },
    session: (item) => item.sessionKey,
    fetchMain: unused("fetchMain"),
    ciFixAttempts: async () => state.limit,
    feedbackWait: () => wait,
    readPullCi: (_, pull) =>
      readPullCi({
        client,
        owner: "acme",
        repo: "one",
        prNumber: pull.number,
        head: pull.head,
        tokenProvider,
      }),
    readPull: async () => null,
    dependencyHold: () => syncSteps(() => null),
    mergeLane: async () => "",
    voice: {
      thought: () => syncSteps(() => {}),
      status: () => syncSteps(() => {}),
      afterPullRequest: () => {},
      flush: async () => {},
    },
    publish: async (item) => ({
      github: {
        appId: "1",
        installationId: "2",
        privateKeyPem: "unused",
        client,
        tokenProvider,
        gitExec: unused("gitExec"),
      },
      repository: { owner: "acme", repo: "one", remoteUrl: "https://github.com/acme/one.git" },
      pull: { number: 7, url: "https://github.com/acme/one/pull/7" },
      head: item.checkpoint?.wipCommit ?? HEAD,
      signal: new AbortController().signal,
      worktree: "/nonexistent",
      branchKey: "eng-1",
      summary: "Closeout accepted.",
      commit: { title: "eng-1 change" },
    }),
    settings: async () => ({ order: "queue", mainMoved: "ci", resolved: {} }),
    policyDigests: unused("policyDigests"),
    packages: () => [],
    assertReady: async () => {},
    riskApproval: async () => "not_required",
    askRiskApproval: unused("askRiskApproval"),
    mergedOutsideLane: async () => null,
    completed: unused("completed"),
  };
  const mergeJob = await enqueueVerifiedMerge(db, {
    itemId: "eng-1",
    head: HEAD,
    summary: "Closeout accepted.",
    now: clock,
  });
  db.run("UPDATE job SET run_at = ? WHERE id = ?", [clock + 30_000, mergeJob]);
  let jobs = 0;
  const evaluate = async (): Promise<MergeStep> => {
    jobs += 1;
    const job = (await getJob(sqliteDb(db), mergeJob))!;
    return advanceMerge(
      db,
      sqliteDb(db),
      { itemId: "eng-1", payload: job.payload, jobId: jobs },
      lane,
    );
  };
  const finished = new Set<number>();
  const feedbackJobs = async () =>
    (await listJobs(sqliteDb(db))).filter(
      (job) =>
        (job.queue === JOB_KIND.pullComments || job.queue === JOB_KIND.pullReview) &&
        job.status === "pending" &&
        !finished.has(job.id),
    );
  const runDue = async (): Promise<string[]> => {
    const steps: string[] = [];
    for (const job of (await feedbackJobs()).filter((due) => due.runAt <= clock)) {
      const payload = job.payload as { reviewId?: number; pullCommentsFor?: string };
      // Claimed like the scheduler does: a running job is no longer the pending one to gather into.
      db.run("UPDATE job SET status = 'running' WHERE id = ?", [job.id]);
      const step =
        payload.reviewId !== undefined
          ? await handlePullReview(db, payload.reviewId, feedback)
          : await handlePullComments(db, payload.pullCommentsFor!, feedback);
      if (step === "wait") db.run("UPDATE job SET status = 'pending' WHERE id = ?", [job.id]);
      else finished.add(job.id);
      steps.push(step);
    }
    return steps;
  };
  let delivery = 0;
  const send = (event: string, payload: Record<string, unknown>, id?: string) =>
    acceptGitHubDelivery(
      db,
      {
        deliveryId: id ?? `d-${(delivery += 1)}`,
        event,
        payload: JSON.stringify({
          repository: { id: 11, name: "one", owner: { login: "acme" } },
          ...payload,
        }),
      },
      clock,
      FILTER(wait),
    );
  const branch = () => worktreeBranch(getWorkItem(db, "eng-1")!);
  const checkRun = (head = HEAD, headBranch = branch(), id?: string) =>
    send(
      "check_run",
      {
        action: "completed",
        check_run: {
          head_sha: head,
          conclusion: "failure",
          name: "test",
          check_suite: { head_branch: headBranch },
        },
      },
      id,
    );
  const pull = () => ({ number: 7, head: { ref: branch(), sha: HEAD, repo: { id: 11 } } });
  const conversation = (id: number, author: string, body: string) =>
    send("issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/one/pulls/7" } },
      comment: { id, body, user: { login: author } },
    });
  const changesRequested = (id: number, body: string) =>
    send("pull_request_review", {
      action: "submitted",
      review: {
        id,
        state: "changes_requested",
        body,
        commit_id: HEAD,
        user: { login: "pascal" },
      },
      pull_request: pull(),
    });
  return {
    db,
    state,
    mergeJob: async () => (await getJob(sqliteDb(db), mergeJob))!,
    evaluate,
    runDue,
    feedbackJobs,
    checkRun,
    send,
    conversation,
    changesRequested,
    now: () => clock,
    tick: (ms: number) => (clock += ms),
  };
}

function FILTER(wait: PullFeedbackWait): PullCommentFilter {
  return {
    appId: async () => "42",
    appLogin: () => "paws-test[bot]",
    ignoredBots: () => [],
    ignoredMarkers: () => [],
    commentWait: () => wait,
  };
}

const ask: typeof rawAsk = function* (q, asker, ...args) {
  const result = yield* rawAsk(q, asker, ...args);
  if ((yield* getWorkItemSteps(q, asker.itemId))?.state !== "awaiting_input")
    yield* applyWorkItemEventSteps(q, asker.itemId, "blocking_question");
  return result;
};

const resumes = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  (await listJobs(sqliteDb(db)))
    .filter((job) => job.queue === JOB_KIND.resume)
    .map((job) => job.payload as { handoff: string; reason: string });

const thoughts = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  (await listOutbox(sqliteDb(db)))
    .filter((row) => row.idempotencyKey.startsWith("pull-feedback:"))
    .map((row) => (row.payload as { body: string }).body);

describe("failed CI while a pull request waits for review", () => {
  test("a failing check_run wakes the merge job, is recorded, and is repaired once at the batch deadline", async () => {
    const h = await setup();
    const observed = h.now();
    expect(await h.checkRun(HEAD, undefined, "check-1")).toBe(true);
    expect((await h.mergeJob()).runAt).toBe(observed);
    expect(await h.checkRun(HEAD, undefined, "check-1")).toBe(false);

    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review", queued: true });
    expect(await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD)).toMatchObject({
      pullNumber: 7,
      observedAt: observed,
      handledAt: null,
    });
    expect((await h.feedbackJobs()).map((job) => job.runAt)).toEqual([observed + 60_000]);

    for (const step of [10_000, 20_000, 29_999]) {
      h.tick(step - (h.now() - observed));
      await h.checkRun();
      expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
      expect(await h.runDue()).toEqual([]);
    }
    expect((await h.feedbackJobs()).map((job) => job.runAt)).toEqual([observed + 60_000]);
    expect((await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD))?.observedAt).toBe(observed);
    expect(await resumes(h.db)).toEqual([]);
    expect(fixRounds(h.db, "eng-1")).toBe(0);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toEqual([]);

    h.tick(observed + 60_000 - h.now());
    expect(await h.runDue()).toEqual(["restarted"]);
    const [resume] = await resumes(h.db);
    expect(resume?.reason).toBe("ci");
    expect(resume?.handoff).toContain(CI_REVIEW_WAIT_SOURCE);
    expect(resume?.handoff).toContain("- test (https://ci.example/1)");
    expect(resume?.handoff).toContain(`End of the \`test\` log:\n\`\`\`\n${LOG}\n\`\`\``);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toMatchObject([
      { head: HEAD, next: "agent", fix: 1, fixLimit: 3 },
    ]);
    expect(await thoughts(h.db)).toEqual([
      "CI: `test` failed. Sent back to the agent, fix 1 of 3.",
    ]);

    expect((await h.mergeJob()).status).toBe("cancelled");
    await h.checkRun();
    h.tick(400_000);
    expect(await h.runDue()).toEqual([]);
    expect(await resumes(h.db)).toHaveLength(1);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
  });

  test("a delivery for another head or branch does not wake the merge job or repair the candidate", async () => {
    const h = await setup();
    h.state.ci = () => [{ name: "test", conclusion: "SUCCESS", detailsUrl: null }];
    const parked = (await h.mergeJob()).runAt;
    await h.checkRun("b".repeat(40), "someone-else");
    expect((await h.mergeJob()).runAt).toBe(parked);
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    expect(h.state.ciReads).toEqual([HEAD]);
    expect(await pendingPullCiFailures(sqliteDb(h.db), "eng-1")).toEqual([]);
    h.tick(400_000);
    expect(await h.runDue()).toEqual([]);
    expect(await resumes(h.db)).toEqual([]);
  });

  test("an obsolete head's failure is dropped when the lane reads the current head", async () => {
    const h = await setup();
    await h.evaluate();
    const moved = "c".repeat(40);
    saveCheckpoint(h.db, "eng-1", { phase: "merge_queue", baseSha: "b", wipCommit: moved });
    h.state.ci = () => [{ name: "test", conclusion: null, detailsUrl: null }];
    h.tick(10_000);
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    expect((await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD))?.outcome).toBe("dropped");
    h.tick(60_000);
    expect(await h.runDue()).toEqual(["done"]);
    expect(await resumes(h.db)).toEqual([]);
  });

  test("CI before a burst of comments waits for the burst and goes back with every comment", async () => {
    const h = await setup();
    const start = h.now();
    await h.evaluate();
    h.tick(20_000);
    await h.conversation(1, "pascal", "Rename the helper.");
    h.tick(20_000);
    await h.conversation(2, "rev", "Also add a test for ties.");
    expect((await h.feedbackJobs()).map((job) => job.runAt)).toEqual([start + 100_000]);
    h.tick(59_999);
    await h.evaluate();
    expect(await h.runDue()).toEqual([]);
    expect(await resumes(h.db)).toEqual([]);

    h.tick(1);
    expect(await h.runDue()).toEqual(["restarted"]);
    const [resume] = await resumes(h.db);
    expect(resume?.reason).toBe("review");
    expect(resume?.handoff).toContain("Rename the helper.");
    expect(resume?.handoff).toContain("Also add a test for ties.");
    expect(resume?.handoff).toContain(`End of the \`test\` log:`);
    expect(
      (await unreportedReviewReplies(sqliteDb(h.db), "eng-1")).map((reply) => reply.commentId),
    ).toEqual([1, 2]);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toMatchObject([
      { head: HEAD, next: "agent", fix: 1 },
    ]);
  });

  test("CI during a burst of comments extends the quiet time, never past the longest wait", async () => {
    const h = await setup();
    const start = h.now();
    await h.conversation(1, "pascal", "First note.");
    h.tick(30_000);
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    expect(await pendingPullCiFailures(sqliteDb(h.db), "eng-1")).toHaveLength(1);
    expect((await h.feedbackJobs()).map((job) => job.runAt)).toEqual([start + 90_000]);
    for (let at = 80_000; at <= 280_000; at += 50_000) {
      h.tick(start + at - h.now());
      await h.conversation(at, "rev", `Note at ${at}.`);
      await h.evaluate();
      expect(await h.runDue()).toEqual([]);
    }
    expect((await h.feedbackJobs()).map((job) => job.runAt)).toEqual([start + 300_000]);
    h.tick(start + 300_000 - h.now());
    expect(await h.runDue()).toEqual(["restarted"]);
    expect(await resumes(h.db)).toHaveLength(1);
    expect((await resumes(h.db))[0]?.handoff).toContain("Note at 280000.");
    expect((await resumes(h.db))[0]?.handoff).toContain(CI_REVIEW_WAIT_SOURCE);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
  });

  test("CI after the comments still lets the feedback settle under custom wait settings", async () => {
    const h = await setup({ quietMs: 10_000, maxMs: 30_000 });
    const start = h.now();
    await h.conversation(1, "pascal", "Rename the helper.");
    h.state.ci = () => [{ name: "test", conclusion: null, detailsUrl: null }];
    await h.evaluate();
    h.tick(8_000);
    h.state.ci = failing;
    await h.checkRun();
    await h.evaluate();
    expect((await h.feedbackJobs()).map((job) => job.runAt)).toEqual([start + 18_000]);
    h.tick(9_999);
    expect(await h.runDue()).toEqual([]);
    h.tick(1);
    expect(await h.runDue()).toEqual(["restarted"]);
    expect(await resumes(h.db)).toHaveLength(1);
    expect((await resumes(h.db))[0]?.handoff).toContain("Rename the helper.");
    expect((await resumes(h.db))[0]?.handoff).toContain("- test (https://ci.example/1)");
  });

  test("a changes-requested review takes the CI failure in its one restart; an early wake keeps its deadline", async () => {
    const h = await setup();
    h.state.review = "CHANGES_REQUESTED";
    const start = h.now();
    await h.changesRequested(601, "Please fix the ordering.");
    expect((await h.mergeJob()).runAt).toBe(start);
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    const reviewJob = async () =>
      (await h.feedbackJobs()).find((job) => job.queue === JOB_KIND.pullReview);
    expect((await reviewJob())?.runAt).toBe(start + 60_000);
    expect(await pendingPullCiFailures(sqliteDb(h.db), "eng-1")).toHaveLength(1);
    h.tick(30_000);
    await h.checkRun();
    await h.evaluate();
    expect((await reviewJob())?.runAt).toBe(start + 60_000);
    expect(await h.runDue()).toEqual([]);

    h.tick(30_000);
    expect(await h.runDue()).toEqual(["restarted", "done"]);
    const [resume] = await resumes(h.db);
    expect(resume?.reason).toBe("review");
    expect(resume?.handoff).toContain("Please fix the ordering.");
    expect(resume?.handoff).toContain("This sorts the wrong way round.");
    expect(resume?.handoff).toContain(CI_REVIEW_WAIT_SOURCE);
    expect(await resumes(h.db)).toHaveLength(1);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toMatchObject([
      { head: HEAD, next: "agent", fix: 1 },
    ]);
    expect((await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD))?.outcome).toBe("restarted");
  });

  test("changes requested earlier still lets CI be seen, and goes back once for CI", async () => {
    const h = await setup();
    h.state.review = "CHANGES_REQUESTED";
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    h.tick(60_000);
    expect(await h.runDue()).toEqual(["restarted"]);
    expect((await resumes(h.db)).map((resume) => resume.reason)).toEqual(["ci"]);
    expect(getWorkItem(h.db, "eng-1")?.state).toBe("queued");
  });

  test("pending, green or unreadable CI waits for the review without spending a round", async () => {
    const h = await setup();
    h.state.ci = () => [{ name: "test", conclusion: null, detailsUrl: null }];
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    h.state.ci = () => [{ name: "test", conclusion: "SUCCESS", detailsUrl: null }];
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    h.state.readable = false;
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    expect(await pendingPullCiFailures(sqliteDb(h.db), "eng-1")).toEqual([]);
    expect(await h.feedbackJobs()).toEqual([]);

    h.state.readable = true;
    h.state.ci = failing;
    await h.evaluate();
    h.state.readable = false;
    h.tick(10_000);
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    expect(await pendingPullCiFailures(sqliteDb(h.db), "eng-1")).toHaveLength(1);

    h.state.readable = true;
    h.state.ci = () => [{ name: "test", conclusion: null, detailsUrl: null }];
    expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    expect((await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD))?.outcome).toBe("cleared");
    h.tick(60_000);
    expect(await h.runDue()).toEqual(["done"]);
    expect(await resumes(h.db)).toEqual([]);
    expect(fixRounds(h.db, "eng-1")).toBe(0);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toEqual([]);
  });

  test("with the fix rounds spent it asks once with budget_spent, and replays do not ask again", async () => {
    const h = await setup();
    h.state.limit = 0;
    await h.evaluate();
    h.tick(60_000);
    expect(await h.runDue()).toEqual(["asked"]);
    const question = findOpenQuestion(h.db, "s-1");
    expect(question?.reason).toBe("budget_spent");
    expect(question?.body).toContain(
      "CI failed on the pull request (https://github.com/acme/one/pull/7)",
    );
    expect(question?.body).toContain("- test (https://ci.example/1)");
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toMatchObject([
      { head: HEAD, next: "asked", fix: null },
    ]);

    await h.checkRun();
    h.tick(60_000);
    expect(await h.runDue()).toEqual([]);
    const asks = (await listOutbox(sqliteDb(h.db))).filter((row) => row.op === "elicitation");
    expect(asks).toHaveLength(1);
    expect(await resumes(h.db)).toEqual([]);
  });

  test("cancellation or a superseded item version cannot restart from the recorded failure", async () => {
    const cancelled = await setup();
    await cancelled.evaluate();
    cancelled.db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = 'eng-1'");
    cancelled.tick(60_000);
    expect(await cancelled.runDue()).toEqual(["dropped"]);
    expect(await resumes(cancelled.db)).toEqual([]);

    const superseded = await setup();
    await superseded.evaluate();
    await applyWorkItemEvent(sqliteDb(superseded.db), "eng-1", "reverify_requested");
    await applyWorkItemEvent(sqliteDb(superseded.db), "eng-1", "closeout_accepted");
    superseded.tick(60_000);
    expect(await superseded.runDue()).toEqual(["done"]);
    expect((await getPullCiFailure(sqliteDb(superseded.db), "eng-1", HEAD))?.outcome).toBe(
      "dropped",
    );
    expect(await resumes(superseded.db)).toEqual([]);
    expect(fixRounds(superseded.db, "eng-1")).toBe(0);
  });
  test("a failure whose head moved before the batch ran is dropped without a restart or a round", async () => {
    const h = await setup();
    await h.evaluate();
    expect(await pendingPullCiFailures(sqliteDb(h.db), "eng-1")).toHaveLength(1);
    h.state.pullHead = "d".repeat(40);
    h.tick(60_000);
    expect(await h.runDue()).toEqual(["done"]);
    expect((await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD))?.outcome).toBe("dropped");
    expect(await resumes(h.db)).toEqual([]);
    expect(fixRounds(h.db, "eng-1")).toBe(0);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toEqual([]);
  });

  test("a head GitHub cannot return keeps the failure pending until the head is read", async () => {
    const h = await setup();
    await h.evaluate();
    h.state.pullHead = null;
    h.tick(60_000);
    expect(await h.runDue()).toEqual(["wait"]);
    expect((await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD))?.handledAt).toBeNull();
    expect(await resumes(h.db)).toEqual([]);
    expect(fixRounds(h.db, "eng-1")).toBe(0);

    h.state.pullHead = HEAD;
    expect(await h.runDue()).toEqual(["restarted"]);
    expect((await resumes(h.db)).map((resume) => resume.reason)).toEqual(["ci"]);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
  });

  test("a failure recorded while a due comment batch reads GitHub waits for its own window", async () => {
    const h = await setup();
    h.state.ci = () => [{ name: "test", conclusion: null, detailsUrl: null }];
    await h.conversation(1, "pascal", "Rename the helper.");
    await h.evaluate();
    expect(await pendingPullCiFailures(sqliteDb(h.db), "eng-1")).toEqual([]);
    h.tick(60_000);
    h.state.ci = failing;
    let observed = 0;
    h.state.during = async () => {
      h.tick(5_000);
      observed = h.now();
      expect(await h.evaluate()).toMatchObject({ kind: "wait", reason: "review" });
    };
    expect(await h.runDue()).toEqual(["restarted"]);
    const [resume] = await resumes(h.db);
    expect(resume?.reason).toBe("review");
    expect(resume?.handoff).toContain("Rename the helper.");
    expect(resume?.handoff).not.toContain(CI_REVIEW_WAIT_SOURCE);
    expect(fixRounds(h.db, "eng-1")).toBe(1);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toEqual([]);
    expect(await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD)).toMatchObject({
      observedAt: observed,
      handledAt: null,
    });
    expect((await h.feedbackJobs()).map((job) => job.runAt)).toEqual([observed + 60_000]);
  });

  test("a failure recorded while a due changes-requested review reads GitHub is not charged with it", async () => {
    const h = await setup();
    h.state.review = "CHANGES_REQUESTED";
    h.state.ci = () => [{ name: "test", conclusion: null, detailsUrl: null }];
    await h.changesRequested(601, "Please fix the ordering.");
    await h.evaluate();
    h.tick(60_000);
    h.state.ci = failing;
    h.state.during = async () => {
      h.tick(5_000);
      await h.evaluate();
    };
    expect(await h.runDue()).toEqual(["restarted"]);
    expect((await resumes(h.db)).map((resume) => resume.reason)).toEqual(["review"]);
    expect((await resumes(h.db))[0]?.handoff).not.toContain(CI_REVIEW_WAIT_SOURCE);
    expect(await listCiRounds(sqliteDb(h.db), "eng-1")).toEqual([]);
    expect((await getPullCiFailure(sqliteDb(h.db), "eng-1", HEAD))?.handledAt).toBeNull();
  });
});
