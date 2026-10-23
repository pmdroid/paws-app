import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { JOB_KIND, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  accrueAwake,
  getWorkItem,
  listJobs,
  listWorkItems,
  markRun,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeGitHub, type GitHubResponse } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { emptyReview, githubClient, repoLayout, stateOf, writeOk } from "./e2e-harness";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

test("a failing pull-request step is retried from the accepted candidate without a new agent run", async () => {
  const result = await runAccepted({ failedPullRequests: 2 });
  expect(result.state, result.detail).toBe("merged");
  expect(result.pullRequestPosts, result.detail).toBe(3);
  expect(result.pullRequests, result.detail).toBe(1);
  expect(result.implementRuns, result.detail).toBe(1);
  expect(result.errors, result.detail).toEqual([]);
  expect(result.questions, result.detail).toEqual([]);
  expect(result.mergeAttempts, result.detail).toBe(3);
}, 120_000);

test("an agent session past its time cap after Closeout accepted the candidate still ends in a pull request", async () => {
  const result = await runAccepted({ failedPullRequests: 1, capAfterAcceptance: true });
  expect(result.capChecked, result.detail).toBe(true);
  expect(result.state, result.detail).toBe("merged");
  expect(result.pullRequests, result.detail).toBe(1);
  expect(result.implementRuns, result.detail).toBe(1);
  expect(result.errors, result.detail).toEqual([]);
}, 120_000);

test("a pull-request step that keeps failing names the branch when its retries are exhausted", async () => {
  const result = await runAccepted({ failedPullRequests: Infinity });
  expect(result.state, result.detail).toBe("failed");
  expect(result.implementRuns, result.detail).toBe(1);
  expect(result.pullRequests, result.detail).toBe(0);
  expect(result.errors, result.detail).toEqual([
    expect.stringMatching(
      /^Stopped after 3 attempts\. .*\. The accepted work is on branch `paws\/eng-8-[a-z0-9]+`\.$/,
    ),
  ]);
}, 120_000);

async function runAccepted(options: {
  failedPullRequests: number;
  capAfterAcceptance?: boolean;
}): Promise<{
  state: string | null;
  implementRuns: number;
  pullRequestPosts: number;
  pullRequests: number;
  mergeAttempts: number;
  capChecked: boolean;
  errors: string[];
  questions: string[];
  detail: string;
}> {
  const layout = await repoLayout("paws-accepted-candidate-");
  const tracker = createFakeTracker([
    {
      linearIssueId: "accepted",
      identifier: "ENG-8",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock, { backoffBaseMs: 10 });
  const outbox = new OutboxDispatcher(db, systemClock);
  const github = createFakeGitHub();
  const client = githubClient(layout.bare, github);
  let remainingFailures = options.failedPullRequests;
  let pullRequestPosts = 0;
  let implementRuns = 0;
  let sequence = 0;
  let capChecked = false;
  const realSetTimeout = globalThis.setTimeout;
  const quickReadRetries = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    ms?: number,
  ) => realSetTimeout(handler, ms === 10_000 ? 1 : ms)) as unknown as typeof setTimeout);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    retryBaseMs: 10,
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client: {
        async request(req): Promise<GitHubResponse> {
          if (req.method === "POST" && req.path.endsWith("/pulls")) {
            pullRequestPosts += 1;
            if (remainingFailures > 0) {
              remainingFailures -= 1;
              return { status: 502, body: { message: "Server Error" } };
            }
          }
          return client.request(req);
        },
      },
    },
    launch(input) {
      sequence += 1;
      if (input.purpose === "implement") implementRuns += 1;
      const scriptPath = path.join(layout.root, `accepted-${sequence}.json`);
      const steps: FakeScript["steps"] =
        input.purpose === "implement"
          ? [writeOk(input.worktree), { type: "end" }]
          : emptyReview().steps;
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
    },
  });
  try {
    await orchestrator.onLinearEvent(linearEvent());
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !["failed", "merged"].includes(stateOf(db, "ENG-8") ?? "")) {
      db.run("UPDATE job SET max_attempts = 3 WHERE queue = ? AND status = 'pending'", [
        JOB_KIND.merge,
      ]);
      const item = listWorkItems(db).find((entry) => entry.linearIdentifier === "ENG-8");
      if (options.capAfterAcceptance && !capChecked && item?.state === "merge_queue") {
        // The agent's session is still open, and the task is past its awake time cap.
        const runId = item.currentRunId;
        if (runId) markRun(db, runId, "active", Date.now());
        db.run("UPDATE work_item SET max_awake_ms = 1, awake_ms = 60000 WHERE id = ?", [item.id]);
        accrueAwake(db, item.id, 0, Date.now());
        expect(accrueAwake(db, item.id, 4 * 60 * 60_000, Date.now()).capped).toBe(false);
        if (runId) markRun(db, runId, "ended", Date.now());
        capChecked = true;
      }
      if ((await jobs.tick()) === null) {
        outbox.tick();
        await Bun.sleep(25);
      }
    }
    while (outbox.tick().length > 0) await outbox.idle();
    const progress = (kind: string) =>
      tracker.progress.filter((update) => update.kind === kind).map((update) => update.body);
    const item = listWorkItems(db).find((entry) => entry.linearIdentifier === "ENG-8");
    const merges = listJobs(db).filter((job) => job.queue === JOB_KIND.merge);
    return {
      state: stateOf(db, "ENG-8"),
      implementRuns,
      pullRequestPosts,
      pullRequests: pullRequestPosts - Math.min(pullRequestPosts, options.failedPullRequests),
      mergeAttempts: merges.reduce((total, job) => total + job.attempts, 0),
      capChecked,
      errors: progress("error"),
      questions: progress("elicitation"),
      detail: JSON.stringify({
        state: item ? getWorkItem(db, item.id)?.state : null,
        jobs: listJobs(db).map(
          (job) => `${job.queue}:${job.status}:${job.attempts}:${job.lastError ?? ""}`,
        ),
        progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
      }),
    };
  } finally {
    quickReadRetries.mockRestore();
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}

function linearEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:accepted",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "accepted",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
