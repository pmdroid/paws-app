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
  formatFixFeedback,
  type CommandRecord,
  type DecisionDocument,
  type Finding,
  type ReviewRecord,
} from "../src/closeout-spec";
import {
  createCodexReviewer,
  type CodexAcpReply,
  type CodexAcpStart,
} from "../src/closeout/reviewer";

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

describe("closeout reviewer", () => {
  test("uses the policy skill snapshot instead of the candidate skill", async () => {
    const repo = await gitRepo();
    const script = scripted([{ sessionId: "review-local", model: "review-model", text: "[]" }]);
    try {
      const result = await createCodexReviewer(script.runner, { model: "configured" }).review({
        item: reviewItem(),
        candidate: { session: "implementer", model: "implementer-model", provider: "test" },
        base: repo.base,
        head: repo.head,
        policyDigest: DIGEST,
        worktree: repo.dir,
        skillFiles: new Map([[SKILL, new TextEncoder().encode("Policy snapshot review skill")]]),
      });
      expect(result.status).toBe("recorded");
      expect(script.starts[0]?.prompt).toContain("Policy snapshot review skill");
      expect(script.starts[0]?.prompt.split("# Diff ")[0]).not.toContain(SKILL_TEXT);
    } finally {
      await repo.cleanup();
    }
  });

  test("records the ACP session, reported model, and provider without judging independence", async () => {
    const repo = await gitRepo();
    const session = "implementer-session";
    const script = scripted([
      {
        sessionId: session,
        model: "gpt-5-codex",
        text: [
          "```json",
          JSON.stringify([finding("P1", "The constant changed without a test.")]),
          "```",
        ].join("\n"),
      },
    ]);
    try {
      const result = await createCodexReviewer(script.runner, { model: "codex-configured" }).review(
        {
          item: reviewItem(),
          candidate: {
            task: "QM-32",
            session,
            model: "claude-opus",
            provider: "anthropic",
          },
          base: repo.base,
          head: repo.head,
          policyDigest: DIGEST,
          worktree: repo.dir,
        },
      );
      expect(result.status).toBe("recorded");
      if (result.status !== "recorded") return;
      expect(result.candidate).toEqual({
        task: "QM-32",
        session,
        model: "claude-opus",
        provider: "anthropic",
      });
      expect(result.record.producer).toEqual({
        session,
        model: "gpt-5-codex",
        provider: "codex",
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
        findings: [finding("P1", "The constant changed without a test.")],
        artifacts: [],
      });
      expect(evidenceValidator()(result.record)).toBe(true);
      expect(script.starts).toHaveLength(1);
      const start = script.starts[0];
      expect(start?.role).toBe("reviewer");
      expect(start?.readOnly).toBe(true);
      expect(start?.checkpoint).toBe(false);
      expect(start?.fresh).toBe(true);
      expect(start?.itemId).toBe("adversarial-review");
      expect(start?.worktree).not.toBe(repo.dir);
      expect(start?.seenHead).toBe(repo.head);
      expect(existsSync(start?.worktree ?? "")).toBe(false);
      expect(start?.prompt).toContain(SKILL_TEXT);
      expect(start?.prompt).toContain(REFERENCE_TEXT);
      expect(start?.prompt).toContain("export const reviewed = 2");
      expect(start?.prompt).toContain("src/reviewed.ts");
      expect(start?.prompt).toContain("severity: P0, P1, P2, or P3");
    } finally {
      await repo.cleanup();
    }
  });

  test("re-asks once when the reply is malformed, then records an invalid review", async () => {
    const repo = await gitRepo();
    const script = scripted([
      { sessionId: "review-1", text: "Looks good." },
      {
        sessionId: "review-2",
        text: JSON.stringify([
          {
            severity: "P1",
            location: "src/reviewed.ts",
            explanation: "changed",
            evidence: "diff",
            extra: true,
          },
        ]),
      },
    ]);
    try {
      const result = await createCodexReviewer(script.runner, { model: "codex-configured" }).review(
        {
          item: reviewItem(),
          candidate: {
            session: "implementer-session",
            model: "claude-opus",
            provider: "anthropic",
          },
          base: repo.base,
          head: repo.head,
          policyDigest: DIGEST,
          worktree: repo.dir,
        },
      );
      expect(script.starts).toHaveLength(2);
      expect(script.starts[0]?.fresh).toBe(true);
      expect(script.starts[1]?.fresh).toBe(false);
      expect(script.starts[1]?.sessionId).toBe("review-1");
      expect(script.starts[1]?.prompt).toContain(
        "The previous reply was not a valid findings array.",
      );
      expect(script.starts[0]?.prompt).toContain(SKILL_TEXT);
      expect(script.starts[0]?.prompt).toContain(`Diff ${repo.base}..${repo.head}`);
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.producer).toEqual({
        session: "review-2",
        model: "codex-configured",
        provider: "codex",
      });
      expect(result.candidate.session).toBe("implementer-session");
      expect("record" in result).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("records findings when the single re-ask is valid", async () => {
    const repo = await gitRepo();
    const script = scripted([
      { sessionId: "review-1", text: "not json" },
      {
        sessionId: "review-2",
        model: "gpt-5-codex",
        text: JSON.stringify([finding("P2", "The rename dropped a caller.")]),
      },
    ]);
    try {
      const result = await createCodexReviewer(script.runner, { model: "codex-configured" }).review(
        {
          item: reviewItem(),
          candidate: {
            session: "implementer-session",
            model: "claude-opus",
            provider: "anthropic",
          },
          base: repo.base,
          head: repo.head,
          policyDigest: DIGEST,
          worktree: repo.dir,
        },
      );
      expect(script.starts).toHaveLength(2);
      expect(result.status).toBe("recorded");
      if (result.status !== "recorded") return;
      expect(result.record.producer).toEqual({
        session: "review-2",
        model: "gpt-5-codex",
        provider: "codex",
      });
      expect(result.record.findings).toEqual([finding("P2", "The rename dropped a caller.")]);
    } finally {
      await repo.cleanup();
    }
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

function scripted(replies: CodexAcpReply[]) {
  const starts: Array<CodexAcpStart & { seenHead: string }> = [];
  let index = 0;
  return {
    starts,
    runner: {
      async start(input: CodexAcpStart) {
        const seenHead = (
          await exec("git", ["-C", input.worktree, "rev-parse", "HEAD"])
        ).stdout.trim();
        starts.push({ ...input, seenHead });
        const reply = replies[index];
        index += 1;
        if (!reply) throw new Error("no scripted reply");
        return reply;
      },
    },
  };
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
