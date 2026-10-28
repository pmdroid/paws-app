import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import {
  FakeClock,
  JOB_KIND,
  MAX_TRANSIENT_RETRIES,
  RUNNER_CAPACITY_WAIT_MS,
  RunnerCapacityWait,
  systemClock,
} from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyLinearCommand,
  applyWorkItemEvent,
  enqueueJob,
  getWorkItem,
  listJobs,
  listOutbox,
  listRuns,
  migrate,
  openDatabase,
} from "../src/db";
import {
  LinearRateLimitError,
  LinearHttpError,
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  parseAgentEvent,
} from "../src/linear";
import { LinearTaskAccess, attachOrchestrator } from "../src/loop";
import { emptyReview, repoLayout, stateOf, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
const disconnect = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
const rateLimit = () =>
  new LinearRateLimitError(10, {
    requestsRemaining: 0,
    requestsLimit: null,
    requestsResetMs: null,
    complexityRemaining: null,
    complexityLimit: null,
    complexityResetMs: null,
    complexity: null,
  });

test.each([
  ["a request timeout", timeout],
  ["a dropped connection", disconnect],
])(
  "%s while a run starts is retried and the task still reaches Closeout",
  async (_label, error) => {
    const result = await runWithFault({ error, times: 1 });
    expect(result.state, result.detail).toBe("merge_queue");
    expect(result.errors, result.detail).toEqual([]);
    expect(result.retries, result.detail).toEqual([1]);
    expect(
      result.thoughts.some((body) => body.endsWith("Paws tries again in 1 s.")),
      result.detail,
    ).toBe(true);
    expect(result.runs, result.detail).toEqual(["implement:lost", "implement:ended"]);
    expect(result.implementations, result.detail).toBe(1);
  },
  90_000,
);

test("a tracker 503 retries without applying run_failed", async () => {
  const result = await runWithFault({
    error: () => new LinearHttpError(503, "", new Headers()),
    times: 1,
    tracker: true,
  });
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.retries, result.detail).toEqual([1]);
  expect(result.errors, result.detail).toEqual([]);
  expect(result.states, result.detail).not.toContain("failed");
}, 90_000);

test("a Linear rate limit while a run starts is waited out without a retry", async () => {
  const result = await runWithFault({ error: rateLimit, times: 1 });
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([]);
}, 90_000);

test("a failure that keeps coming back stops the task after its retries instead of leaving it stuck", async () => {
  const result = await runWithFault({ error: timeout, times: Infinity });
  expect(result.state, result.detail).toBe("failed");
  expect(result.retries, result.detail).toEqual([1, 2, 3, 4, 5]);
  expect(result.errors, result.detail).toEqual([
    `Stopped after ${MAX_TRANSIENT_RETRIES} retries. The operation timed out.`,
  ]);
  expect(result.implementations, result.detail).toBe(0);
  expect(
    result.jobs.filter((job) => job.startsWith(`${JOB_KIND.resume}:pending`)),
    result.detail,
  ).toEqual([]);
}, 90_000);

test("a 10-minute retry delay holds no job worker and the task resumes after it", async () => {
  const clock = new FakeClock(Date.now());
  const result = await runWithFault({
    error: () => Object.assign(timeout(), { retryAfterMs: 10 * 60_000 }),
    times: 1,
    clock,
  });
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.retries, result.detail).toEqual([1]);
  expect(result.waits, result.detail).toEqual([{ delayMs: 10 * 60_000, runningJobs: 0 }]);
  expect(result.runs, result.detail).toEqual(["implement:lost", "implement:ended"]);
}, 90_000);

const HOUR_MS = 60 * 60_000;
/** Queues whose pending job is the item's next attempt: a parked slot wait keeps its own queue. */
const AGENT_QUEUES: string[] = [JOB_KIND.start, JOB_KIND.resume];
const busyRunner = () => new RunnerCapacityWait(["runner-1"]);

