import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeFakeCloseout, type FakeStep } from "./fake-cli";
import { createCloseoutGate } from "./gate";
import type { FixRunner } from "./fixer";
import { runCloseoutGate } from "./run";
import type { CodexReviewer } from "./reviewer";
import { MAX_FIX_ATTEMPTS } from "./types";

const exec = promisify(execFile);
const BASE = "a".repeat(40);
const TASK = "ENG-123";

function template(decision: string, items: unknown[]): FakeStep {
  return {
    exit: decision === "accepted" ? 0 : decision === "rejected" ? 1 : 3,
    decision: {
      specVersion: "0.1",
      decision,
      gate: "beforePR",
      base: BASE,
      head: "b".repeat(40),
      candidate: { task: TASK, session: "impl-session", model: "claude", provider: "anthropic" },
      policy: {
        path: ".agents/closeout.yaml",
        digest: `sha256:${"c".repeat(64)}`,
        absent: false,
      },
      items,
      warnings: [],
    },
  };
}

const passed = { id: "typecheck", kind: "command", state: "passed", message: "exited 0" };
const failed = { id: "typecheck", kind: "command", state: "failed", message: "exited 1" };
const missingReview = {
  id: "adversarial-review",
  kind: "review",
  state: "missing",
  message: "no evidence for this candidate and policy",
};

