import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv/dist/2020";
import {
  createFakeReviewCommandRunner,
  createReviewCommandRunner,
  createReviewer,
  findingsJsonSchema,
  formatFixFeedback,
  type CommandRecord,
  type DecisionDocument,
  type Finding,
  type ReviewCommandRequest,
  type ReviewRecord,
} from "../src/closeout-spec";

const exec = promisify(execFile);
const HEAD = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const SKILL = ".agents/skills/adversarial-review/SKILL.md";
const SKILL_TEXT = "Skill text: look for dropped behavior.";
const REFERENCE_TEXT = "Reference rule: flag a dropped test as P1.";

const finding = (severity: Finding["severity"], explanation: string): Finding => ({
  severity,
  location: "src/reviewed.ts",
  explanation,
  evidence: `${severity} observation`,
});

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

const codexEvents = (thread: string, text: string) =>
  jsonl(
    { type: "thread.started", thread_id: thread },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Reading git diff" } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
  );

const claudeEvents = (session: string, model: string, result: Record<string, unknown>) =>
  jsonl(
    { type: "system", subtype: "init", session_id: session, model, cwd: "/tmp" },
    { type: "assistant", session_id: session, message: { model, content: [] } },
    { type: "result", subtype: "success", is_error: false, session_id: session, ...result },
  );

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