test("waiting eight hours for a slot on a busy runner keeps the task deferred without failing", async () => {
  const clock = new FakeClock(Date.now());
  const result = await runWithFault({
    error: busyRunner,
    times: Infinity,
    clock,
    untilMs: 8 * HOUR_MS,
  });
  expect(["running", "recovering"], result.detail).toContain(result.state!);
  // The wait is never counted as a failed attempt.
  expect(new Set(result.retries), result.detail).toEqual(new Set([0]));
  expect(result.states, result.detail).not.toContain("failed");
  expect(result.events, result.detail).not.toContain("run_failed");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.waits.length, result.detail).toBeGreaterThan(30);
  expect(Math.max(...result.waits.map((wait) => wait.delayMs)), result.detail).toBeLessThanOrEqual(
    4 * 60_000,
  );
  expect(result.capacityWait, result.detail).toEqual({
    since: expect.any(Number),
    attempt: expect.any(Number),
    runnerIds: ["runner-1"],
  });
  expect(result.implementations, result.detail).toBe(0);
}, 90_000);

test("a slot wait keeps the run and the state, and the turn starts once the slot frees", async () => {
  const clock = new FakeClock(Date.now());
  const result = await runWithFault({ error: busyRunner, times: 3, clock });
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.waits.length, result.detail).toBe(3);
  expect(result.events, result.detail).not.toContain("lease_expired");
  expect(result.events, result.detail).not.toContain("recovered");
  // One run row for the task, however many times it waited for the slot.
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
  expect(result.implementations, result.detail).toBe(1);
}, 90_000);

test("an accepted item that waits for a slot starts no implement run and stays accepted", async () => {
  const clock = new FakeClock(Date.now());
  const result = await runWithFault({ error: busyRunner, times: 1, clock, afterAccepted: true });
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.acceptedHead, result.detail).toMatch(/^[0-9a-f]{40}$/);
  expect(result.implementations, result.detail).toBe(1);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
  expect(
    result.jobs.filter((job) => job.startsWith(`${JOB_KIND.resume}:pending`)),
    result.detail,
  ).toEqual([]);
}, 90_000);

test("a busy runner wait wrapped by agent preparation keeps the task deferred without asking", async () => {
  const clock = new FakeClock(Date.now());
  const result = await runWithFault({
    error: () =>
      new Error(`implementer preparation failed: ${busyRunner().message}`, {
        cause: busyRunner(),
      }),
    times: Infinity,
    clock,
    untilMs: 3 * HOUR_MS,
  });
  expect(["running", "recovering"], result.detail).toContain(result.state!);
  expect(new Set(result.retries), result.detail).toEqual(new Set([0]));
  expect(result.states, result.detail).not.toContain("failed");
  expect(result.states, result.detail).not.toContain("awaiting_input");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.capacityWait, result.detail).toMatchObject({ runnerIds: ["runner-1"] });
}, 90_000);

test("a wait with no runner offered still stops the task after the hour and its retries", async () => {
  const clock = new FakeClock(Date.now());
  const result = await runWithFault({
    error: () => new RunnerCapacityWait([]),
    times: Infinity,
    clock,
    // Each transient retry waits its own hour before it counts.
    untilMs: 12 * HOUR_MS,
  });
  expect(result.state, result.detail).toBe("failed");
  expect(result.elapsedMs, result.detail).toBeGreaterThanOrEqual(
    (MAX_TRANSIENT_RETRIES + 1) * RUNNER_CAPACITY_WAIT_MS,
  );
  expect(result.errors, result.detail).toEqual([
    `Stopped after ${MAX_TRANSIENT_RETRIES} retries. Waiting for a paired runner to come online`,
  ]);
}, 90_000);

test("a busy runner wait that outlasts the hour, then loses its runners, gets a fresh hour", async () => {
  const clock = new FakeClock(Date.now());
  const start = clock.now();
  const result = await runWithFault({
    error: () => (clock.now() - start < 2 * HOUR_MS ? busyRunner() : new RunnerCapacityWait([])),
    times: Infinity,
    clock,
    untilMs: 2 * HOUR_MS + 30 * 60_000,
  });
  expect(["running", "recovering"], result.detail).toContain(result.state!);
  expect(result.capacityWait, result.detail).toMatchObject({ runnerIds: [] });
}, 90_000);