describe("closeout gate", () => {
  test("feeds a failing command back and accepts on attempt 2", async () => {
    const repo = await gitRepo();
    const fake = await writeFakeCloseout(repo.root, {
      version: "0.1.0",
      steps: [template("rejected", [failed]), template("accepted", [passed])],
    });
    const fixes: number[] = [];
    const previousToken = process.env.GITHUB_TOKEN;
    const previousSsh = process.env.SSH_AUTH_SOCK;
    process.env.GITHUB_TOKEN = "ghs_should_not_leak";
    process.env.SSH_AUTH_SOCK = "/tmp/agent-ssh";
    let result;
    try {
      result = await runCloseoutGate({
        worktree: repo.dir,
        taskId: TASK,
        base: BASE,
        head: repo.head,
        candidate: candidate(),
        closeoutBin: fake.bin,
        reviewer: throwingReviewer(),
        fixer: committingFixer(repo.dir, fixes),
        reportDir: path.join(repo.root, "report"),
        recorder: {
          async record(verdict) {
            expect(verdict.outcome).toBe("accepted");
          },
        },
      });
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
      if (previousSsh === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousSsh;
    }
    expect(result.outcome).toBe("accepted");
    expect(result.fixAttempts).toBe(1);
    expect(result.evaluations).toBe(2);
    expect(fixes).toEqual([1]);
    expect(result.summary).toContain("typecheck");
    const report = await readFile(path.join(repo.root, "report", "closeout-verdict.json"), "utf8");
    expect(report).toContain('"outcome": "accepted"');
    const calls = (await fake.invocations()).filter((call) => !call.argv.includes("--version"));
    expect(calls.every((call) => call.argv.includes("--task") && call.argv.includes(TASK))).toBe(
      true,
    );
    expect(calls.every((call) => call.githubToken === false && call.ssh === false)).toBe(true);
    await repo.cleanup();
  });

  test("exhausts the item after two failed fixes and does not ask for a third", async () => {
    const repo = await gitRepo();
    const fake = await writeFakeCloseout(repo.root, {
      version: "0.1.0",
      steps: [
        template("rejected", [failed]),
        template("rejected", [failed]),
        template("rejected", [failed]),
      ],
    });
    const fixes: number[] = [];
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: BASE,
      head: repo.head,
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: throwingReviewer(),
      fixer: committingFixer(repo.dir, fixes),
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.fixAttempts).toBe(MAX_FIX_ATTEMPTS);
    expect(fixes).toEqual([1, 2]);
    expect(result.evaluations).toBe(3);
    await repo.cleanup();
  });

  test("records review evidence, then a fix, then accepts", async () => {
    const repo = await gitRepo();
    const fake = await writeFakeCloseout(repo.root, {
      version: "0.1.0",
      steps: [
        { ...template("blocked", [failed, missingReview]), marker: true },
        { exit: 0 },
        template("rejected", [
          failed,
          { ...missingReview, state: "passed", message: "no failing findings" },
        ]),
        template("blocked", [passed, missingReview]),
        { exit: 0 },
        template("accepted", [
          passed,
          { ...missingReview, state: "passed", message: "no failing findings" },
        ]),
      ],
    });
    const reviews: string[] = [];
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: BASE,
      head: repo.head,
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: {
        async review(request) {
          reviews.push(request.itemId);
          return {
            session: "codex-session",
            model: "gpt-5-codex",
            provider: "openai",
            findings: [
              {
                severity: "P2",
                location: "src/export",
                explanation: "export skips the header row",
                evidence: "the test output shows one missing column name",
              },
            ],
          };
        },
      },
      fixer: committingFixer(repo.dir, []),
    });
    expect(result.outcome).toBe("accepted");
    expect(reviews).toEqual(["adversarial-review", "adversarial-review"]);
    const evidence = (await fake.invocations()).filter((call) => call.argv[0] === "evidence");
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.argv).toContain("--task");
    expect(evidence[0]?.argv).toContain(TASK);
    expect(evidence[0]?.findings).toEqual([
      {
        severity: "P2",
        location: "src/export",
        explanation: "export skips the header row",
        evidence: "the test output shows one missing column name",
      },
    ]);
    expect(await readFile(path.join(repo.dir, ".closeout", "keep"), "utf8")).toBe("kept\n");
    await repo.cleanup();
  });

  test("stops when the policy retry limit is exhausted", async () => {
    const repo = await gitRepo();
    const fake = await writeFakeCloseout(repo.root, {
      version: "0.1.0",
      steps: [
        template("blocked", [{ ...failed, state: "exhausted", message: "retry limit reached" }]),
      ],
    });
    let fixes = 0;
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: BASE,
      head: repo.head,
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          fixes += 1;
          return { ok: true, head: repo.head };
        },
      },
    });
    expect(result.outcome).toBe("exhausted");
    expect(fixes).toBe(0);
    await repo.cleanup();
  });

  test("blocks when closeout moves HEAD", async () => {
    const repo = await gitRepo();
    const fake = await writeFakeCloseout(repo.root, {
      version: "0.1.0",
      steps: [{ ...template("accepted", [passed]), mutate: "commit" }],
    });
    let fixes = 0;
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: BASE,
      head: repo.head,
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          fixes += 1;
          return { ok: false, reason: "should not run" };
        },
      },
    });
    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("HEAD changed");
    expect(fixes).toBe(0);
    await repo.cleanup();
  });

  test("blocks when the binary is not the pinned version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paws-pin-"));
    const fake = await writeFakeCloseout(root, {
      version: "9.9.9",
      steps: [template("accepted", [passed])],
    });
    const result = await runCloseoutGate({
      worktree: root,
      taskId: TASK,
      base: BASE,
      head: "b".repeat(40),
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          return { ok: false, reason: "no" };
        },
      },
    });
    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("0.1.0");
    const calls = await fake.invocations();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["--version"]);
    await rm(root, { recursive: true, force: true });
  });

  test("rejects a blank or oversized task id before spawning closeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paws-task-"));
    const fake = await writeFakeCloseout(root, { version: "0.1.0", steps: [] });
    const blank = await runCloseoutGate({
      worktree: root,
      taskId: " ",
      base: BASE,
      head: "b".repeat(40),
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          return { ok: false, reason: "no" };
        },
      },
    });
    const huge = await runCloseoutGate({
      worktree: root,
      taskId: "x".repeat(257),
      base: BASE,
      head: "b".repeat(40),
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          return { ok: false, reason: "no" };
        },
      },
    });
    expect(blank.outcome).toBe("invalid");
    expect(huge.outcome).toBe("invalid");
    expect(await fake.invocations()).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("treats an exit and document mismatch as invalid", async () => {
    const repo = await gitRepo();
    const step = template("rejected", [failed]);
    step.exit = 0;
    const fake = await writeFakeCloseout(repo.root, { version: "0.1.0", steps: [step] });
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: BASE,
      head: repo.head,
      candidate: candidate(),
      closeoutBin: fake.bin,
      reviewer: throwingReviewer(),
      fixer: committingFixer(repo.dir, []),
    });
    expect(result.outcome).toBe("invalid");
    expect(result.fixAttempts).toBe(0);
    await repo.cleanup();
  });

  test("createCloseoutGate maps an accepted run onto the foundation verdict", async () => {
    const repo = await gitRepo();
    const fake = await writeFakeCloseout(repo.root, {
      version: "0.1.0",
      steps: [template("accepted", [passed])],
    });
    const gate = createCloseoutGate({
      candidate: candidate(),
      reviewer: throwingReviewer(),
      fixer: committingFixer(repo.dir, []),
      closeoutBin: fake.bin,
    });
    const verdict = await gate.run({
      taskId: TASK,
      worktree: repo.dir,
      baseSha: BASE,
      headSha: repo.head,
      attempt: 1,
    });
    expect(verdict.decision).toBe("accepted");
    expect(verdict.exhausted).toBe(false);
    expect(verdict.summary).toContain("Caller attempt: 1");
    await repo.cleanup();
  });

  test("createCloseoutGate rejects a non-positive attempt before spawning", async () => {
    const gate = createCloseoutGate({
      candidate: candidate(),
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          return { ok: false, reason: "no" };
        },
      },
    });
    const verdict = await gate.run({
      taskId: TASK,
      worktree: "/tmp/none",
      baseSha: BASE,
      headSha: "b".repeat(40),
      attempt: 0,
    });
    expect(verdict.decision).toBe("invalid");
    expect(verdict.summary).toContain("attempt");
  });
});

function candidate() {
  return { session: "impl-session", model: "claude", provider: "anthropic" };
}

function throwingReviewer(): CodexReviewer {
  return {
    async review() {
      throw new Error("reviewer should not be called");
    },
  };
}

function committingFixer(dir: string, fixes: number[]): FixRunner {
  return {
    async applyFix(request) {
      fixes.push(request.fixAttempt);
      expect(request.summary).toContain("typecheck");
      await exec("git", ["-C", dir, "commit", "--allow-empty", "-m", `fix ${request.fixAttempt}`]);
      const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
      return { ok: true, head: stdout.trim() };
    },
  };
}

async function gitRepo(): Promise<{
  root: string;
  dir: string;
  head: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-"));
  const dir = path.join(root, "repo");
  await mkdir(dir);
  await exec("git", ["init", "-b", "main", dir]);
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), "paws\n");
  await exec("git", ["-C", dir, "add", "README.md"]);
  await exec("git", ["-C", dir, "commit", "-m", "init"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  return {
    root,
    dir,
    head: stdout.trim(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
