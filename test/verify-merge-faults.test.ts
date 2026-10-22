import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { FakeScript } from "../src/acp/testing/script";
import * as closeoutCommands from "../src/closeout-spec/run/exec";
import { JOB_KIND, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, getWorkItem, listJobs, migrate, openDatabase } from "../src/db";
import {
  INSTALLATION_PERMISSIONS,
  createFakeGitHub,
  fakeMergeReadiness,
  fakeRequiredChecks,
  type GitHubClient,
  type GitHubResponse,
} from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";

const exec = promisify(execFile);
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
  "%s: %s that persists fails the task with its reason",
  async (phase, fault) => {
    const result = await runWithFault(phase, fault, Infinity);
    expect(result.state, result.detail).toBe("failed");
    expect(result.errors.length, result.detail).toBe(1);
    expect(result.errors[0], result.detail).toStartWith("Stopped after");
    expect(result.questions, result.detail).toEqual([]);
    expect(result.pending, result.detail).toEqual([]);
  },
  120_000,
);

async function runWithFault(
  phase: Phase,
  fault: Fault,
  times: number,
): Promise<{
  state: string | null;
  errors: string[];
  questions: string[];
  pending: string[];
  injected: number;
  detail: string;
}> {
  const layout = await repoLayout();
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
  const inject = (active: boolean): boolean => {
    if (!active || remaining <= 0) return false;
    remaining -= 1;
    injected += 1;
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
          const target =
            phase === "merge readiness read"
              ? isMergeReadiness(req)
              : phase === "token mint" &&
                req.path.endsWith("/access_tokens") &&
                stateOf(db) === "merge_queue";
          if (inject(target)) {
            if (fault === "a rate limit")
              return { status: 429, body: { message: "API rate limit exceeded" } };
            throw thrown[fault]();
          }
          return client.request(req);
        },
      },
    },
    launch(input) {
      if (input.purpose === "review" && inject(phase === "reviewer launch")) throw thrown[fault]();
      sequence += 1;
      const scriptPath = path.join(layout.root, `fault-${sequence}.json`);
      const steps: FakeScript["steps"] =
        input.purpose === "implement"
          ? [
              { type: "fs_write", path: path.join(input.worktree, "ok.txt"), content: "ok\n" },
              { type: "end" },
            ]
          : [
              {
                type: "update",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "[]" },
                },
              },
              { type: "end", stopReason: "end_turn" },
            ];
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
      !["failed", "merged", "awaiting_input"].includes(stateOf(db) ?? "")
    ) {
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
      state: stateOf(db),
      errors: progress("error"),
      questions: progress("elicitation"),
      pending: listJobs(db)
        .filter((job) => job.status === "pending" || job.status === "running")
        .map((job) => job.queue),
      injected,
      detail: JSON.stringify({
        state: stateOf(db),
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

function stateOf(db: Database): string | null {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get("ENG-7");
  return row ? (getWorkItem(db, row.id)?.state ?? null) : null;
}

function isMergeReadiness(req: { path: string; body?: unknown }): boolean {
  return (
    req.path === "/graphql" &&
    typeof (req.body as { variables?: { head?: unknown } } | undefined)?.variables?.head ===
      "string"
  );
}

function githubClient(bare: string, github: ReturnType<typeof createFakeGitHub>): GitHubClient {
  let n = 0;
  return {
    async request(req): Promise<GitHubResponse> {
      if (req.path === "/graphql") {
        const { head } = (req.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      const required = fakeRequiredChecks(req);
      if (required) return required;
      if (req.path.endsWith("/access_tokens")) {
        n += 1;
        await github.mintInstallationToken({
          installationId: "2",
          repository: "pmdroid/paws-demo",
        });
        return {
          status: 201,
          body: {
            token: `ghs_faults_${n}`,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: "paws-demo", full_name: "pmdroid/paws-demo" }],
            permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read" },
          },
        };
      }
      if (req.method === "POST" && req.path.endsWith("/labels")) {
        if (req.path.includes("/issues/")) return { status: 200, body: [{ name: "paws" }] };
        return { status: 201, body: { name: "paws" } };
      }
      if (req.method === "POST" && req.path.endsWith("/pulls")) {
        const body = req.body as { title: string; head: string; base: string; body: string };
        const opened = await github.open({
          repository: "pmdroid/paws-demo",
          title: body.title,
          head: body.head,
          base: body.base,
          body: body.body,
        });
        return {
          status: 201,
          body: { number: opened.number, html_url: opened.url, body: body.body },
        };
      }
      if (req.method === "PUT" && req.path.endsWith("/merge")) {
        const body = req.body as { sha?: string; commit_message?: string };
        const number = Number(req.path.split("/").at(-2));
        await github.merge({
          repository: "pmdroid/paws-demo",
          number,
          expectedHeadSha: body.sha ?? "",
        });
        const sha = await squashBranch(bare, body.sha ?? "", body);
        return { status: 200, body: { sha, merged: true } };
      }
      return { status: 404, body: {} };
    },
  };
}

async function squashBranch(
  bare: string,
  expected: string,
  body: { commit_message?: string },
): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "paws-squash-"));
  try {
    await exec("git", ["clone", bare, tmp]);
    await gitIdentity(tmp);
    const listed = (
      await exec("git", [
        "-C",
        tmp,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/remotes/origin/paws",
      ])
    ).stdout.trim();
    const match = listed.split("\n").find((line) => line.startsWith(`${expected} `));
    if (!match) throw new Error(`no pushed branch at ${expected}`);
    const ref = match.slice(expected.length).trim();
    await exec("git", ["-C", tmp, "merge", "--squash", ref]);
    await exec("git", ["-C", tmp, "commit", "-m", body.commit_message ?? "squash"]);
    await exec("git", ["-C", tmp, "push", "origin", "HEAD:main"]);
    return (await exec("git", ["-C", tmp, "rev-parse", "HEAD"])).stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function repoLayout(): Promise<{
  root: string;
  bare: string;
  pawsRoot: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-verify-merge-faults-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await gitIdentity(seed);
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

async function gitIdentity(dir: string): Promise<void> {
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
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