test("Stop while the task waits for a busy runner cancels it", async () => {
  const clock = new FakeClock(Date.now());
  const result = await runWithFault({
    error: busyRunner,
    times: Infinity,
    clock,
    stopAtMs: 2 * HOUR_MS,
  });
  expect(result.state, result.detail).toBe("cancelled");
  expect(result.elapsedMs, result.detail).toBeLessThan(2 * HOUR_MS + 5 * 60_000);
  expect(
    result.jobs.filter((job) => job.startsWith(`${JOB_KIND.resume}:pending`)),
    result.detail,
  ).toEqual([]);
}, 90_000);

async function runWithFault(fault: {
  error: () => unknown;
  times: number;
  tracker?: boolean;
  clock?: FakeClock;
  /** Stops driving the loop once the fake clock has moved this far. */
  untilMs?: number;
  /** Applies Stop once the fake clock has moved this far. */
  stopAtMs?: number;
  /**
   * Faults start only once Closeout accepted the task. The accepted item is then resumed with
   * nothing new for the agent, the way a recovery resumes it.
   */
  afterAccepted?: boolean;
}): Promise<{
  state: string | null;
  states: (string | null)[];
  thoughts: string[];
  errors: string[];
  retries: number[];
  runs: string[];
  jobs: string[];
  implementations: number;
  waits: { delayMs: number; runningJobs: number }[];
  events: string[];
  acceptedHead: string | null;
  capacityWait: unknown;
  elapsedMs: number;
  detail: string;
}> {
  const layout = await repoLayout("paws-faults-");
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-7",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  const access = createFakeLinearAccessReads({
    installation: scope,
    sessions: [{ ...scope, sessionId: "ses_1", issueId: "issue", teamId: "team" }],
    teams: ["team"],
  });
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "issue",
    teamId: "team",
    assigneeId: "pascal",
    delegateId: null,
    stateType: "unstarted",
  });
  const clock = fault.clock ?? systemClock;
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const waits: { delayMs: number; runningJobs: number }[] = [];
  let implementations = 0;
  let sequence = 0;
  let orchestrator: ReturnType<typeof attachOrchestrator>;
  const gate = new LinearTaskAccess(db, {
    access: access.adapter,
    lifecycle,
    oauthClientId: scope.oauthClientId,
    appUserId: scope.appUserId,
    stopSession: () => {},
    interruptSession: (sessionId) => orchestrator.interruptLinearSession(sessionId),
  });
  orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    tracker,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
    linearTaskModes: true,
    linearAccess: gate,
    retryBaseMs: 10,
    placementPollMs: 1_000,
    clock,
    launch(input) {
      sequence += 1;
      if (input.purpose === "implement") implementations += 1;
      const steps: FakeScript["steps"] =
        input.purpose === "classify"
          ? [
              {
                type: "update",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: '{"mode":"code"}' },
                },
              },
              { type: "end" },
            ]
          : input.purpose === "review"
            ? emptyReview().steps
            : [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }];
      const script = path.join(layout.root, `fault-${sequence}.json`);
      writeFileSync(
        script,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
    },
  });
  const startCodeIssue = lifecycle.startCodeIssue;
  let remaining = fault.afterAccepted ? 0 : fault.times;
  let reopened = false;
  const states: (string | null)[] = [];
  const listSessionActivities = tracker.listSessionActivities!;
  if (fault.tracker)
    tracker.listSessionActivities = async (...args) => {
      if (fault.tracker && remaining > 0 && stateOf(db, "ENG-7") === "running") {
        remaining -= 1;
        throw fault.error();
      }
      return listSessionActivities ? listSessionActivities(...args) : [];
    };
  lifecycle.startCodeIssue = async (input, options) => {
    if (!fault.tracker && remaining > 0 && stateOf(db, "ENG-7") === "running") {
      remaining -= 1;
      throw fault.error();
    }
    return startCodeIssue(input, options);
  };
  try {
    const event = parseAgentEvent(
      JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        ...scope,
        agentSession: {
          id: "ses_1",
          creatorId: "pascal",
          issue: { id: "issue", team: { id: "team" } },
        },
      }),
      "delivery:created",
      Date.now(),
    )!;
    expect(await gate.accept(event)).toBe(true);
    await orchestrator.onLinearEvent(event);
    const deadline = Date.now() + 60_000;
    const reopen = () => {
      reopened = true;
      const item = getWorkItem(db, itemIdOf(db))!;
      if (item.state !== "merge_queue") return false;
      db.run("UPDATE job SET status='cancelled' WHERE status='pending'");
      applyWorkItemEvent(db, item.id, "lease_expired");
      applyWorkItemEvent(db, item.id, "lease_expired");
      enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: { itemId: item.id, reason: "recovery" },
        now: clock.now(),
      });
      remaining = fault.times;
      return true;
    };
    const startedAt = clock.now();
    let stopped = false;
    while (
      Date.now() < deadline &&
      (!["merge_queue", "merged", "failed", "cancelled"].includes(stateOf(db, "ENG-7") ?? "") ||
        (fault.afterAccepted === true && !reopened && reopen())) &&
      (fault.untilMs === undefined || clock.now() - startedAt < fault.untilMs)
    ) {
      if (!stopped && fault.stopAtMs !== undefined && clock.now() - startedAt >= fault.stopAtMs) {
        applyLinearCommand(db, {
          type: "stop",
          itemId: itemIdOf(db),
          source: "linear",
          requestedAt: clock.now(),
        });
        stopped = true;
      }
      states.push(stateOf(db, "ENG-7"));
      if ((await jobs.tick()) === null) {
        outbox.tick();
        await Bun.sleep(25);
        const delayed = listJobs(db).find(
          (job) => AGENT_QUEUES.includes(job.queue) && job.status === "pending",
        );
        if (fault.clock && delayed && delayed.runAt > clock.now()) {
          waits.push({
            delayMs: delayed.runAt - clock.now(),
            runningJobs: listJobs(db).filter((job) => job.status === "running").length,
          });
          fault.clock.advance(delayed.runAt - clock.now());
        }
      }
    }
    const drainBy = Date.now() + 10_000;
    while (Date.now() < drainBy && listOutbox(db).some((row) => row.status === "pending")) {
      outbox.tick();
      await outbox.idle();
      await Bun.sleep(10);
    }
    const progress = (kind: string) =>
      tracker.progress.filter((update) => update.kind === kind).map((update) => update.body);
    const pendingResume = listJobs(db).find(
      (job) => AGENT_QUEUES.includes(job.queue) && job.status === "pending",
    );
    return {
      events: db
        .query(
          "SELECT event FROM work_item_event WHERE item_id=(SELECT id FROM work_item WHERE linear_identifier='ENG-7')",
        )
        .all()
        .map((row) => (row as { event: string }).event),
      acceptedHead: getWorkItem(db, itemIdOf(db))?.acceptedHead ?? null,
      capacityWait: (pendingResume?.payload as { capacityWait?: unknown } | undefined)
        ?.capacityWait,
      elapsedMs: clock.now() - startedAt,
      state: stateOf(db, "ENG-7"),
      states,
      thoughts: progress("thought"),
      errors: progress("error"),
      retries: listJobs(db)
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => (job.payload as { retry?: number }).retry ?? 0),
      runs: listRuns(db).map((run) => `${run.kind}:${run.status}`),
      jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
      implementations,
      waits,
      detail: JSON.stringify({
        items: db.query("SELECT linear_identifier, state FROM work_item").all(),
        jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
        progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
      }),
    };
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}

function itemIdOf(db: ReturnType<typeof openDatabase>): string {
  return (
    db.query("SELECT id FROM work_item WHERE linear_identifier='ENG-7'").get() as {
      id: string;
    }
  ).id;
}
