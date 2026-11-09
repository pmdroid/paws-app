import { join } from "node:path";
import { type FakeStep } from "../../src/acp/testing/script";
import { type Proof } from "./harness";

const FAILURE = "Acme must count shelf b";
let reviews = 0;

function commit(worktree: string, content: string, message: string): FakeStep[] {
  return [
    { type: "fs_write", path: join(worktree, "widgets.txt"), content },
    { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: worktree },
    {
      type: "terminal",
      command: "git",
      args: [
        "-c",
        "user.name=Acme Agent",
        "-c",
        "user.email=agent@acme.test",
        "commit",
        "-q",
        "-m",
        message,
      ],
      cwd: worktree,
    },
  ];
}

export default {
  covers: [
    "src/closeout/**",
    "src/closeout-spec/**",
    "src/loop/closeout-round.ts",
    "src/loop/closeout-focus.ts",
    "src/loop/operations.ts",
    "src/loop/orchestrator.ts",
  ],
  summary:
    "An independent P1 review sends the item back with its finding text and location; the fix turn corrects it and the item merges.",
  files: {
    ".agents/skills/acme-review/SKILL.md":
      "---\nname: acme-review\ndescription: Acme review\n---\nReview the change.",
  },
  reviewer: {
    async review() {
      return {
        session: "acme-review",
        model: "acme-review-model",
        provider: "acme",
        findings:
          reviews++ === 0
            ? [
                {
                  severity: "P1",
                  location: "widgets.txt:1",
                  explanation: FAILURE,
                  evidence: "shelf b is absent",
                },
              ]
            : [],
      };
    },
  },
  policy: `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: independent-review
    kind: review
    gate: beforePR
    skill: .agents/skills/acme-review/SKILL.md
    failOn: P1
    independence:
      differentSession: true
      differentModel: true
`,
  agent: (input) =>
    ["implement", "fix"].includes(input.purpose)
      ? input.prompt.includes(FAILURE)
        ? commit(input.worktree, "shelf a: 12\nshelf b: 7\n", "Count shelf b")
        : commit(input.worktree, "shelf a: 12\n", "Count widgets per shelf")
      : [],
  async run(proof) {
    await proof.delegate();
    const merged = await proof.waitFor(
      "the item is merged",
      () => ["merged", "failed", "manual", "cancelled"].includes(proof.itemState() ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const turns = proof.launches.filter((launch) => ["implement", "fix"].includes(launch.purpose));
    const purposes = proof.launches.map((launch) => launch.purpose);
    proof.expect(
      "the first turn commits without the line, so Closeout sends the item back",
      turns.length >= 2 &&
        turns[0]!.purpose === "implement" &&
        !turns[0]!.prompt.includes(FAILURE) &&
        proof.transitions().some((row) => row.from === "verifying" && row.event === "restart"),
      { purposes, transitions: proof.transitions() },
    );
    proof.expect(
      "the fix turn sees the failure text in its prompt",
      turns.length === 2 &&
        turns[1]!.purpose === "fix" &&
        turns[1]!.prompt.includes(FAILURE) &&
        turns[1]!.prompt.includes("widgets.txt:1"),
      { purposes, fixPrompt: turns[1]?.prompt.slice(0, 2_000) ?? null },
    );
    proof.expect(
      "the rejected finding was stored before restart",
      proof.storedReviewFindings() > 0,
    );
    const log = await proof.originMainLog();
    proof.expect(
      "the fix commit is merged into origin main",
      log.includes("Count shelf b") && log.includes("Count widgets per shelf"),
      log,
    );
    proof.expect(
      "the item is merged, not failed",
      merged && proof.itemState() === "merged",
      proof.itemState(),
    );
  },
} satisfies Proof;
