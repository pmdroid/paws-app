import { tickWithRestarts } from "./helpers";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentOptions } from "../src/acp";
import { reviewRequirements } from "../src/closeout";
import { JOB_KIND, MAX_TRANSIENT_RETRIES, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, listJobs, listOutbox, migrate, openDatabase } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { RemotePreparationTimeout } from "../src/runner-backend";
import { emptyReview, repoLayout, stateOf, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

test("a policy read that times out in git retries with backoff and asks no question", async () => {
  const result = await runPreflight({
    policy: "origin/main is unavailable: spawnSync git ETIMEDOUT",
    times: 2,
  });
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.retries, result.detail).toEqual([1, 2]);
  expect(result.questions, result.detail).toEqual([]);
}, 90_000);

test("a remote preparation that times out retries with backoff and asks no question", async () => {
  const result = await runPreflight({ preparation: true, times: 2 });
  expect(result.state, result.detail).toBe("running");
  expect(result.implemented, result.detail).toBe(true);
  expect(result.retries, result.detail).toEqual([1, 2]);
  expect(result.questions, result.detail).toEqual([]);
}, 90_000);

test("a remote preparation that keeps timing out asks once, naming preparation, after its retries", async () => {
  const result = await runPreflight({ preparation: true, times: Infinity });
  expect(result.state, result.detail).toBe("awaiting_input");
  expect(result.retries, result.detail).toEqual([1, 2, 3, 4, 5]);
  expect(result.questions, result.detail).toHaveLength(1);
  const [question] = result.questions;
  expect(question).toStartWith("Agent preparation needs your help.");
  expect(question).toContain(`Agent preparation failed after ${MAX_TRANSIENT_RETRIES} retries.`);
  expect(question).toContain("Remote agent preparation timed out");
  expect(question).not.toContain("Closeout");
  expect(question).not.toContain("Base: .");
}, 90_000);

test("a policy that does not parse still asks for Closeout help right away", async () => {
  const result = await runPreflight({
    policy: ".agents/closeout.yaml: invalid YAML",
    times: Infinity,
  });
  expect(result.state, result.detail).toBe("awaiting_input");
  expect(result.retries, result.detail).toEqual([]);
  expect(result.questions, result.detail).toHaveLength(1);
  expect(result.questions[0]).toStartWith("Closeout needs your help.");
  expect(result.questions[0]).toContain("Closeout: blocked\n.agents/closeout.yaml: invalid YAML");
}, 90_000);

async function runPreflight(fault: {
  /** The policy read fails with this message. */
  policy?: string;
  /** Remote agent preparation times out. */
  preparation?: boolean;
  times: number;
}): Promise<{
  state: string | null;
  /** The implementer turn started. Remote runs stop here, since Closeout would also run remotely. */
  implemented: boolean;
  retries: number[];
  questions: string[];
  detail: string;
}> {
  const layout = await repoLayout("paws-preflight-");
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
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  let remaining = fault.times;
  let sequence = 0;
  let implemented = false;
  let onStarted = () => {};
  const started = new Promise<void>((resolve) => (onStarted = resolve));
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    tracker,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    retryBaseMs: 10,
    reviewRequirements(...args) {
      if (fault.policy !== undefined && remaining > 0) {
        remaining -= 1;
        return { ok: false, message: fault.policy };
      }
      return reviewRequirements(...args);
    },
    ...(fault.preparation
      ? {
          remoteExecution: {
            agentForSession() {
              throw new Error("This fixture does not request a routing helper");
            },
            agentForItem() {
              return async (options: RunAgentOptions) => {
                if (options.prepareOnly && remaining > 0) {
                  remaining -= 1;
                  throw new RemotePreparationTimeout();
                }
                if (options.prepareOnly) return runAgent(options);
                // The implementer turn started, so preflight passed. Hold the turn until
                // shutdown, since Closeout would also run on the runner.
                implemented = true;
                onStarted();
                return new Promise<never>((_resolve, reject) => {
                  const abort = () => reject(options.signal?.reason ?? new Error("stopped"));
                  if (options.signal?.aborted) abort();
                  options.signal?.addEventListener("abort", abort, { once: true });
                });
              };
            },
          },
        }
      : {}),
    launch(input) {
      sequence += 1;
      const script = path.join(layout.root, `preflight-${sequence}.json`);
      writeFileSync(
        script,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps:
            input.purpose === "review"
              ? emptyReview().steps
              : [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }],
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
    },
  });
  let ticking: Promise<unknown> | undefined;
  try {
    await orchestrator.onLinearEvent(createdEvent());
    const deadline = Date.now() + 60_000;
    while (
      Date.now() < deadline &&
      !["merge_queue", "merged", "failed", "cancelled", "awaiting_input"].includes(
        stateOf(db, "ENG-7") ?? "",
      )
    ) {
      ticking = tickWithRestarts(jobs, orchestrator, db);
      const job = await Promise.race([ticking, started]);
      if (implemented) break;
      ticking = undefined;
      if (job === null) {
        outbox.tick();
        await Bun.sleep(20);
      }
    }
    const drainBy = Date.now() + 10_000;
    while (Date.now() < drainBy && listOutbox(db).some((row) => row.status === "pending")) {
      outbox.tick();
      await outbox.idle();
      await Bun.sleep(10);
    }
    return {
      state: stateOf(db, "ENG-7"),
      implemented,
      retries: listJobs(db)
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => (job.payload as { retry?: number }).retry ?? 0)
        .filter((retry) => retry > 0),
      questions: tracker.questions.map((question) => question.body),
      detail: JSON.stringify({
        items: db.query("SELECT linear_identifier, state FROM work_item").all(),
        jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
        progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
      }),
    };
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await ticking?.catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}

function createdEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:issue",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
