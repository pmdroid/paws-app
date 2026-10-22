import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { FakeScript } from "../src/acp/testing/script";
import { JOB_KIND, MAX_TRANSIENT_RETRIES, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  listJobs,
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

const exec = promisify(execFile);
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
  const layout = await repoLayout();
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
            ? [
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "[]" },
                  },
                },
                { type: "end", stopReason: "end_turn" },
              ]
            : [
                { type: "fs_write", path: path.join(input.worktree, "ok.txt"), content: "ok\n" },
                { type: "end", stopReason: "end_turn" },
              ];
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
    if (remaining > 0 && stateOf(db) === "running") {
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
      !["merge_queue", "merged", "failed"].includes(stateOf(db) ?? "")
    ) {
      if ((await jobs.tick()) === null) {
        outbox.tick();
        await Bun.sleep(25);
      }
    }
    // The fault also hits the outbox's session read while the task runs, so a delivery can be
    // backing off when the task stops; wait it out, since later rows in the session queue behind it.
    const drained = Date.now() + 15_000;
    while (
      Date.now() < drained &&
      db.query("SELECT 1 FROM outbox WHERE status='pending' LIMIT 1").get() !== null
    ) {
      if (outbox.tick().length > 0) await outbox.idle();
      else await Bun.sleep(50);
    }
    const progress = (kind: string) =>
      tracker.progress.filter((update) => update.kind === kind).map((update) => update.body);
    return {
      state: stateOf(db),
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

function stateOf(db: Database): string | null {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get("ENG-7");
  return row ? (getWorkItem(db, row.id)?.state ?? null) : null;
}

async function repoLayout(): Promise<{
  root: string;
  bare: string;
  pawsRoot: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-faults-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  for (const [key, value] of [
    ["user.email", "paws-test@example.com"],
    ["user.name", "Paws Test"],
    ["commit.gpgsign", "false"],
  ])
    await exec("git", ["-C", seed, "config", key!, value!]);
  await mkdir(path.join(seed, ".agents", "skills", "adversarial-review"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), CLOSEOUT_POLICY);
  await writeFile(
    path.join(seed, ".agents", "skills", "adversarial-review", "SKILL.md"),
    REVIEW_SKILL,
  );
  await writeFile(path.join(seed, "check.test.ts"), SEEDED_TEST);
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return { root, bare, pawsRoot, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const CLOSEOUT_POLICY = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test", "check.test.ts"]
    timeoutSeconds: 60
  - id: adversarial-review
    kind: review
    gate: beforePR
    skill: .agents/skills/adversarial-review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
`;

const REVIEW_SKILL = `---
name: adversarial-review
description: Review the candidate. Report findings. Do not decide acceptance.
---

# Review

Report findings. An empty list means the change is fine.
`;

const SEEDED_TEST = `import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("seeded check", () => {
  expect(existsSync("ok.txt")).toBe(true);
});
`;
