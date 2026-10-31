import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import * as closeoutCommands from "../src/closeout-spec/run/exec";
import { JOB_KIND, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listJobs,
  listSystemFaults,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeGitHub, type GitHubResponse } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import {
  emptyReview,
  githubClient,
  isMergeReadiness,
  repoLayout,
  stateOf,
  writeOk,
} from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;
const REVIEW_RETRY_WAITS = new Set([30_000, 120_000, 300_000]);

type Phase = "command runner" | "reviewer launch" | "merge readiness read" | "token mint";
type Fault = "a timeout" | "a dropped connection" | "a rate limit";

const thrown: Record<Fault, () => unknown> = {
  "a timeout": () => new DOMException("The operation timed out.", "TimeoutError"),
  "a dropped connection": () =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    }),
  "a rate limit": () =>
    Object.assign(new Error("429 Too Many Requests: rate limit exceeded"), { status: 429 }),
};

const phases: Phase[] = ["command runner", "reviewer launch", "merge readiness read", "token mint"];
const faults: Fault[] = ["a timeout", "a dropped connection", "a rate limit"];
const cells = phases.flatMap((phase) => faults.map((fault) => [phase, fault] as const));
const MINT_RETRY_AFTER_MS = 400;

test.each(cells)(
  "%s: %s once is retried and the task merges",
  async (phase, fault) => {
    const result = await runWithFault(phase, fault, 1);
    expect(result.state, result.detail).toBe("merged");
    expect(result.errors, result.detail).toEqual([]);
    expect(result.questions, result.detail).toEqual([]);
    expect(result.injected, result.detail).toBe(1);
  },
  120_000,
);

test.each(cells)(
  "%s: %s that persists retains its recovery policy",
  async (phase, fault) => {
    const result = await runWithFault(phase, fault, Infinity);
    if (phase === "reviewer launch") {
      expect(result.state, result.detail).toBe("verifying");
      expect(result.holds[0]?.faultClass).toBe("reviewer-profile");
      expect(result.errors).toEqual([]);
      expect(result.questions).toEqual([]);
      expect(result.pending).toContain(JOB_KIND.reverify);
      return;
    }
    expect(result.state, result.detail).toBe("failed");
    const terminal = phase === "merge readiness read" ? result.closed : result.errors;
    expect(terminal.length, result.detail).toBe(1);
    expect(terminal[0], result.detail).toStartWith(
      phase === "merge readiness read" ? "Closed: Stopped after" : "Stopped after",
    );
    expect(result.questions, result.detail).toEqual([]);
    expect(result.pending, result.detail).toEqual([]);
    if (phase === "token mint" && fault === "a rate limit") {
      expect(result.errors[0], result.detail).toContain("rate limited");
      const gaps = result.injectedAt.slice(1).map((at, i) => at - result.injectedAt[i]!);
      expect(gaps.length, result.detail).toBeGreaterThan(0);
      for (const gap of gaps)
        expect(gap, result.detail).toBeGreaterThanOrEqual(MINT_RETRY_AFTER_MS);
    }
  },
  120_000,
);

async function runWithFault(
  phase: Phase,
  fault: Fault,
  times: number,
): Promise<{
  state: string | null;
  holds: ReturnType<typeof listSystemFaults>;
  errors: string[];
  closed: string[];
  questions: string[];
  pending: string[];
  injected: number;
  injectedAt: number[];
  detail: string;
}> {
  const layout = await repoLayout("paws-verify-merge-faults-");
  const tracker = createFakeTracker([
    {
      linearIssueId: "fault",
      identifier: "ENG-7",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock, { backoffBaseMs: 10 });
  const outbox = new OutboxDispatcher(db, systemClock);
  const client = githubClient(layout.bare, createFakeGitHub());
  let remaining = times;
  let injected = 0;
  const injectedAt: number[] = [];
  const inject = (active: boolean): boolean => {
    if (!active || remaining <= 0) return false;
    remaining -= 1;
    injected += 1;
    injectedAt.push(Date.now());
    return true;
  };
  const realSetTimeout = globalThis.setTimeout;
  const quickWaits = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    ms?: number,
  ) => realSetTimeout(handler, shortened(ms) ? 1 : ms)) as unknown as typeof setTimeout);
  const realCommands = closeoutCommands.createCommandRunner;
  const flakyCommands = spyOn(closeoutCommands, "createCommandRunner").mockImplementation(
    (options) => {
      const runner = realCommands(options);
      return {
        ...runner,
        async runLogged(request) {
          if (inject(phase === "command runner")) throw thrown[fault]();
          return runner.runLogged(request);
        },
      };
    },
  );
  let sequence = 0;
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
    retryBaseMs: 10,
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client: {
        async request(req): Promise<GitHubResponse> {
          const target =
            phase === "merge readiness read"
              ? isMergeReadiness(req)
              : phase === "token mint" &&
                req.path.endsWith("/access_tokens") &&
                stateOf(db, "ENG-7") === "merge_queue";
          if (inject(target)) {
            if (fault === "a rate limit")
              return {
                status: 429,
                body: { message: "API rate limit exceeded" },
                retryAfterMs: MINT_RETRY_AFTER_MS,
              };
            throw thrown[fault]();
          }
          return client.request(req);
        },
      },
    }),
    launch(input) {
      if (input.purpose === "review" && inject(phase === "reviewer launch")) throw thrown[fault]();
      sequence += 1;
      const scriptPath = path.join(layout.root, `fault-${sequence}.json`);
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
    while (
      Date.now() < deadline &&
      !["failed", "merged", "awaiting_input"].includes(stateOf(db, "ENG-7") ?? "")
    ) {
      if (listSystemFaults(db).length > 0) {
        if (times === Infinity) break;
        db.run("UPDATE job SET run_at=0 WHERE status='pending'");
      }
      db.run("UPDATE job SET max_attempts = 3 WHERE queue IN (?, ?) AND status = 'pending'", [
        JOB_KIND.merge,
        JOB_KIND.reverify,
      ]);
      if ((await jobs.tick()) === null) {
        outbox.tick();
        await Bun.sleep(25);
      }
    }
    while (outbox.tick().length > 0) await outbox.idle();
    const progress = (kind: string) =>
      tracker.progress.filter((update) => update.kind === kind).map((update) => update.body);
    return {
      state: stateOf(db, "ENG-7"),
      holds: listSystemFaults(db),
      errors: progress("error"),
      closed: progress("response").filter((body) => body.startsWith("Closed:")),
      questions: progress("elicitation"),
      pending: listJobs(db)
        .filter((job) => job.status === "pending" || job.status === "running")
        .map((job) => job.queue),
      injected,
      injectedAt,
      detail: JSON.stringify({
        state: stateOf(db, "ENG-7"),
        jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
        progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
      }),
    };
  } finally {
    quickWaits.mockRestore();
    flakyCommands.mockRestore();
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}

function shortened(ms: number | undefined): boolean {
  if (ms === 10_000) return true;
  return (
    ms !== undefined &&
    REVIEW_RETRY_WAITS.has(ms) &&
    new Error().stack?.includes("reviewWithRetries") === true
  );
}

function linearEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:fault",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "fault",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
