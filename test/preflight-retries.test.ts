import { tickWithRestarts } from "./helpers";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, runDir, type RunAgentOptions } from "../src/acp";
import { reviewRequirements } from "../src/closeout";
import { writeAgentSettings } from "../src/config";
import { JOB_KIND, MAX_TRANSIENT_RETRIES, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listJobs,
  listOutbox,
  listSystemFaults,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { RemotePreparationTimeout } from "../src/runner-backend";
import { emptyReview, repoLayout, stateOf, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

test("a policy read that times out parks with backoff and asks no question", async () => {
  const result = await runPreflight({
    policy: "origin/main is unavailable: spawnSync git ETIMEDOUT",
    times: 2,
  });
  expect(result.state, result.detail).toBe("running");
  expect(result.holds[0]?.faultClass).toBe("closeout-policy");
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

test("a policy that does not parse waits without a question", async () => {
  const result = await runPreflight({
    policy: ".agents/closeout.yaml: invalid YAML",
    times: Infinity,
  });
  expect(result.state, result.detail).toBe("running");
  expect(result.questions).toEqual([]);
  expect(result.holds[0]?.faultClass).toBe("closeout-policy");
}, 90_000);

for (const scope of ["paths: [src/**]", "minChangedLines: 100"] as const) {
  test(`a conditional review (${scope}) does not probe an unavailable reviewer before implementation`, async () => {
    const result = await runPreflight({
      preparation: true,
      times: 0,
      scope,
      unavailableReviewer: true,
    });
    expect(result.state, result.detail).toBe("running");
    expect(result.implemented, result.detail).toBe(true);
    expect(result.preparations).toEqual([]);
    expect(result.questions, result.detail).toEqual([]);
  }, 90_000);
}

test("an unconditional review still requires its reviewer to prepare", async () => {
  const result = await runPreflight({ preparation: true, times: 0, unavailableReviewer: true });
  expect(result.state, result.detail).toBe("running");
  expect(result.implemented).toBe(false);
  expect(result.questions).toEqual([]);
  expect(result.holds[0]?.faultClass).toBe("reviewer-profile");
}, 90_000);

test("reviewer preparation receives the configured fallback without adding one to implementation", async () => {
  const result = await runPreflight({ preparation: true, times: 0, reviewerFallback: true });
  expect(result.implemented, result.detail).toBe(true);
  expect(result.snapshot?.profiles.reviewer.model).toBeNull();
  expect(result.preparations).toEqual([
    { role: "implementer", fallbackProfile: undefined },
    { role: "reviewer", fallbackProfile: { agent: "codex", model: "fallback-review" } },
  ]);
}, 90_000);

async function runPreflight(fault: {
  /** The policy read fails with this message. */
  policy?: string;
  /** Remote agent preparation times out. */
  preparation?: boolean;
  times: number;
  scope?: string;
  unavailableReviewer?: boolean;
  reviewerFallback?: boolean;
}): Promise<{
  state: string | null;
  holds: ReturnType<typeof listSystemFaults>;
  /** The implementer turn started. Remote runs stop here, since Closeout would also run remotely. */
  implemented: boolean;
  retries: number[];
  questions: string[];
  detail: string;
  preparations: Array<Pick<RunAgentOptions, "role" | "fallbackProfile">>;
  snapshot?: { profiles: { reviewer: { model?: string | null } } };
}> {
  const layout = await repoLayout("paws-preflight-");
  if (fault.scope) {
    const seed = path.join(layout.root, "seed");
    const policyFile = path.join(seed, ".agents", "closeout.yaml");
    writeFileSync(
      policyFile,
      readFileSync(policyFile, "utf8").replace("    skill:", `    ${fault.scope}\n    skill:`),
    );
    execFileSync("git", ["-C", seed, "add", "."]);
    execFileSync("git", ["-C", seed, "commit", "-m", "scope review"]);
    execFileSync("git", ["-C", seed, "push", "origin", "HEAD:main"], { stdio: "pipe" });
    const requirements = reviewRequirements(seed, layout.home);
    expect(requirements.ok).toBe(true);
    if (requirements.ok)
      expect(requirements.items[0]).toMatchObject(
        fault.scope.startsWith("paths") ? { paths: ["src/**"] } : { minChangedLines: 100 },
      );
  }
  if (fault.reviewerFallback)
    writeAgentSettings(path.join(layout.pawsRoot, "config.toml"), {
      defaults: {
        implementer: { agent: "codex", model: "test-claude-model" },
        reviewer: { agent: "claude", model: null },
        reviewerFallback: { agent: "codex", model: "fallback-review" },
      },
      projects: [],
    });
  const preparations: Array<Pick<RunAgentOptions, "role" | "fallbackProfile">> = [];
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
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
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
                if (options.prepareOnly) {
                  preparations.push({
                    role: options.role,
                    fallbackProfile: options.fallbackProfile,
                  });
                  if (fault.unavailableReviewer && options.role === "reviewer")
                    throw new Error("Claude quota exhausted");
                  const prepared = await runAgent(options);
                  return fault.reviewerFallback && options.role === "reviewer"
                    ? {
                        ...prepared,
                        identity: {
                          session: "fallback-session",
                          provider: "openai",
                          model: "fallback-review",
                        },
                      }
                    : prepared;
                }
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
      if (implemented || listSystemFaults(db).length > 0) break;
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
    const run = db
      .query<{ id: string }, []>(
        "SELECT current_run_id AS id FROM work_item WHERE linear_identifier = 'ENG-7'",
      )
      .get();
    return {
      ...(run?.id
        ? {
            snapshot: JSON.parse(
              readFileSync(
                path.join(runDir(layout.pawsRoot, run.id), "agent-profile.json"),
                "utf8",
              ),
            ),
          }
        : {}),
      holds: listSystemFaults(db),
      state: stateOf(db, "ENG-7"),
      implemented,
      preparations,
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