describe("closeout reviewer runs the agent's review command", () => {
  test("Codex runs codex exec review --base with the findings schema and stores its findings", async () => {
    const repo = await gitRepo();
    const seen: Array<{ head: string; schema: unknown }> = [];
    const runner = createFakeReviewCommandRunner(
      [ok(codexEvents("thread-codex", JSON.stringify([finding("P1", "The constant changed.")])))],
      async (call) => {
        seen.push(await inspectCall(call));
      },
    );
    try {
      const result = await createReviewer(runner, { agent: "codex", model: "gpt-5-codex" }).review({
        ...request(repo),
        candidate: { task: "QM-32", session: "impl", model: "claude-opus", provider: "anthropic" },
      });
      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      const schemaPath = call.argv.at(-1)!;
      expect(call.argv).toEqual([
        "codex",
        "exec",
        "review",
        "--base",
        repo.base,
        "--model",
        "gpt-5-codex",
        "--json",
        "--output-schema",
        schemaPath,
      ]);
      expect(seen[0]?.schema).toEqual(findingsJsonSchema());
      expect(existsSync(schemaPath)).toBe(false);
      expect(call.cwd).not.toBe(repo.dir);
      expect(seen[0]?.head).toBe(repo.head);
      expect(existsSync(call.cwd)).toBe(false);
      expect(result.status).toBe("recorded");
      if (result.status !== "recorded") return;
      expect(result.record.producer).toEqual({
        session: "thread-codex",
        model: "gpt-5-codex",
        provider: "openai",
      });
      expect(result.record).toMatchObject({
        specVersion: "0.1",
        recordType: "review",
        task: "QM-32",
        itemId: "adversarial-review",
        base: repo.base,
        head: repo.head,
        policyDigest: DIGEST,
        attempt: 1,
        evaluator: { name: "paws", version: "0.1" },
        findings: [finding("P1", "The constant changed.")],
        artifacts: [],
      });
      expect(evidenceValidator()(result.record)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("Claude runs /code-review base..head in plan mode and stores its structured findings", async () => {
    const repo = await gitRepo();
    const seen: Array<{ head: string; schema: unknown }> = [];
    const runner = createFakeReviewCommandRunner(
      [
        ok(
          claudeEvents("claude-session", "claude-sonnet-reported", {
            result: "Review done.",
            structured_output: [finding("P2", "The rename dropped a caller.")],
          }),
        ),
      ],
      async (call) => {
        seen.push(await inspectCall(call));
      },
    );
    try {
      const result = await createReviewer(runner, {
        agent: "claude",
        model: "claude-sonnet",
      }).review(request(repo));
      const call = runner.calls[0]!;
      expect(call.argv).toEqual([
        "claude",
        "-p",
        "--permission-mode",
        "plan",
        "--model",
        "claude-sonnet",
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        JSON.stringify(findingsJsonSchema()),
        `/code-review ${repo.base}..${repo.head}`,
      ]);
      expect(seen[0]?.head).toBe(repo.head);
      expect(result.status).toBe("recorded");
      if (result.status !== "recorded") return;
      expect(result.record.producer).toEqual({
        session: "claude-session",
        model: "claude-sonnet-reported",
        provider: "anthropic",
      });
      expect(result.record.findings).toEqual([finding("P2", "The rename dropped a caller.")]);
    } finally {
      await repo.cleanup();
    }
  });

  test("passes no bypass flag, skill text, or diff to either command", async () => {
    const repo = await gitRepo();
    try {
      for (const agent of ["codex", "claude"] as const) {
        const runner = createFakeReviewCommandRunner([
          ok(agent === "codex" ? codexEvents("t", "[]") : claudeEvents("s", "m", { result: "[]" })),
        ]);
        const result = await createReviewer(runner, { agent, model: "reviewer" }).review({
          ...request(repo),
          earlier: [
            {
              severity: "P1",
              location: "src/reviewed.ts:1",
              explanation: "Earlier round finding",
              head: repo.base,
              status: "open",
            },
          ],
          skillFiles: new Map([
            [SKILL, new TextEncoder().encode(SKILL_TEXT)],
            [
              ".agents/skills/adversarial-review/references/tool.md",
              new TextEncoder().encode("x".repeat(1_500_000)),
            ],
          ]),
        });
        expect(result.status).toBe("recorded");
        const argv = runner.calls[0]!.argv.join("\n");
        expect(argv).not.toContain("dangerously");
        expect(argv).not.toContain("bypass");
        expect(argv).not.toContain(SKILL_TEXT);
        expect(argv).not.toContain(REFERENCE_TEXT);
        expect(argv).not.toContain("Earlier round finding");
        expect(argv).not.toContain("export const reviewed");
        expect(argv.length).toBeLessThan(10_000);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("re-asks once in the same Codex session with the schema restated, then parses", async () => {
    const repo = await gitRepo();
    const runner = createFakeReviewCommandRunner([
      ok(codexEvents("thread-1", "Looks good to me.")),
      ok(
        jsonl({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify([finding("P2", "Dropped caller.")]) },
        }),
      ),
    ]);
    try {
      const result = await createReviewer(runner, { agent: "codex", model: "gpt-5-codex" }).review(
        request(repo),
      );
      expect(runner.calls).toHaveLength(2);
      const reask = runner.calls[1]!.argv;
      expect(reask.slice(0, 6)).toEqual([
        "codex",
        "exec",
        "resume",
        "thread-1",
        "--model",
        "gpt-5-codex",
      ]);
      expect(reask).toContain("--json");
      expect(reask).toContain("--output-schema");
      const prompt = reask.at(-1)!;
      expect(prompt).toContain("The previous reply was not a valid findings array.");
      expect(prompt).toContain("severity: P0, P1, P2, or P3");
      expect(runner.calls[1]!.cwd).toBe(runner.calls[0]!.cwd);
      expect(result.status).toBe("recorded");
      if (result.status !== "recorded") return;
      expect(result.record.producer.session).toBe("thread-1");
      expect(result.record.findings).toEqual([finding("P2", "Dropped caller.")]);
    } finally {
      await repo.cleanup();
    }
  });

  test("re-asks once in the same Claude session, then parses", async () => {
    const repo = await gitRepo();
    const runner = createFakeReviewCommandRunner([
      ok(claudeEvents("claude-1", "claude-model", { result: "No issues found." })),
      ok(claudeEvents("claude-1", "claude-model", { result: "[]" })),
    ]);
    try {
      const result = await createReviewer(runner, {
        agent: "claude",
        model: "claude-model",
      }).review(request(repo));
      expect(runner.calls).toHaveLength(2);
      expect(runner.calls[1]!.argv.slice(0, 4)).toEqual(["claude", "-p", "--resume", "claude-1"]);
      expect(runner.calls[1]!.argv).toContain("--json-schema");
      expect(runner.calls[1]!.argv.at(-1)).toContain("Reply again with only a JSON array");
      expect(result.status).toBe("recorded");
      if (result.status !== "recorded") return;
      expect(result.record.findings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test("records an invalid review when the re-ask still does not parse", async () => {
    const repo = await gitRepo();
    const runner = createFakeReviewCommandRunner([
      ok(codexEvents("review-1", "Looks good.")),
      ok(codexEvents("review-1", JSON.stringify([{ ...finding("P1", "changed"), extra: true }]))),
    ]);
    try {
      const result = await createReviewer(runner, {
        agent: "codex",
        model: "codex-configured",
      }).review(request(repo));
      expect(runner.calls).toHaveLength(2);
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.producer).toEqual({
        session: "review-1",
        model: "codex-configured",
        provider: "openai",
      });
      expect("record" in result).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("a non-zero exit records an invalid review and invents no findings", async () => {
    const repo = await gitRepo();
    try {
      for (const agent of ["codex", "claude"] as const) {
        const runner = createFakeReviewCommandRunner([
          {
            exitCode: 1,
            stdout: agent === "codex" ? codexEvents("t-fail", "[]") : "",
            stderr: "Input exceeds the maximum length\n",
          },
        ]);
        const result = await createReviewer(runner, { agent, model: "reviewer" }).review(
          request(repo),
        );
        expect(runner.calls).toHaveLength(1);
        expect(result.status).toBe("invalid");
        if (result.status !== "invalid") continue;
        expect("findings" in result).toBe(false);
        expect(result.reason).toContain("exited 1");
        expect(result.reason).toContain("Input exceeds the maximum length");
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("a command that did not start or timed out records an invalid review", async () => {
    const repo = await gitRepo();
    try {
      const runner = createFakeReviewCommandRunner([
        { exitCode: null, stdout: "", stderr: "", timedOut: true },
      ]);
      const result = await createReviewer(runner, { agent: "codex", model: "m" }).review(
        request(repo),
      );
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" ? result.reason : "").toContain("timed out");
    } finally {
      await repo.cleanup();
    }
  });

  test("a failed Claude result records an invalid review", async () => {
    const repo = await gitRepo();
    try {
      const runner = createFakeReviewCommandRunner([
        ok(
          jsonl({
            type: "result",
            subtype: "error_max_turns",
            is_error: true,
            session_id: "s",
          }),
        ),
      ]);
      const result = await createReviewer(runner, { agent: "claude", model: "m" }).review(
        request(repo),
      );
      expect(runner.calls).toHaveLength(1);
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" ? result.reason : "").toContain("error_max_turns");
    } finally {
      await repo.cleanup();
    }
  });

  test("detached reviewers use configured exclusions despite source pattern tampering", async () => {
    const repo = await gitRepo();
    let started = false;
    try {
      await exec("git", [
        "-C",
        repo.dir,
        "sparse-checkout",
        "set",
        "--no-cone",
        "--",
        "/*",
        "!/src/",
        "!/.agents/",
      ]);
      const runner = createFakeReviewCommandRunner([ok(codexEvents("sparse", "[]"))], (call) => {
        started = true;
        expect(existsSync(path.join(call.cwd, "src"))).toBe(false);
        expect(existsSync(path.join(call.cwd, SKILL))).toBe(true);
      });
      const result = await createReviewer(runner, { agent: "codex", model: "m" }).review({
        ...request(repo),
        checkoutExclusions: ["src"],
      });
      expect(started).toBe(true);
      expect(result.status).toBe("recorded");
    } finally {
      await repo.cleanup();
    }
  });

  test("rejects a base that is not a commit id before starting a command", async () => {
    const repo = await gitRepo();
    try {
      const runner = createFakeReviewCommandRunner([]);
      const result = await createReviewer(runner, { agent: "codex", model: "m" }).review({
        ...request(repo),
        base: "--help",
      });
      expect(result.status).toBe("invalid");
      expect(runner.calls).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("review command runner", () => {
  test("captures stdout, stderr, and the exit code in the given directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paws-review-runner-"));
    try {
      const result = await createReviewCommandRunner().run({
        argv: ["sh", "-c", "pwd; echo err >&2; exit 3"],
        cwd: dir,
      });
      expect(result.exitCode).toBe(3);
      expect(result.stdout.trim().endsWith(path.basename(dir))).toBe(true);
      expect(result.stderr.trim()).toBe("err");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stops a command at its timeout", async () => {
    const result = await createReviewCommandRunner({ timeoutMs: 50 }).run({
      argv: ["sleep", "5"],
      cwd: tmpdir(),
    });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  });

  test("reports a command that does not start", async () => {
    const result = await createReviewCommandRunner().run({
      argv: ["paws-no-such-review-command"],
      cwd: tmpdir(),
    });
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBeUndefined();
  });
});

describe("fix feedback", () => {
  test("includes a failed command argv, exit, and the last 80 log lines", () => {
    const log = Array.from({ length: 100 }, (_, index) => `log-line-${index + 1}`).join("\n");
    const text = formatFixFeedback(decision("rejected", [commandItem()]), [
      { record: commandRecord(), log },
    ]);
    const tail = Array.from({ length: 80 }, (_, index) => `log-line-${index + 21}`).join("\n");
    expect(text).toBe(
      [
        `Closeout rejected at ${HEAD}.`,
        "Fix each failed command and each finding at or above failOn.",
        "When an item is blocked, you cannot fix it.",
        "",
        "## typecheck (command) failed",
        "exited 7",
        'argv: ["bun","run","typecheck"]',
        "exit: 7",
        "last 80 log lines:",
        tail,
      ].join("\n"),
    );
    expect(text).not.toContain("log-line-20");
  });

  test("includes a P1 finding when failOn is P1", () => {
    const text = formatFixFeedback(decision("rejected", [reviewDecisionItem()]), [
      {
        failOn: "P1",
        record: reviewRecord([
          finding("P0", "The handler throws on an empty list."),
          finding("P1", "The export drops a column."),
          finding("P2", "This P2 note stays out of the fix prompt."),
        ]),
      },
    ]);
    expect(text).toBe(
      [
        `Closeout rejected at ${HEAD}.`,
        "Fix each failed command and each finding at or above failOn.",
        "When an item is blocked, you cannot fix it.",
        "",
        "## adversarial-review (review) failed",
        "failOn: P1",
        "a finding meets failOn",
        "- P0",
        "  location: src/reviewed.ts",
        "  explanation: The handler throws on an empty list.",
        "  evidence: P0 observation",
        "- P1",
        "  location: src/reviewed.ts",
        "  explanation: The export drops a column.",
        "  evidence: P1 observation",
      ].join("\n"),
    );
    expect(text).not.toContain("This P2 note stays out of the fix prompt.");
  });

  test("states a blocked independence failure as something the implementer cannot fix", () => {
    const text = formatFixFeedback(
      decision("blocked", [
        {
          id: "adversarial-review",
          kind: "review",
          state: "independence",
          message: "reviewer session matches the candidate session",
        },
      ]),
      [],
    );
    expect(text).toBe(
      [
        `Closeout blocked at ${HEAD}.`,
        "Fix each failed command and each finding at or above failOn.",
        "When an item is blocked, you cannot fix it.",
        "",
        "## adversarial-review (review) blocked",
        "You cannot fix this. Blocked reason: independence.",
        "reviewer session matches the candidate session",
      ].join("\n"),
    );
  });
});

function reviewItem() {
  return {
    id: "adversarial-review",
    kind: "review" as const,
    gate: "beforePR" as const,
    skill: SKILL,
    independence: { differentSession: true, differentModel: true },
    failOn: "P1" as const,
  };
}

function decision(
  name: DecisionDocument["decision"],
  items: DecisionDocument["items"],
): DecisionDocument {
  return {
    specVersion: "0.1",
    decision: name,
    gate: "beforePR",
    base: "a".repeat(40),
    head: HEAD,
    candidate: { session: "implementer-session", model: "claude-opus", provider: "anthropic" },
    policy: { path: ".agents/closeout.yaml", digest: DIGEST, absent: false },
    items,
    warnings: [],
  };
}

function commandItem(): DecisionDocument["items"][number] {
  return { id: "typecheck", kind: "command", state: "failed", message: "exited 7", attempt: 1 };
}

function reviewDecisionItem(): DecisionDocument["items"][number] {
  return {
    id: "adversarial-review",
    kind: "review",
    state: "failed",
    message: "a finding meets failOn",
    attempt: 1,
  };
}

function commandRecord(): CommandRecord {
  return {
    specVersion: "0.1",
    recordType: "command",
    itemId: "typecheck",
    base: "a".repeat(40),
    head: HEAD,
    policyDigest: DIGEST,
    attempt: 1,
    evaluator: { name: "paws", version: "0.1" },
    producer: { name: "paws", version: "0.1" },
    exec: {
      argv: ["bun", "run", "typecheck"],
      exitCode: 7,
      timedOut: false,
      dirty: false,
      headMoved: false,
      durationMs: 10,
      truncated: false,
    },
    artifacts: [],
  };
}

function reviewRecord(findings: Finding[]): ReviewRecord {
  return {
    specVersion: "0.1",
    recordType: "review",
    itemId: "adversarial-review",
    base: "a".repeat(40),
    head: HEAD,
    policyDigest: DIGEST,
    attempt: 1,
    evaluator: { name: "paws", version: "0.1" },
    producer: { session: "reviewer-session", model: "gpt-5-codex", provider: "codex" },
    findings,
    artifacts: [],
  };
}

async function inspectCall(call: ReviewCommandRequest) {
  const head = (await exec("git", ["-C", call.cwd, "rev-parse", "HEAD"])).stdout.trim();
  const schemaFlag = call.argv.indexOf("--output-schema");
  const schema =
    schemaFlag === -1
      ? undefined
      : (JSON.parse(readFileSync(call.argv[schemaFlag + 1]!, "utf8")) as unknown);
  return { head, schema };
}

function evidenceValidator() {
  const schemaPath = new URL("../src/closeout-spec/schema/evidence.schema.json", import.meta.url);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

async function gitRepo(): Promise<{
  dir: string;
  base: string;
  head: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "paws-review-repo-"));
  await exec("git", ["init", "-b", "main", dir]);
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "reviewed.ts"), "export const reviewed = 1;\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "base"]);
  const base = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  await mkdir(path.join(dir, ".agents", "skills", "adversarial-review", "references"), {
    recursive: true,
  });
  await writeFile(path.join(dir, SKILL), `${SKILL_TEXT}\n`);
  await writeFile(
    path.join(dir, ".agents", "skills", "adversarial-review", "references", "severity.md"),
    `${REFERENCE_TEXT}\n`,
  );
  await writeFile(path.join(dir, "src", "reviewed.ts"), "export const reviewed = 2;\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "candidate"]);
  const head = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  return { dir, base, head, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function request(repo: { dir: string; base: string; head: string }) {
  return {
    item: reviewItem(),
    candidate: { session: "implementer", model: "implementer-model", provider: "test" },
    base: repo.base,
    head: repo.head,
    policyDigest: DIGEST,
    worktree: repo.dir,
    skillFiles: new Map([[SKILL, new TextEncoder().encode("Review skill")]]),
  };
}
