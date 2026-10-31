import { SystemFault } from "../core";
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createCloseoutGate } from "./gate";
import type { FixRunner } from "./fixer";
import { evaluateCandidate, runCloseoutGate, snapshotRetryBaseline } from "./run";
import type { CodexReviewer, ReviewRequest } from "./reviewer";
import { reviewRequirements } from "./index";
import { addReview, type CloseoutProgressStep, type PublishedEvidence } from "../closeout-spec";

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
  test("a fix round that only publishes visual proof needs no new commit", async () => {
    const repo = await originRepo({ "page.html": "<main></main>" });
    const root = path.join(repo.root, "local-policy");
    try {
      await mkdir(path.join(root, ".agents"), { recursive: true });
      await writeFile(
        path.join(root, ".agents/closeout.yaml"),
        policy([alwaysPass("lint"), { id: "visual-proof", kind: "evidence" }]),
      );
      const published: PublishedEvidence[] = [];
      const summaries: string[] = [];
      const result = await runCloseoutGate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        policyRoot: root,
        reviewer: throwingReviewer(),
        published: () => published,
        fixer: {
          async applyFix(request) {
            summaries.push(request.summary);
            published.push({ checkId: "visual-proof", media: "image", commit: request.head });
            return { ok: true, head: request.head };
          },
        },
      });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain(
        "visual-proof (evidence): failed — 0 of 1 screenshot or video",
      );
      expect(result).toMatchObject({ outcome: "accepted", fixAttempts: 1, head: repo.head });
    } finally {
      await repo.cleanup();
    }
  });

  test("local policy runs candidate commands and trusted review skills without checkout edits", async () => {
    const repo = await originRepo({ "candidate.txt": "candidate content" });
    const root = path.join(repo.root, "local-policy");
    const skill = ".agents/skills/adversarial-review/SKILL.md";
    try {
      await mkdir(path.join(root, ".agents/skills/adversarial-review/references"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, ".agents/closeout.yaml"),
        policy(
          [
            {
              ...alwaysPass("candidate"),
              exec: [
                "bun",
                "-e",
                "if (require('node:fs').readFileSync('candidate.txt', 'utf8') !== 'candidate content') process.exit(1)",
              ],
            },
            reviewItem("review"),
          ],
          1,
        ),
      );
      await writeFile(path.join(root, skill), "Trusted local review skill");
      await writeFile(
        path.join(root, ".agents/skills/adversarial-review/references/rule.md"),
        "Trusted local reference",
      );
      await writeFile(
        path.join(root, ".agents/skills/adversarial-review/asset.png"),
        new Uint8Array([137, 80, 78, 71, 255]),
      );
      await exec("git", ["-C", repo.dir, "remote", "remove", "origin"]);
      expect(reviewRequirements(repo.dir, repo.home, root)).toMatchObject({
        ok: true,
        items: [{ id: "review" }],
      });
      let reviews = 0;
      const gate = createCloseoutGate({
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        policyRoot: root,
        reviewer: {
          async review(request) {
            reviews += 1;
            // The trusted skill decides the review item; the review command gets no prompt.
            expect(request.prompt).toBeUndefined();
            return { session: "reviewer", model: "review-model", provider: "codex", findings: [] };
          },
        },
        fixer: {
          async applyFix() {
            throw new Error("unexpected fix");
          },
        },
      });
      const input = {
        taskId: TASK,
        worktree: repo.dir,
        baseSha: repo.head,
        headSha: repo.head,
        attempt: 1,
      };
      const first = await gate.run(input);
      expect(first.decision).toBe("accepted");
      expect(first.result?.decision?.policy.path).toBe(path.join(root, ".agents/closeout.yaml"));
      expect(reviews).toBe(1);
      expect((await gate.run(input)).decision).toBe("accepted");
      expect(reviews).toBe(1);
      await writeFile(
        path.join(root, ".agents/skills/adversarial-review/references/rule.md"),
        "Trusted local reference changed",
      );
      const changed = await gate.run(input);
      expect(changed.decision).toBe("accepted");
      expect(changed.result?.decision?.policy.digest).not.toBe(
        first.result?.decision?.policy.digest,
      );
      expect(reviews).toBe(2);
      expect((await exec("git", ["-C", repo.dir, "status", "--porcelain"])).stdout).toBe("");
      await rm(path.join(root, ".agents/closeout.yaml"));
      expect((await gate.run(input)).decision).toBe("blocked");
      expect(reviews).toBe(2);
    } finally {
      await repo.cleanup();
    }
  });

  test("changed checkout exclusions invalidate evidence for the same candidate", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([
        {
          id: "layout",
          kind: "command",
          exec: ["sh", "-c", "test ! -e large/file"],
          timeoutSeconds: 30,
        },
      ]),
      "large/file": "kept in Git",
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
      const sparse = await evaluateCandidate({ ...input, checkoutExclusions: ["large"] });
      expect(sparse.outcome).toBe("accepted");
      const full = await evaluateCandidate(input);
      expect(full.outcome).toBe("rejected");
      expect(full.decision?.policy.digest).not.toBe(sparse.decision?.policy.digest);
    } finally {
      await repo.cleanup();
    }
  });

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
            parallel: false,
            failOn: "P1",
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

  test("the summary names the task by its Linear identifier and keeps the path id for evidence", async () => {
    const repo = await originRepo({ ".agents/closeout.yaml": policy([alwaysPass("test")]) });
    try {
      const pathId = "PAS-367-01M5NDWPQZ0JQ91E1MFMVEY6EP";
      const gate = createCloseoutGate({
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
        fixer: committingFixer(repo.dir, []),
      });
      const verdict = await gate.run({
        taskId: pathId,
        taskLabel: "PAS-367",
        worktree: repo.dir,
        baseSha: repo.head,
        headSha: repo.head,
        attempt: 1,
      });
      expect(verdict.decision).toBe("accepted");
      expect(verdict.summary.split("\n")).toContain("Task: PAS-367");
      expect(verdict.summary).not.toContain(pathId);
      expect(verdict.result?.taskId).toBe(pathId);
      // Evidence stays under the full path id, so sibling tasks never share it.
      const baseline = await snapshotRetryBaseline(pathId, repo.pawsHome);
      expect(baseline.some((key) => key.includes(pathId))).toBe(true);
      expect(await snapshotRetryBaseline("PAS-367", repo.pawsHome)).toEqual([]);
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

  test("a failed fix round is retried with its reason and accepts on the next attempt", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([commandUntilOk("test")]),
    });
    const fixes: number[] = [];
    const summaries: string[] = [];
    const committing = committingFixer(repo.dir, fixes, "ok.txt", "ok\n");
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
          summaries.push(request.summary);
          if (request.fixAttempt === 1) throw new Error("runner import refused");
          return committing.applyFix(request);
        },
      },
    });
    expect(result.outcome).toBe("accepted");
    expect(result.fixAttempts).toBe(2);
    expect(result.evaluations).toBe(2);
    expect(fixes).toEqual([2]);
    expect(summaries[1]).toContain("runner import refused");
    await repo.cleanup();
  });

  test("fix rounds that never commit exhaust the budget and report each reason", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysFail("test")], 5),
    });
    const attempts: number[] = [];
    const result = await runCloseoutGate({
      maxFixAttempts: 3,
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
          attempts.push(request.fixAttempt);
          return { ok: false, reason: `agent error ${request.fixAttempt}` };
        },
      },
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.fixAttempts).toBe(3);
    expect(result.evaluations).toBe(1);
    expect(attempts).toEqual([1, 2, 3]);
    for (const attempt of attempts) expect(result.summary).toContain(`agent error ${attempt}`);
    await repo.cleanup();
  });

  test("a cancelled fix stops without retrying", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysFail("test")], 5),
    });
    const attempts: number[] = [];
    const result = await runCloseoutGate({
      maxFixAttempts: 3,
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
          attempts.push(request.fixAttempt);
          return { ok: false, reason: "fix cancelled" };
        },
      },
    });
    expect(result.outcome).toBe("fix_failed");
    expect(attempts).toEqual([1]);
    await repo.cleanup();
  });

  test("a fixer that throws the same error twice stops instead of spending the budget", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysFail("test")], 5),
    });
    const attempts: number[] = [];
    const result = await runCloseoutGate({
      maxFixAttempts: 12,
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
          attempts.push(request.fixAttempt);
          throw new Error("Run attribution authority changed");
        },
      },
    });
    expect(result.outcome).toBe("fix_failed");
    expect(attempts).toEqual([1, 2]);
    expect(result.summary).toContain("Run attribution authority changed");
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
    expect(result.fixAttempts).toBe(2);
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
          expect(request.prompt).toBeUndefined();
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

  test("the review step records how long the reviewer took and the tokens it reported", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")]),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const steps: CloseoutProgressStep[] = [];
    try {
      const evaluation = await evaluateCandidate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        progress: {
          begin() {},
          step(_identity, step) {
            if (step.kind === "review") steps.push(step);
          },
          output() {},
          finish() {},
        },
        reviewer: {
          async review() {
            await Bun.sleep(40);
            return {
              session: "codex-session",
              model: "codex",
              provider: "openai",
              findings: [],
              tokens: 48_000,
            };
          },
        },
      });
      expect(evaluation.outcome).toBe("accepted");
      const passed = steps.at(-1)!;
      expect(passed.state).toBe("passed");
      expect(passed.tokens).toBe(48_000);
      expect(passed.durationMs).toBeGreaterThanOrEqual(35);
      expect(steps[0]!.durationMs ?? null).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });

  test("the review step records failOn and which findings are in pre-existing code", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")]),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const steps: CloseoutProgressStep[] = [];
    try {
      await evaluateCandidate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        progress: {
          begin() {},
          step(_identity, step) {
            if (step.kind === "review") steps.push(step);
          },
          output() {},
          finish() {},
        },
        reviewer: {
          async review() {
            return {
              session: "codex-session",
              model: "codex",
              provider: "openai",
              findings: [
                // base..head changes nothing, so a readable `path:line` is pre-existing.
                { severity: "P1", location: "src/a.ts:3", explanation: "old", evidence: "seen" },
                { severity: "P1", location: "src/b", explanation: "new", evidence: "seen" },
              ],
            };
          },
        },
      });
      const judged = steps.at(-1)!;
      expect(judged.state).toBe("failed");
      expect(judged.failOn).toBe("P1");
      expect(judged.preExisting).toEqual([0]);
    } finally {
      await repo.cleanup();
    }
  });

  for (const [failures, message, outcome, calls] of [
    [2, "Rate limited", "accepted", 3],
    [9, "Rate limited", "blocked", 4],
    [9, "ACP connection closed", "blocked", 1],
  ] as const) {
    test(`a reviewer that fails ${failures} times with "${message}" ends ${outcome} after ${calls} calls`, async () => {
      const repo = await originRepo({
        ".agents/closeout.yaml": policy([reviewItem("adversarial-review")], 5),
        ".agents/skills/adversarial-review/SKILL.md": SKILL,
      });
      let reviews = 0;
      const result = await runCloseoutGate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewRetryDelaysMs: [0, 0, 0],
        reviewer: {
          async review() {
            reviews += 1;
            if (reviews <= failures) throw new Error(message);
            return { session: "codex-session", model: "codex", provider: "openai", findings: [] };
          },
        },
        fixer: committingFixer(repo.dir, [], "ok.txt", "ok\n"),
      });
      expect(result.outcome).toBe(outcome);
      if (outcome === "blocked") expect(result.systemFault?.faultClass).toBe("reviewer-profile");
      expect(reviews).toBe(calls);
      await repo.cleanup();
    });
  }

  // Twelve review rounds and eleven committed fixes take about 3.4 s on an
  // idle machine, so bun's 5 s default overran under parallel load.
  test("progress-aware reviews pass the old host cap and preserve task evidence between gate calls", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("review")]).replace(
        "  scope: task",
        "  scope: task\n  maxFailedReviewAttempts: 12",
      ),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    let reviews = 0;
    const fixes: number[] = [];
    try {
      const input = {
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: {
          async review() {
            reviews += 1;
            return {
              session: `review-${reviews}`,
              model: "codex",
              provider: "fixture",
              findings: [
                {
                  severity: "P1" as const,
                  location: `src/file-${reviews}.ts`,
                  explanation: "New failing finding",
                  evidence: "Reproduced",
                },
              ],
            };
          },
        },
        fixer: committingFixer(repo.dir, fixes),
      };
      const result = await runCloseoutGate({ ...input, maxFixAttempts: 12 });
      expect(result.outcome).toBe("exhausted");
      expect(result.fixAttempts).toBe(11);
      expect(reviews).toBe(12);
      expect(result.summary).toContain("12 of 12 allowed failed review attempts");
      expect(
        (await runCloseoutGate({ ...input, candidate: { ...candidate(), session: "resumed" } }))
          .outcome,
      ).toBe("exhausted");
      expect(reviews).toBe(12);
      const bypass = await evaluateCandidate({
        ...input,
        head: result.head,
        bypasses: [
          {
            questionId: "human-approval",
            taskId: TASK,
            base: repo.head,
            head: result.head,
            policyDigest: result.decision!.policy.digest!,
            checkIds: ["review"],
            actor: "pascal",
            reason: "Explicit approval",
          },
        ],
      });
      expect(bypass.outcome).toBe("accepted");
      expect(bypass.decision?.decision).toBe("blocked");
      const resumed = await runCloseoutGate({
        ...input,
        retryBaseline: await snapshotRetryBaseline(TASK, repo.pawsHome),
        reviewer: {
          async review() {
            return {
              session: "human-resumed-review",
              model: "codex",
              provider: "fixture",
              findings: [],
            };
          },
        },
      });
      expect(resumed.outcome).toBe("accepted");
      expect(await snapshotRetryBaseline(TASK, repo.pawsHome)).toHaveLength(13);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("an exhausted command still collects review evidence needed for bypass recovery", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([alwaysFail("test"), reviewItem("review")], 1),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    let reviews = 0;
    try {
      const input = {
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: {
          async review() {
            reviews += 1;
            return {
              session: "independent-reviewer",
              model: "codex",
              provider: "fixture",
              findings: [],
            };
          },
        },
      };
      const exhausted = await evaluateCandidate(input);
      expect(reviews).toBe(1);
      expect(exhausted.decision?.items.map((item) => [item.id, item.state])).toEqual([
        ["test", "exhausted"],
        ["review", "passed"],
      ]);
      const bypass = await evaluateCandidate({
        ...input,
        bypasses: [
          {
            questionId: "human-approval",
            taskId: TASK,
            base: repo.head,
            head: repo.head,
            policyDigest: exhausted.decision!.policy.digest!,
            checkIds: ["test"],
            actor: "pascal",
            reason: "Approved known command failure",
          },
        ],
      });
      expect(bypass.outcome).toBe("accepted");
      expect(reviews).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  test("concurrent review exhaustion retains the decision for operator escalation", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("review")]).replace(
        "  scope: task",
        "  scope: task\n  maxFailedReviewAttempts: 12",
      ),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    try {
      const result = await evaluateCandidate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: {
          async review() {
            for (let round = 0; round < 3; round += 1) {
              expect(
                (
                  await addReview({
                    repo: repo.dir,
                    base: repo.head,
                    head: repo.head,
                    gate: "beforePR",
                    task: TASK,
                    itemId: "review",
                    candidate: candidate(),
                    home: repo.home,
                    evidenceDir: path.join(repo.pawsHome, "closeout/evidence", TASK),
                    reviewer: {
                      async review() {
                        return {
                          producer: { session: "concurrent", model: "codex", provider: "fixture" },
                          findings: [
                            {
                              severity: "P1",
                              location: "src/a.ts",
                              explanation: "Repeated",
                              evidence: "Reproduced",
                            },
                          ],
                          artifacts: [],
                        };
                      },
                    },
                  })
                ).ok,
              ).toBe(true);
            }
            return { session: "late-clean", model: "codex", provider: "fixture", findings: [] };
          },
        },
      });
      expect(result.outcome).toBe("exhausted");
      expect(result.decision?.decision).toBe("blocked");
      expect(result.decision?.items[0]).toMatchObject({ id: "review", state: "exhausted" });
      expect(result.decision?.items[0]?.message).toContain("src/a.ts failed in 3 of 3");
    } finally {
      await repo.cleanup();
    }
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

  test("setup faults retry once, then stop without spending fix rounds", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": JSON.stringify({
        specVersion: "0.1",
        retry: { attempts_per_check: 5, fix_rounds_per_item: 3 },
        setup: [{ id: "install", exec: ["sh", "-c", "exit 1"], timeoutSeconds: 30 }],
        items: [alwaysPass("test")],
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
        fixer: committingFixer(repo.dir, fixes),
      });
      expect(result.outcome).toBe("exhausted");
      expect(result.fixAttempts).toBe(0);
      expect(result.decision?.items.find((item) => item.id === "install")?.message).toContain(
        "2 of 2",
      );
      expect(fixes).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test("fix_rounds_per_item bounds repairs independently of the number of checks", async () => {
    for (const count of [1, 4]) {
      const repo = await originRepo({
        ".agents/closeout.yaml": JSON.stringify({
          specVersion: "0.1",
          retry: { attempts_per_check: 10, fix_rounds_per_item: 1 },
          items: Array.from({ length: count }, (_, i) => ({
            ...alwaysFail(`test-${i}`),
            gate: "beforePR",
          })),
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
          fixer: committingFixer(repo.dir, fixes),
        });
        expect(result.outcome).toBe("exhausted");
        expect(fixes).toEqual([1]);
        expect(result.evaluations).toBe(2);
      } finally {
        await repo.cleanup();
      }
    }
  });

  test("fix attempts name the limit that stops the loop first", async () => {
    // note.txt appears with the first fix: `before` fails only until then, `after` from then on.
    const before = {
      ...alwaysFail("before"),
      exec: ["bun", "-e", "process.exit(require('fs').existsSync('note.txt') ? 0 : 1)"],
    };
    const after = {
      ...alwaysFail("after"),
      exec: ["bun", "-e", "process.exit(require('fs').existsSync('note.txt') ? 1 : 0)"],
    };
    for (const [retry, items, fixed, expected] of [
      [
        { maxFailedAttemptsPerItem: 3, fix_rounds_per_item: 35 },
        [alwaysFail("test")],
        [1, 2],
        [2, 2],
      ],
      [
        { maxFailedAttemptsPerItem: 5, fix_rounds_per_item: 2 },
        [alwaysFail("test")],
        [1, 2],
        [2, 2],
      ],
      // `after` starts failing at the second evaluation, so it allows one more fix than `before`.
      [
        { maxFailedAttemptsPerItem: 3, fix_rounds_per_item: 35 },
        [before, after],
        [1, 2, 3],
        [2, 3, 3],
      ],
    ] as const) {
      const repo = await originRepo({
        ".agents/closeout.yaml": JSON.stringify({
          specVersion: "0.1",
          retry: { ...retry, scope: "task" },
          items,
        }),
      });
      try {
        const fixes: number[] = [];
        const limits: number[] = [];
        const fixer = committingFixer(repo.dir, fixes);
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
              limits.push(request.maxFixAttempts);
              return fixer.applyFix(request);
            },
          },
        });
        expect(result.outcome).toBe("exhausted");
        expect(fixes).toEqual([...fixed]);
        expect(limits).toEqual([...expected]);
      } finally {
        await repo.cleanup();
      }
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

  test("a transfer fault records no failed check and retries the same candidate", async () => {
    const repo = await originRepo({ ".agents/closeout.yaml": policy([alwaysPass("test")], 1) });
    const input = {
      worktree: repo.dir,
      taskId: TASK,
      base: repo.head,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: throwingReviewer(),
      fixer: committingFixer(repo.dir, [], "ok.txt", "ok\n"),
    };
    try {
      const held = await runCloseoutGate({
        ...input,
        commandRunner: {
          async runLogged() {
            throw new SystemFault("closeout-transfer", "policy bundle unavailable");
          },
        },
      });
      expect(held.systemFault).toEqual({
        faultClass: "closeout-transfer",
        reason: "policy bundle unavailable",
      });
      expect(held.fixAttempts).toBe(0);
      const recovered = await runCloseoutGate(input);
      expect(recovered.outcome).toBe("accepted");
      expect(recovered.decision?.items[0]?.attempt).toBe(1);
    } finally {
      await repo.cleanup();
    }
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
    expect(result.systemFault?.faultClass).toBe("closeout-policy");
    await repo.cleanup();
  });

  test("the reviewer gets base and head, and no rendered skill, diff or scope prompt", async () => {
    const requests: ReviewRequest[] = [];
    for (const extra of [[], ["scope: diff"]]) {
      const repo = await originRepo({
        ".agents/closeout.yaml": policy([{ ...reviewItem("review"), extra }]),
        ".agents/skills/adversarial-review/SKILL.md": SKILL,
      });
      try {
        const evaluation = await evaluateCandidate({
          worktree: repo.dir,
          taskId: TASK,
          base: repo.head,
          head: repo.head,
          candidate: candidate(),
          home: repo.home,
          pawsHome: repo.pawsHome,
          reviewer: {
            async review(request) {
              requests.push(request);
              return { session: "codex-session", model: "codex", provider: "openai", findings: [] };
            },
          },
        });
        expect(evaluation.outcome).toBe("accepted");
        expect(requests.at(-1)).toMatchObject({ base: repo.head, head: repo.head });
      } finally {
        await repo.cleanup();
      }
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.prompt).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain(SKILL);
    }
  });

  test("a review setting the policy schema does not know blocks the policy", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([{ ...reviewItem("review"), extra: ["scope: everything"] }]),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    try {
      const evaluation = await evaluateCandidate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: throwingReviewer(),
      });
      expect(evaluation.outcome).toBe("blocked");
    } finally {
      await repo.cleanup();
    }
  });

  test("a change under minChangedLines skips the review and a larger one runs it", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([{ ...reviewItem("review"), extra: ["minChangedLines: 5"] }]),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const commit = async (lines: number) => {
      await writeFile(
        path.join(repo.dir, "change.txt"),
        `${Array.from({ length: lines }, (_, line) => `line ${line}`).join("\n")}\n`,
      );
      await exec("git", ["-C", repo.dir, "add", "change.txt"]);
      await exec("git", ["-C", repo.dir, "commit", "-m", `${lines} lines`]);
      return (await exec("git", ["-C", repo.dir, "rev-parse", "HEAD"])).stdout.trim();
    };
    let reviews = 0;
    const evaluate = (head: string) =>
      evaluateCandidate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: {
          async review() {
            reviews += 1;
            return { session: "codex-session", model: "codex", provider: "openai", findings: [] };
          },
        },
      });
    try {
      const small = await evaluate(await commit(4));
      expect(small.outcome).toBe("accepted");
      expect(small.decision?.items).toEqual([
        {
          id: "review",
          kind: "review",
          state: "skipped",
          message: "4 changed lines, under minChangedLines 5",
        },
      ]);
      expect(reviews).toBe(0);
      const large = await evaluate(await commit(9));
      expect(large.outcome).toBe("accepted");
      expect(large.decision?.items[0]?.state).toBe("passed");
      expect(reviews).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  for (const parallel of [false, true]) {
    test(`a ${parallel ? "parallel" : "sequential"} review ${parallel ? "runs while" : "waits for"} the command checks`, async () => {
      const flags = await mkdtemp(path.join(tmpdir(), "paws-review-flag-"));
      const flag = path.join(flags, "review-started");
      const wait = `const fs = require('node:fs'); for (let i = 0; i < 60 && !fs.existsSync('${flag}'); i++) Bun.sleepSync(50); if (!fs.existsSync('${flag}')) process.exit(1)`;
      const repo = await originRepo({
        ".agents/closeout.yaml": policy([
          { id: "test", kind: "command", exec: ["bun", "-e", wait], timeoutSeconds: 30 },
          { ...reviewItem("review"), extra: parallel ? ["parallel: true"] : [] },
        ]),
        ".agents/skills/adversarial-review/SKILL.md": SKILL,
      });
      const head = repo.head;
      const states: string[] = [];
      try {
        const evaluation = await evaluateCandidate({
          worktree: repo.dir,
          taskId: TASK,
          base: head,
          head,
          candidate: candidate(),
          home: repo.home,
          pawsHome: repo.pawsHome,
          progress: {
            begin() {},
            step(_identity, step) {
              if (step.kind === "review") states.push(step.state);
            },
            output() {},
            finish() {},
          },
          reviewer: {
            async review() {
              await writeFile(flag, "started\n");
              return { session: "codex-session", model: "codex", provider: "openai", findings: [] };
            },
          },
        });
        expect(evaluation.outcome).toBe(parallel ? "accepted" : "rejected");
        if (parallel) {
          expect(states[0]).toBe("running");
          expect(states).not.toContain("pending");
          expect(states.at(-1)).toBe("passed");
        }
      } finally {
        await repo.cleanup();
        await rm(flags, { recursive: true, force: true });
      }
    }, 20_000);
  }

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
      ...((item.extra as string[] | undefined) ?? []).map((line) => `    ${line}`),
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
