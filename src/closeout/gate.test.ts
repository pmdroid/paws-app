import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createCloseoutGate } from "./gate";
import type { FixRunner } from "./fixer";
import { evaluateCandidate, runCloseoutGate, snapshotRetryBaseline } from "./run";
import type { CodexReviewer } from "./reviewer";
import { MAX_FIX_ATTEMPTS } from "./types";
import { reviewRequirements } from "./index";

const exec = promisify(execFile);
const TASK = "ENG-123";

const SKILL = `---
name: adversarial-review
description: Review the candidate. Report findings. Do not decide acceptance.
---

# Review

Report findings. An empty list means the change is fine.
`;

describe("closeout gate", () => {
  test("preflight reads review independence from trusted origin policy", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")]),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    try {
      await writeFile(path.join(repo.dir, ".agents/closeout.yaml"), policy([]));
      expect(reviewRequirements(repo.dir, repo.home)).toEqual({
        ok: true,
        items: [
          {
            id: "adversarial-review",
            gate: "beforePR",
            independence: { differentSession: true, differentModel: true },
          },
        ],
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("preflight fails closed when the trusted policy cannot load", async () => {
    const repo = await originRepo({ ".agents/closeout.yaml": "specVersion: invalid\n" });
    try {
      expect(reviewRequirements(repo.dir, repo.home).ok).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("feeds a failing command back and accepts on attempt 2", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([commandUntilOk("test")]),
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
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
        fixer: committingFixer(repo.dir, fixes, "ok.txt", "ok\n"),
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
    expect(result.summary).toContain("test");
    expect(result.summary).toContain(TASK);
    const report = await readFile(path.join(repo.root, "report", "closeout-verdict.json"), "utf8");
    expect(report).toContain('"outcome": "accepted"');
    await repo.cleanup();
  });

  test("an explicit fix cap stops after two failed fixes", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysFail("test")], 5),
    });
    const fixes: number[] = [];
    const result = await runCloseoutGate({
      maxFixAttempts: 2,
      worktree: repo.dir,
      taskId: TASK,
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: throwingReviewer(),
      fixer: committingFixer(repo.dir, fixes, "note.txt", "still failing\n"),
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.fixAttempts).toBe(MAX_FIX_ATTEMPTS);
    expect(fixes).toEqual([1, 2]);
    expect(result.evaluations).toBe(3);
    await repo.cleanup();
  });

  test("uses the configured retry budget beyond two fixes and includes command output", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy(
        [
          {
            id: "test",
            kind: "command",
            exec: ["sh", "-c", "test -f ok.txt || { echo expected-output >&2; exit 1; }"],
            timeoutSeconds: 30,
          },
        ],
        5,
      ),
    });
    const fixes: number[] = [];
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix(request) {
          expect(request.summary).toContain("expected-output");
          return committingFixer(
            repo.dir,
            fixes,
            request.fixAttempt === 3 ? "ok.txt" : "note.txt",
            `fix ${request.fixAttempt}\n`,
          ).applyFix(request);
        },
      },
    });
    expect(result.outcome).toBe("accepted");
    expect(fixes).toEqual([1, 2, 3]);
    await repo.cleanup();
  });

  test("records review evidence, then a fix, then accepts", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy(
        [commandUntilOk("test"), reviewItem("adversarial-review")],
        5,
      ),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const reviews: string[] = [];
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: {
        async review(request) {
          reviews.push(request.itemId);
          expect(request.prompt).toContain(
            "Report findings. An empty list means the change is fine.",
          );
          return {
            session: "codex-session",
            model: "codex",
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
      fixer: committingFixer(repo.dir, [], "ok.txt", "ok\n"),
    });
    expect(result.outcome).toBe("accepted");
    expect(reviews).toEqual(["adversarial-review", "adversarial-review"]);
    expect(result.summary).toContain("test");
    expect(result.decision?.candidate.task).toBe(TASK);
    await repo.cleanup();
  });

  test("stops when the policy retry limit is exhausted", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysFail("test")], 1),
    });
    let fixes = 0;
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          fixes += 1;
          return { ok: true, head: repo.head };
        },
      },
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.summary).toContain("exhausted");
    expect(fixes).toBe(0);
    await repo.cleanup();
  });

  test("an audited retry baseline gives a fresh bounded round without deleting evidence", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([commandUntilOk("test")], 2),
    });
    try {
      const fixes: number[] = [];
      const input = {
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
        fixer: committingFixer(repo.dir, fixes),
      };
      expect((await runCloseoutGate(input)).outcome).toBe("exhausted");
      expect(fixes).toEqual([1]);
      const baseline = await snapshotRetryBaseline(TASK, repo.pawsHome);
      expect(baseline).toHaveLength(2);
      const second = await runCloseoutGate({
        ...input,
        retryBaseline: baseline,
        fixer: committingFixer(repo.dir, fixes, "second-round.txt"),
      });
      expect(second.outcome).toBe("exhausted");
      expect(second.fixAttempts).toBe(1);
      const nextBaseline = await snapshotRetryBaseline(TASK, repo.pawsHome);
      expect(nextBaseline).toHaveLength(4);
      expect(nextBaseline).toEqual(expect.arrayContaining(baseline));
      await writeFile(path.join(repo.dir, "ok.txt"), "ok\n");
      await exec("git", ["-C", repo.dir, "add", "ok.txt"]);
      await exec("git", ["-C", repo.dir, "commit", "-m", "human-guided fix"]);
      expect((await runCloseoutGate(input)).outcome).toBe("exhausted");
      expect((await runCloseoutGate({ ...input, retryBaseline: nextBaseline })).outcome).toBe(
        "accepted",
      );
      expect((await snapshotRetryBaseline(TASK, repo.pawsHome)).length).toBeGreaterThan(4);
    } finally {
      await repo.cleanup();
    }
  });

  test("a bypass is selected, audited and bound to task, base, head and policy", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysFail("first"), alwaysFail("second")], 1),
    });
    try {
      const input = {
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
      };
      const failed = await evaluateCandidate(input);
      const approval = {
        questionId: "question-1",
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        policyDigest: failed.decision!.policy.digest!,
        checkIds: ["first"],
        actor: "pascal",
        reason: "Approved known failure for this candidate",
      };
      const partial = await evaluateCandidate({ ...input, bypasses: [approval] });
      expect(partial.outcome).toBe("exhausted");
      expect(partial.bypasses).toHaveLength(1);
      const complete = { ...approval, checkIds: ["first", "second"] };
      const accepted = await runCloseoutGate({
        ...input,
        bypasses: [complete],
        fixer: committingFixer(repo.dir, []),
      });
      expect(accepted.outcome).toBe("accepted");
      expect(accepted.decision?.decision).not.toBe("accepted");
      expect(accepted.decision?.items.every((item) => item.state === "exhausted")).toBe(true);
      expect(accepted.summary).toContain("approved by pascal");
      expect(accepted.summary).toContain(complete.reason);
      expect(accepted.summary).toContain(complete.questionId);
      for (const mismatch of [
        { taskId: "ENG-999" },
        { base: "a".repeat(40) },
        { head: "b".repeat(40) },
        { policyDigest: "sha256:wrong" },
        { actor: " " },
        { reason: " " },
        { checkIds: ["missing"] },
      ]) {
        const result = await evaluateCandidate({
          ...input,
          bypasses: [{ ...complete, ...mismatch }],
        });
        expect(result.outcome).toBe("exhausted");
        expect(result.bypasses).toBeUndefined();
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("setup repairs and command repairs each receive their configured budget", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": JSON.stringify({
        specVersion: "0.1",
        retry: { maxFailedAttemptsPerItem: 2, scope: "task" },
        setup: [{ id: "install", exec: ["sh", "-c", "test -f installed.txt"], timeoutSeconds: 30 }],
        items: [commandUntilOk("test")],
      }),
    });
    try {
      const fixes: number[] = [];
      const result = await runCloseoutGate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
        fixer: {
          applyFix(request) {
            return committingFixer(
              repo.dir,
              fixes,
              request.fixAttempt === 1 ? "installed.txt" : "ok.txt",
            ).applyFix(request);
          },
        },
      });
      expect(result.outcome).toBe("accepted");
      expect(fixes).toEqual([1, 2]);
    } finally {
      await repo.cleanup();
    }
  });

  test("bypassing setup cannot approve commands that never ran", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": JSON.stringify({
        specVersion: "0.1",
        retry: { maxFailedAttemptsPerItem: 1, scope: "task" },
        setup: [{ id: "install", exec: ["sh", "-c", "exit 1"], timeoutSeconds: 30 }],
        items: [alwaysPass("test")],
      }),
    });
    try {
      const input = {
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
      };
      const failed = await evaluateCandidate(input);
      const approval = {
        questionId: "setup-question",
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        policyDigest: failed.decision!.policy.digest!,
        checkIds: ["install"],
        actor: "pascal",
        reason: "Known setup failure",
      };
      const result = await evaluateCandidate({ ...input, bypasses: [approval] });
      expect(result.outcome).toBe("blocked");
      expect(result.decision?.items.find((item) => item.id === "test")?.message).toBe(
        "setup failed",
      );
    } finally {
      await repo.cleanup();
    }
  });

  test("blocks when the worktree HEAD moves during review", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")]),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    let fixes = 0;
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: {
        async review() {
          await exec("git", ["-C", repo.dir, "commit", "--allow-empty", "-m", "moved"]);
          return { session: "codex-session", model: "codex", provider: "openai", findings: [] };
        },
      },
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

  test("rejects a blank or oversized task id before running closeout", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysPass("test")]),
    });
    const blank = await runCloseoutGate({
      worktree: repo.dir,
      taskId: " ",
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          return { ok: false, reason: "no" };
        },
      },
    });
    const huge = await runCloseoutGate({
      worktree: repo.dir,
      taskId: "x".repeat(257),
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          return { ok: false, reason: "no" };
        },
      },
    });
    expect(blank.outcome).toBe("invalid");
    expect(huge.outcome).toBe("invalid");
    await repo.cleanup();
  });

  test("blocks a malformed policy and does not ask for a fix", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": 'specVersion: "0.1"\nitems: [\n',
    });
    let fixes = 0;
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: throwingReviewer(),
      fixer: {
        async applyFix() {
          fixes += 1;
          return { ok: false, reason: "no" };
        },
      },
    });
    expect(result.outcome).toBe("blocked");
    expect(fixes).toBe(0);
    expect(result.summary).toContain("closeout.yaml");
    await repo.cleanup();
  });

  test("createCloseoutGate maps an accepted run onto the foundation verdict", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysPass("test")]),
    });
    const gate = createCloseoutGate({
      candidate: candidate(),
      reviewer: throwingReviewer(),
      fixer: committingFixer(repo.dir, []),
      home: repo.home,
      pawsHome: repo.pawsHome,
    });
    const verdict = await gate.run({
      taskId: TASK,
      worktree: repo.dir,
      baseSha: repo.head,
      headSha: repo.head,
      attempt: 1,
    });
    expect(verdict.decision).toBe("accepted");
    expect(verdict.exhausted).toBe(false);
    expect(verdict.summary).toContain("Caller attempt: 1");
    await repo.cleanup();
  });

  test("createCloseoutGate rejects a non-positive attempt before running", async () => {
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
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      attempt: 0,
    });
    expect(verdict.decision).toBe("invalid");
    expect(verdict.summary).toContain("attempt");
  });

  test("does not pass github or ssh credentials to a closeout command", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([
        {
          id: "env",
          kind: "command",
          gate: "beforePR",
          exec: [
            "bun",
            "-e",
            "if (process.env.GITHUB_TOKEN || process.env.SSH_AUTH_SOCK) process.exit(1)",
          ],
          timeoutSeconds: 30,
        },
      ]),
    });
    const previousToken = process.env.GITHUB_TOKEN;
    const previousSsh = process.env.SSH_AUTH_SOCK;
    process.env.GITHUB_TOKEN = "ghs_should_not_leak";
    process.env.SSH_AUTH_SOCK = "/tmp/agent-ssh";
    let result;
    try {
      result = await runCloseoutGate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
        fixer: committingFixer(repo.dir, []),
      });
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
      if (previousSsh === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousSsh;
    }
    expect(result.outcome).toBe("accepted");
    await repo.cleanup();
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

