import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { JOB_KIND, MAX_TRANSIENT_RETRIES, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listJobs,
  listOutbox,
  listRuns,
  migrate,
  openDatabase,
} from "../src/db";
import {
  LinearRateLimitError,
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  parseAgentEvent,
} from "../src/linear";
import { LinearTaskAccess, attachOrchestrator } from "../src/loop";
import { emptyReview, repoLayout, stateOf, writeOk } from "./e2e-harness";

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

async function runWithFault(fault: { error: () => unknown; times: number }): Promise<{
  state: string | null;
  thoughts: string[];
  errors: string[];
  retries: number[];
  runs: string[];
  jobs: string[];
  implementations: number;
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
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
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
    jobs,
    outbox,
    tracker,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    linearTaskModes: true,
    linearAccess: gate,
    retryBaseMs: 10,
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
  const session = access.adapter.session;
  let remaining = fault.times;
  access.adapter.session = async (id, options) => {
    if (remaining > 0 && stateOf(db, "ENG-7") === "running") {
      remaining -= 1;
      throw fault.error();
    }
    return session(id, options);
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
    while (
      Date.now() < deadline &&
      !["merge_queue", "merged", "failed"].includes(stateOf(db, "ENG-7") ?? "")
    ) {
      if ((await jobs.tick()) === null) {
        outbox.tick();
        await Bun.sleep(25);
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
    return {
      state: stateOf(db, "ENG-7"),
      thoughts: progress("thought"),
      errors: progress("error"),
      retries: listJobs(db)
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => (job.payload as { retry?: number }).retry ?? 0),
      runs: listRuns(db).map((run) => `${run.kind}:${run.status}`),
      jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
      implementations,
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
