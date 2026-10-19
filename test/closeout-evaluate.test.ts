import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import {
  decisionExit,
  evaluate,
  INVALID_INVOCATION_EXIT,
  PAWS_CLOSEOUT_NAME,
  PAWS_CLOSEOUT_VERSION,
  CLOSEOUT_REFERENCE_NAME,
  CLOSEOUT_REFERENCE_VERSION,
  type EvaluateRequest,
  type EvaluateTrust,
} from "../src/closeout-spec/evaluate";
import type {
  CommandExec,
  CommandRecord,
  DecisionDocument,
  DecisionItem,
  EvidenceRecord,
  Finding,
  ResolvedCommand,
  ResolvedPolicy,
  ResolvedPolicyAbsent,
  ResolvedPolicyPresent,
  ResolvedRequirement,
  ResolvedReview,
  ResolvedSetup,
  ResolvedUnsupported,
  ReviewRecord,
  Severity,
} from "../src/closeout-spec";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"cd".repeat(32)}`;
const BASE = "11".repeat(20);
const HEAD = "22".repeat(20);
const OTHER_HEAD = "33".repeat(20);

const validateDecision = compileDecisionSchema();

type ItemExpect = {
  id: string;
  kind: string;
  state: DecisionItem["state"];
  message: string;
  attempt?: number;
};

const paws = { name: PAWS_CLOSEOUT_NAME, version: PAWS_CLOSEOUT_VERSION };
const reference = { name: CLOSEOUT_REFERENCE_NAME, version: CLOSEOUT_REFERENCE_VERSION };
const referenceTrust: EvaluateTrust = { trustReference: true };

describe("closeout evaluate", () => {
  test("exit 2 is an invalid invocation and is not a decision", () => {
    expect(INVALID_INVOCATION_EXIT).toBe(2);
    expect(decisionExit("accepted")).toBe(0);
    expect(decisionExit("rejected")).toBe(1);
    expect(decisionExit("blocked")).toBe(3);
  });

  const rows: Array<{
    name: string;
    policy?: ResolvedPolicy;
    records?: EvidenceRecord[];
    request?: Partial<EvaluateRequest>;
    trust?: EvaluateTrust;
    decision: DecisionDocument["decision"];
    message?: string;
    items: ItemExpect[];
    warnings?: Array<{ code: string; message: string }>;
  }> = [
    {
      name: "skipped by paths",
      policy: repo({
        items: [command("engine", ["bun", "test"], ["apps/engine/**"])],
      }),
      request: { changedPaths: ["README.md"] },
      decision: "accepted",
      items: [
        {
          id: "engine",
          kind: "command",
          state: "skipped",
          message: "no changed path matches",
        },
      ],
    },
    {
      name: "exhausted",
      policy: repo({
        retry: { maxFailedAttemptsPerItem: 1, scope: "candidate" },
        items: [command("check", ["false"])],
      }),
      records: [commandRecord("check", ["false"], { exitCode: 1 })],
      decision: "blocked",
      items: [
        {
          id: "check",
          kind: "command",
          state: "exhausted",
          message: "1 of 1 allowed failed attempts used. Stop retrying and ask for help.",
        },
      ],
    },
    {
      name: "unsupported kind",
      policy: repo({ items: [unsupported("ci", "ci")] }),
      decision: "blocked",
      items: [
        {
          id: "ci",
          kind: "ci",
          state: "unsupported",
          message: "kind ci is not supported",
        },
      ],
    },
    {
      name: "missing",
      policy: repo({ items: [review("adversarial-review")] }),
      decision: "blocked",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "missing",
          message: "no evidence for this candidate and policy",
        },
      ],
    },
    {
      name: "stale",
      policy: repo({ items: [review("adversarial-review")] }),
      records: [reviewRecord("adversarial-review", [], { head: OTHER_HEAD })],
      decision: "blocked",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "stale",
          message: "evidence is for a different candidate or policy",
        },
      ],
    },
    {
      name: "invalid duplicate attempt",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [
        commandRecord("check", ["true"], { exitCode: 0 }),
        commandRecord("check", ["true"], { exitCode: 0 }),
      ],
      decision: "blocked",
      items: [
        {
          id: "check",
          kind: "command",
          state: "invalid",
          message: "duplicate evidence attempt",
        },
      ],
    },
    {
      name: "untrusted producer",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [
        commandRecord("check", ["true"], {
          exitCode: 0,
          producer: { name: "someone", version: "0.0.1" },
        }),
      ],
      decision: "blocked",
      items: [
        {
          id: "check",
          kind: "command",
          state: "untrusted",
          message: "command evidence producer is not trusted",
          attempt: 1,
        },
      ],
    },
    {
      name: "untrusted when argv also differs",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [
        commandRecord("check", ["false"], {
          exitCode: 0,
          producer: { name: CLOSEOUT_REFERENCE_NAME, version: CLOSEOUT_REFERENCE_VERSION },
        }),
      ],
      decision: "blocked",
      items: [
        {
          id: "check",
          kind: "command",
          state: "untrusted",
          message: "command evidence producer is not trusted",
          attempt: 1,
        },
      ],
    },
    {
      name: "invalid argv",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [commandRecord("check", ["false"], { exitCode: 0 })],
      decision: "blocked",
      items: [
        {
          id: "check",
          kind: "command",
          state: "invalid",
          message: "command evidence does not match the policy argv",
          attempt: 1,
        },
      ],
    },
    {
      name: "command timed out",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [commandRecord("check", ["true"], { exitCode: null, timedOut: true })],
      decision: "rejected",
      items: [
        { id: "check", kind: "command", state: "failed", message: "command timed out", attempt: 1 },
      ],
    },
    {
      name: "command could not start",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [commandRecord("check", ["true"], { exitCode: null })],
      decision: "rejected",
      items: [
        {
          id: "check",
          kind: "command",
          state: "failed",
          message: "command could not start",
          attempt: 1,
        },
      ],
    },
    {
      name: "command exited non-zero",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [commandRecord("check", ["true"], { exitCode: 2 })],
      decision: "rejected",
      items: [
        {
          id: "check",
          kind: "command",
          state: "failed",
          message: "command exited 2",
          attempt: 1,
        },
      ],
    },
    {
      name: "command moved HEAD",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [commandRecord("check", ["true"], { exitCode: 0, headMoved: true, dirty: true })],
      decision: "rejected",
      items: [
        {
          id: "check",
          kind: "command",
          state: "failed",
          message: "command moved HEAD",
          attempt: 1,
        },
      ],
    },
    {
      name: "command left the worktree dirty",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [commandRecord("check", ["true"], { exitCode: 0, dirty: true })],
      decision: "rejected",
      items: [
        {
          id: "check",
          kind: "command",
          state: "failed",
          message: "command left the worktree dirty",
          attempt: 1,
        },
      ],
    },
    {
      name: "command passed",
      policy: repo({ items: [command("check", ["true"])] }),
      records: [commandRecord("check", ["true"], { exitCode: 0 })],
      decision: "accepted",
      items: [{ id: "check", kind: "command", state: "passed", message: "exited 0", attempt: 1 }],
    },
    {
      name: "setup failed",
      policy: repo({
        setup: [setup("install", ["bun", "install"])],
        items: [command("check", ["bun", "test"])],
      }),
      records: [commandRecord("install", ["bun", "install"], { exitCode: 1 })],
      decision: "rejected",
      items: [
        { id: "install", kind: "setup", state: "failed", message: "command exited 1", attempt: 1 },
        { id: "check", kind: "command", state: "skipped", message: "setup failed" },
      ],
    },
    {
      name: "setup passed",
      policy: repo({ setup: [setup("install", ["bun", "install"])] }),
      records: [commandRecord("install", ["bun", "install"], { exitCode: 0, dirty: true })],
      decision: "accepted",
      items: [{ id: "install", kind: "setup", state: "passed", message: "exited 0", attempt: 1 }],
    },
    {
      name: "setup failure skips a later setup step",
      policy: repo({
        setup: [setup("install", ["false"]), setup("build", ["true"])],
      }),
      records: [commandRecord("install", ["false"], { exitCode: 1 })],
      decision: "rejected",
      items: [
        { id: "install", kind: "setup", state: "failed", message: "command exited 1", attempt: 1 },
        { id: "build", kind: "setup", state: "skipped", message: "setup failed" },
      ],
    },
    {
      name: "review failed when a finding meets failOn",
      policy: repo({ items: [review("adversarial-review", "P1")] }),
      records: [
        reviewRecord("adversarial-review", [finding("P1")], {
          session: "reviewer",
          model: "model-b",
        }),
      ],
      decision: "rejected",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "failed",
          message: "finding at P1 meets failOn P1",
          attempt: 1,
        },
      ],
    },
    {
      name: "review failed prefers P0 over P1",
      policy: repo({ items: [review("adversarial-review", "P2")] }),
      records: [
        reviewRecord("adversarial-review", [finding("P2"), finding("P0"), finding("P1")], {
          session: "reviewer",
          model: "model-b",
        }),
      ],
      decision: "rejected",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "failed",
          message: "finding at P0 meets failOn P2",
          attempt: 1,
        },
      ],
    },
    {
      name: "independence differentSession",
      policy: repo({ items: [review("adversarial-review", "P1")] }),
      records: [
        reviewRecord("adversarial-review", [finding("P3")], {
          session: "implementer",
          model: "model-b",
        }),
      ],
      decision: "blocked",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "independence",
          message: "reviewer does not satisfy differentSession",
          attempt: 1,
        },
      ],
    },
    {
      name: "independence differentModel when the model is empty",
      policy: repo({ items: [review("adversarial-review", "P1")] }),
      request: {
        candidate: { session: "implementer", model: "", provider: "codex" },
      },
      records: [reviewRecord("adversarial-review", [], { session: "reviewer", model: "" })],
      decision: "blocked",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "independence",
          message: "reviewer does not satisfy differentModel",
          attempt: 1,
        },
      ],
    },
    {
      name: "independence fails when the session is unknown",
      policy: repo({
        items: [review("adversarial-review", "P1", { session: true, model: false })],
      }),
      request: { candidate: { session: "  ", model: "model-a", provider: "codex" } },
      records: [reviewRecord("adversarial-review", [], { session: "reviewer", model: "model-b" })],
      decision: "blocked",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "independence",
          message: "reviewer does not satisfy differentSession",
          attempt: 1,
        },
      ],
    },
    {
      name: "review passed",
      policy: repo({ items: [review("adversarial-review", "P1")] }),
      records: [
        reviewRecord("adversarial-review", [finding("P2")], {
          session: "reviewer",
          model: "model-b",
        }),
      ],
      decision: "accepted",
      items: [
        {
          id: "adversarial-review",
          kind: "review",
          state: "passed",
          message: "review findings satisfy the policy",
          attempt: 1,
        },
      ],
    },
    {
      name: "setup failure + missing command is rejected",
      policy: repo({
        setup: [setup("install", ["false"])],
        items: [command("check", ["true"])],
      }),
      records: [commandRecord("install", ["false"], { exitCode: 1 })],
      decision: "rejected",
      items: [
        { id: "install", kind: "setup", state: "failed", message: "command exited 1", attempt: 1 },
        { id: "check", kind: "command", state: "skipped", message: "setup failed" },
      ],
    },
    {
      name: "setup failure + missing review stays blocked",
      policy: repo({
        setup: [setup("install", ["false"])],
        items: [review("adversarial-review")],
      }),
      records: [commandRecord("install", ["false"], { exitCode: 1 })],
      decision: "blocked",
      items: [
        { id: "install", kind: "setup", state: "failed", message: "command exited 1", attempt: 1 },
        {
          id: "adversarial-review",
          kind: "review",
          state: "missing",
          message: "no evidence for this candidate and policy",
        },
      ],
    },
    {
      name: "independence + failed is blocked",
      policy: repo({
        items: [command("check", ["true"]), review("adversarial-review")],
      }),
      records: [
        commandRecord("check", ["true"], { exitCode: 1 }),
        reviewRecord("adversarial-review", [finding("P3")], {
          session: "implementer",
          model: "model-b",
        }),
      ],
      decision: "blocked",
      items: [
        { id: "check", kind: "command", state: "failed", message: "command exited 1", attempt: 1 },
        {
          id: "adversarial-review",
          kind: "review",
          state: "independence",
          message: "reviewer does not satisfy differentSession",
          attempt: 1,
        },
      ],
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const decision = run(row.policy ?? repo({}), row.records ?? [], row.request, row.trust);
      expect(decision.decision).toBe(row.decision);
      expect(decisionExit(decision.decision)).toBe(exitOf(row.decision));
      expect(decision.items).toEqual(row.items);
      expect(decision.message).toBe(row.message);
      expect(decision.warnings).toEqual(row.warnings ?? []);
      expect(decision.specVersion).toBe("0.1");
      expect(decision.gate).toBe("beforePR");
    });
  }

  test("review finding keys follow exact location normalization independently of evidence order", () => {
    const policy = repo({
      retry: { maxFailedAttemptsPerItem: 2, maxFailedReviewAttempts: 10, scope: "task" },
      items: [review("review")],
    });
    for (const [first, second, exhausted] of [
      ["src/a.rs:12", " src/a.rs:40:7 ", true],
      ["src/a.rs:12-20", "src/a.rs", false],
      [":12", ":40", false],
      ["12", "12:40", true],
      ["src/a.rs:1:2:3", "src/a.rs:1", false],
      ["src/a.rs:１２", "src/a.rs", false],
      ["src/a.rs:", "src/a.rs", false],
    ] as const) {
      const records = [first, second].map((location, index) =>
        reviewRecord("review", [{ ...finding("P1"), location }], {
          head: index === 0 ? OTHER_HEAD : HEAD,
          task: "stable",
          attempt: 1,
        }),
      );
      for (const ordered of [records, [...records].reverse()]) {
        expect(run(policy, ordered, { task: "stable" }).items[0]?.state).toBe(
          exhausted ? "exhausted" : "failed",
        );
      }
      expect(run(policy, [records[0]!, records[0]!], { task: "stable" }).items[0]?.state).toBe(
        "invalid",
      );
    }
  });

  test("a missing setup does not skip later requirements", () => {
    const decision = run(
      repo({
        setup: [setup("install", ["true"])],
        items: [command("check", ["true"]), review("adversarial-review")],
      }),
      [],
    );
    expect(decision.decision).toBe("blocked");
    expect(decision.items.map((item) => item.state)).toEqual(["missing", "missing", "missing"]);
    expectSchema(decision);
  });

  test("an unsupported kind with no matching path is skipped", () => {
    const decision = run(repo({ items: [unsupported("ci", "ci", ["apps/engine/**"])] }), [], {
      changedPaths: [],
    });
    expect(decision.decision).toBe("accepted");
    expect(decision.items[0]).toMatchObject({
      state: "skipped",
      message: "no changed path matches",
    });
    expectSchema(decision);
  });

  test("a matching unsupported kind stays unsupported", () => {
    const decision = run(repo({ items: [unsupported("ci", "ci", ["apps/engine/**"])] }), [], {
      changedPaths: ["apps/engine/main.ts"],
    });
    expect(decision.decision).toBe("blocked");
    expect(decision.items[0]).toMatchObject({
      state: "unsupported",
      message: "kind ci is not supported",
    });
    expectSchema(decision);
  });

  test("unreadable changed paths are invalid and block", () => {
    const decision = run(
      repo({
        items: [
          command("engine", ["bun", "test"], ["apps/engine/**"]),
          command("always", ["true"]),
        ],
      }),
      [commandRecord("always", ["true"], { exitCode: 0 })],
      { changedPaths: null },
    );
    expect(decision.decision).toBe("blocked");
    expect(decision.message?.startsWith("changed paths are unavailable")).toBe(true);
    expect(decision.items[0]).toMatchObject({
      id: "engine",
      state: "invalid",
      message: "changed paths are unavailable",
    });
    expect(decision.items[0]?.state).not.toBe("skipped");
    expect(decision.items[1]).toMatchObject({ id: "always", state: "passed" });
    expect(decisionExit(decision.decision)).toBe(3);
    expectSchema(decision);
  });

  test("unreadable evidence blocks before records are judged", () => {
    const decision = run(
      repo({ items: [command("check", ["true"])] }),
      [commandRecord("check", ["true"], { exitCode: 0 })],
      { evidenceError: "could not read the evidence directory" },
    );
    expect(decision.decision).toBe("blocked");
    expect(decision.message).toBe("could not read the evidence directory");
    expect(decision.items).toEqual([]);
    expect(decision.policy).toEqual({
      path: ".agents/closeout.yaml",
      digest: DIGEST,
      absent: false,
    });
    expectSchema(decision);
  });

  test("a failed policy load blocks with absent false", () => {
    const decision = run(repo({ items: [command("check", ["true"])] }), [], {
      policyLoadError: "could not read the policy file",
    });
    expect(decision.decision).toBe("blocked");
    expect(decision.message).toBe("could not read the policy file");
    expect(decision.policy).toEqual({ path: null, digest: null, absent: false });
    expect(decision.items).toEqual([]);
    expectSchema(decision);
  });

  test("an absent policy is accepted", () => {
    const decision = run(absentPolicy(), [commandRecord("check", ["true"], { exitCode: 1 })]);
    expect(decision.decision).toBe("accepted");
    expect(decision.message).toBe("no closeout policy");
    expect(decision.policy).toEqual({ path: null, digest: null, absent: true });
    expect(decision.items).toEqual([]);
    expect(decisionExit(decision.decision)).toBe(0);
    expectSchema(decision);
  });

  test("a global policy warns and still judges", () => {
    const decision = run(
      repo({
        source: "global",
        items: [command("check", ["true"])],
      }),
      [],
    );
    expect(decision.decision).toBe("blocked");
    expect(decision.policy).toEqual({
      path: "~/.agents/closeout.yaml",
      digest: DIGEST,
      absent: false,
    });
    expect(decision.warnings).toEqual([
      {
        code: "global-policy",
        message: "Using ~/.agents/closeout.yaml because origin/main has no closeout policy.",
      },
    ]);
    expectSchema(decision);
  });

  test("conformance trust accepts closeout-reference at the fixture version", () => {
    const decision = run(
      repo({ items: [command("check", ["false"])] }),
      [
        commandRecord("check", ["false"], {
          exitCode: 1,
          producer: reference,
          evaluator: reference,
        }),
      ],
      undefined,
      referenceTrust,
    );
    expect(decision.items[0]).toMatchObject({ state: "failed", message: "command exited 1" });
    expectSchema(decision);
  });

  test("reference trust can pin a different fixture version", () => {
    const decision = run(
      repo({ items: [command("check", ["true"])] }),
      [commandRecord("check", ["true"], { exitCode: 0, producer: reference })],
      undefined,
      { trustReference: true, referenceVersion: "9.9.9" },
    );
    expect(decision.items[0]?.state).toBe("untrusted");
    expectSchema(decision);
  });

  test("the greatest matching attempt is the one that is judged", () => {
    const decision = run(repo({ items: [command("check", ["true"])] }), [
      commandRecord("check", ["true"], { exitCode: 1, attempt: 1 }),
      commandRecord("check", ["true"], { exitCode: 0, attempt: 2 }),
    ]);
    expect(decision.decision).toBe("accepted");
    expect(decision.items[0]).toMatchObject({ state: "passed", message: "exited 0", attempt: 2 });
    expectSchema(decision);
  });

  test("evidence kind that does not match the requirement is invalid", () => {
    const decision = run(repo({ items: [review("adversarial-review")] }), [
      commandRecord("adversarial-review", ["true"], { exitCode: 0 }),
    ]);
    expect(decision.items[0]).toMatchObject({
      state: "invalid",
      message: "evidence kind does not match the requirement",
      attempt: 1,
    });
    expectSchema(decision);
  });

  test("task retry scope requires a stable task id", () => {
    const decision = run(
      repo({
        retry: { maxFailedAttemptsPerItem: 2, scope: "task" },
        items: [command("check", ["true"])],
      }),
      [],
    );
    expect(decision.decision).toBe("blocked");
    expect(decision.message).toBe("task retry scope requires --task with a stable task ID");
    expect(decision.items).toEqual([]);
    expectSchema(decision);
  });

  test("a blank or oversized task id blocks", () => {
    const blank = run(repo({ items: [command("check", ["true"])] }), [], { task: "   " });
    expect(blank.message).toBe("task ID must contain 1 to 256 bytes and cannot be blank");
    expectSchema(blank);
    const long = run(repo({ items: [command("check", ["true"])] }), [], {
      task: "a".repeat(257),
    });
    expect(long.decision).toBe("blocked");
    expect(long.candidate.task).toBeUndefined();
    expectSchema(long);
    const wide = run(repo({ items: [command("check", ["true"])] }), [], {
      task: "é".repeat(200),
    });
    expect(wide.message).toBe("task ID must contain 1 to 256 bytes and cannot be blank");
    expectSchema(wide);
  });

  describe("retry scope", () => {
    test("candidate scope ignores a failure on another head", () => {
      const decision = run(
        repo({
          retry: { maxFailedAttemptsPerItem: 1, scope: "candidate" },
          items: [command("check", ["false"])],
        }),
        [commandRecord("check", ["false"], { exitCode: 1, head: OTHER_HEAD })],
      );
      expect(decision.items[0]).toMatchObject({
        state: "stale",
        message: "evidence is for a different candidate or policy",
      });
      expectSchema(decision);
    });

    test("candidate scope counts failures on this base and head", () => {
      const decision = run(
        repo({
          retry: { maxFailedAttemptsPerItem: 2, scope: "candidate" },
          items: [command("check", ["false"])],
        }),
        [
          commandRecord("check", ["false"], { exitCode: 1, attempt: 1 }),
          commandRecord("check", ["false"], { exitCode: 1, attempt: 2, head: OTHER_HEAD }),
        ],
      );
      expect(decision.items[0]).toMatchObject({ state: "failed", message: "command exited 1" });
      expectSchema(decision);
    });

    test("task scope counts failures for the same task on every head", () => {
      const decision = run(
        repo({
          retry: { maxFailedAttemptsPerItem: 1, scope: "task" },
          items: [command("check", ["false"])],
        }),
        [commandRecord("check", ["false"], { exitCode: 1, head: OTHER_HEAD, task: "task-one" })],
        { task: "task-one" },
      );
      expect(decision.decision).toBe("blocked");
      expect(decision.items[0]).toMatchObject({
        state: "exhausted",
        message: "1 of 1 allowed failed attempts used. Stop retrying and ask for help.",
      });
      expect(decision.candidate.task).toBe("task-one");
      expectSchema(decision);
    });

    test("task scope ignores a different task", () => {
      const decision = run(
        repo({
          retry: { maxFailedAttemptsPerItem: 1, scope: "task" },
          items: [command("check", ["false"])],
        }),
        [commandRecord("check", ["false"], { exitCode: 1, head: OTHER_HEAD, task: "task-one" })],
        { task: "task-two" },
      );
      expect(decision.items[0]).toMatchObject({
        state: "missing",
        message: "no evidence for this candidate and policy",
      });
      expectSchema(decision);
    });

    test("passed, missing, and stale evidence do not consume the limit", () => {
      const limit = { maxFailedAttemptsPerItem: 1, scope: "candidate" } as const;
      const passed = run(repo({ retry: limit, items: [command("check", ["true"])] }), [
        commandRecord("check", ["true"], { exitCode: 0 }),
      ]);
      expect(passed.decision).toBe("accepted");
      expect(passed.items[0]?.state).toBe("passed");

      const missing = run(repo({ retry: limit, items: [command("check", ["true"])] }), []);
      expect(missing.items[0]?.state).toBe("missing");

      const stale = run(repo({ retry: limit, items: [command("check", ["true"])] }), [
        commandRecord("check", ["true"], { exitCode: 1, policyDigest: OTHER_DIGEST }),
      ]);
      expect(stale.items[0]?.state).toBe("stale");

      const untrusted = run(repo({ retry: limit, items: [command("check", ["true"])] }), [
        commandRecord("check", ["true"], {
          exitCode: 1,
          producer: { name: "stranger", version: "0.0.0" },
        }),
      ]);
      expect(untrusted.items[0]?.state).toBe("untrusted");

      const independent = run(repo({ retry: limit, items: [review("adversarial-review")] }), [
        reviewRecord("adversarial-review", [], { session: "implementer", model: "model-b" }),
      ]);
      expect(independent.items[0]?.state).toBe("independence");

      for (const decision of [passed, missing, stale, untrusted, independent]) {
        expect(decision.items[0]?.state).not.toBe("exhausted");
        expectSchema(decision);
      }
    });

    test("a later pass does not erase an earlier failure once the limit is reached", () => {
      const decision = run(
        repo({
          retry: { maxFailedAttemptsPerItem: 1, scope: "candidate" },
          items: [command("check", ["true"])],
        }),
        [
          commandRecord("check", ["true"], { exitCode: 1, attempt: 1 }),
          commandRecord("check", ["true"], { exitCode: 0, attempt: 2 }),
        ],
      );
      expect(decision.items[0]?.state).toBe("exhausted");
      expectSchema(decision);
    });

    test("duplicate attempts are invalid and do not spend the limit", () => {
      const decision = run(
        repo({
          retry: { maxFailedAttemptsPerItem: 1, scope: "candidate" },
          items: [command("check", ["false"])],
        }),
        [
          commandRecord("check", ["false"], { exitCode: 1, attempt: 1 }),
          commandRecord("check", ["false"], { exitCode: 1, attempt: 1 }),
        ],
      );
      expect(decision.items[0]).toMatchObject({
        state: "invalid",
        message: "duplicate evidence attempt",
      });
      expectSchema(decision);
    });
  });

  test("path patterns match by prefix and glob", () => {
    const cases: Array<{ pattern: string; changed: string; skipped: boolean }> = [
      { pattern: "apps/engine/**", changed: "apps/engine/src/main.ts", skipped: false },
      { pattern: "apps/engine/**", changed: "apps/engine", skipped: false },
      { pattern: "apps/engine/**", changed: "apps/frontend/main.ts", skipped: true },
      { pattern: "apps/engine/", changed: "apps/engine/main.ts", skipped: false },
      { pattern: "apps/engine/", changed: "apps/engine", skipped: true },
      { pattern: "apps/engine/", changed: "apps/engine-extra/main.ts", skipped: true },
      { pattern: "*.ts", changed: "src/main.ts", skipped: true },
      { pattern: "**/*.ts", changed: "src/main.ts", skipped: false },
      { pattern: "**/*.ts", changed: "main.ts", skipped: false },
      { pattern: "a?c", changed: "abc", skipped: false },
      { pattern: "a?c", changed: "ac", skipped: true },
      { pattern: "*", changed: "a/b", skipped: true },
      { pattern: "a/**/b", changed: "a/b", skipped: false },
      { pattern: "a/**/b", changed: "a/x/y/b", skipped: false },
    ];
    for (const specCase of cases) {
      const decision = run(repo({ items: [command("engine", ["true"], [specCase.pattern])] }), [], {
        changedPaths: [specCase.changed],
      });
      expect(decision.items[0]?.state).toBe(specCase.skipped ? "skipped" : "missing");
      if (specCase.skipped) {
        expect(decision.items[0]?.message).toBe("no changed path matches");
      }
      expectSchema(decision);
    }
  });
});

function run(
  policy: ResolvedPolicy,
  records: readonly EvidenceRecord[],
  request?: Partial<EvaluateRequest>,
  trust?: EvaluateTrust,
): DecisionDocument {
  const decision = evaluate(policy, records, requestOf(request), trust);
  expectSchema(decision);
  return decision;
}

function requestOf(request?: Partial<EvaluateRequest>): EvaluateRequest {
  return {
    base: BASE,
    head: HEAD,
    gate: "beforePR",
    candidate: { session: "implementer", model: "model-a", provider: "codex" },
    ...request,
  };
}

function exitOf(decision: DecisionDocument["decision"]): 0 | 1 | 3 {
  if (decision === "accepted") return 0;
  if (decision === "rejected") return 1;
  return 3;
}

function repo(
  input: {
    items?: ResolvedRequirement[];
    setup?: ResolvedSetup[];
    retry?: ResolvedPolicyPresent["retry"];
    source?: "repo" | "global";
    entryPath?: string;
  } = {},
): ResolvedPolicyPresent {
  const source = input.source ?? "repo";
  const policy: ResolvedPolicyPresent = {
    source,
    digest: DIGEST,
    entryPath:
      input.entryPath ??
      (source === "global" ? "~/.agents/closeout.yaml" : ".agents/closeout.yaml"),
    setup: input.setup ?? [],
    items: input.items ?? [],
    files: [{ path: ".agents/closeout.yaml", sha256: "ef".repeat(32) }],
  };
  if (input.retry) policy.retry = input.retry;
  return policy;
}

function absentPolicy(): ResolvedPolicyAbsent {
  return {
    source: "none",
    digest: null,
    entryPath: null,
    setup: [],
    items: [],
    files: [],
  };
}

function command(id: string, exec: string[], paths?: string[]): ResolvedCommand {
  const item: ResolvedCommand = {
    id,
    kind: "command",
    gate: "beforePR",
    exec,
    timeoutSeconds: 30,
  };
  if (paths) item.paths = paths;
  return item;
}

function review(
  id: string,
  failOn: Severity = "P1",
  independence: { session?: boolean; model?: boolean } = {},
): ResolvedReview {
  return {
    id,
    kind: "review",
    gate: "beforePR",
    skill: ".agents/skills/adversarial-review/SKILL.md",
    independence: {
      differentSession: independence.session ?? true,
      differentModel: independence.model ?? true,
    },
    failOn,
  };
}

function setup(id: string, exec: string[], paths?: string[]): ResolvedSetup {
  const item: ResolvedSetup = {
    id,
    kind: "setup",
    gate: "beforePR",
    exec,
    timeoutSeconds: 30,
  };
  if (paths) item.paths = paths;
  return item;
}

function unsupported(id: string, kind: string, paths?: string[]): ResolvedUnsupported {
  const item: ResolvedUnsupported = {
    id,
    kind,
    gate: "beforePR",
    supported: false,
  };
  if (paths) item.paths = paths;
  return item;
}

function commandRecord(
  itemId: string,
  argv: string[],
  overrides: {
    exitCode?: number | null;
    timedOut?: boolean;
    dirty?: boolean;
    headMoved?: boolean;
    attempt?: number;
    head?: string;
    base?: string;
    task?: string;
    policyDigest?: string;
    producer?: CommandRecord["producer"];
    evaluator?: CommandRecord["evaluator"];
  } = {},
): CommandRecord {
  const exec: CommandExec = {
    argv,
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    timedOut: overrides.timedOut ?? false,
    dirty: overrides.dirty ?? false,
    headMoved: overrides.headMoved ?? false,
    durationMs: 1,
    truncated: false,
  };
  const record: CommandRecord = {
    specVersion: "0.1",
    recordType: "command",
    itemId,
    base: overrides.base ?? BASE,
    head: overrides.head ?? HEAD,
    policyDigest: overrides.policyDigest ?? DIGEST,
    attempt: overrides.attempt ?? 1,
    evaluator: overrides.evaluator ?? paws,
    producer: overrides.producer ?? paws,
    exec,
    artifacts: [],
  };
  if (overrides.task) record.task = overrides.task;
  return record;
}

function reviewRecord(
  itemId: string,
  findings: Finding[],
  overrides: {
    session?: string;
    model?: string;
    provider?: string;
    head?: string;
    attempt?: number;
    task?: string;
  } = {},
): ReviewRecord {
  const record: ReviewRecord = {
    specVersion: "0.1",
    recordType: "review",
    itemId,
    base: BASE,
    head: overrides.head ?? HEAD,
    policyDigest: DIGEST,
    attempt: overrides.attempt ?? 1,
    evaluator: paws,
    producer: {
      session: overrides.session ?? "reviewer",
      model: overrides.model ?? "model-b",
      provider: overrides.provider ?? "other",
    },
    findings,
    artifacts: [],
  };
  if (overrides.task) record.task = overrides.task;
  return record;
}

function finding(severity: Severity): Finding {
  return {
    severity,
    location: "src/lib.rs",
    explanation: "The requirement fails open.",
    evidence: "An empty reviewer model is treated as independent.",
  };
}

function compileDecisionSchema(): ValidateFunction {
  const schema: unknown = JSON.parse(
    readFileSync(
      new URL("../src/closeout-spec/schema/decision.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema as object);
}

function expectSchema(decision: DecisionDocument): void {
  if (!validateDecision(decision)) {
    throw new Error(formatErrors(validateDecision.errors));
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "decision document rejected";
  return errors.map((error) => `${error.instancePath} ${error.message ?? ""}`).join("; ");
}