function committingFixer(dir: string, fixes: number[], file = "note.txt", body = "x\n"): FixRunner {
  return {
    async applyFix(request) {
      fixes.push(request.fixAttempt);
      await writeFile(path.join(dir, file), `${body.trimEnd()}\n${request.fixAttempt}\n`);
      await exec("git", ["-C", dir, "add", file]);
      await exec("git", ["-C", dir, "commit", "-m", `fix ${request.fixAttempt}`]);
      const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
      return { ok: true, head: stdout.trim() };
    },
  };
}

function policy(items: unknown[], maxFailedAttempts = 3): string {
  return [
    'specVersion: "0.1"',
    "retry:",
    `  maxFailedAttemptsPerItem: ${maxFailedAttempts}`,
    "  scope: task",
    "items:",
    ...items.flatMap((item) => yamlItem(item as Record<string, unknown>)),
    "",
  ].join("\n");
}

function yamlItem(item: Record<string, unknown>): string[] {
  const lines = [
    `  - id: ${String(item.id)}`,
    `    kind: ${String(item.kind)}`,
    "    gate: beforePR",
  ];
  if (item.kind === "command") {
    const execArgs = item.exec as string[];
    lines.push(
      `    exec: [${execArgs.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      `    timeoutSeconds: ${String(item.timeoutSeconds)}`,
    );
  }
  if (item.kind === "review") {
    lines.push(
      `    skill: ${String(item.skill)}`,
      "    independence:",
      "      differentSession: true",
      "      differentModel: true",
      "    failOn: P1",
    );
  }
  return lines;
}

function commandUntilOk(id: string) {
  return {
    id,
    kind: "command",
    gate: "beforePR",
    exec: ["bun", "-e", "if (!require('node:fs').existsSync('ok.txt')) process.exit(1)"],
    timeoutSeconds: 30,
  };
}

function alwaysFail(id: string) {
  return {
    id,
    kind: "command",
    gate: "beforePR",
    exec: ["bun", "-e", "process.exit(1)"],
    timeoutSeconds: 30,
  };
}

function alwaysPass(id: string) {
  return {
    id,
    kind: "command",
    gate: "beforePR",
    exec: ["bun", "-e", "process.exit(0)"],
    timeoutSeconds: 30,
  };
}

function reviewItem(id: string) {
  return {
    id,
    kind: "review",
    skill: ".agents/skills/adversarial-review/SKILL.md",
  };
}

async function originRepo(files: Record<string, string>): Promise<{
  root: string;
  dir: string;
  head: string;
  home: string;
  pawsHome: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-"));
  const bare = path.join(root, "origin.git");
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  await mkdir(home);
  await mkdir(pawsHome);
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, dir]);
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "init"]);
  await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  return {
    root,
    dir,
    head: stdout.trim(),
    home,
    pawsHome,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
