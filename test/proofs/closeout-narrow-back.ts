import { join } from "node:path";
import { type FakeStep } from "../../src/acp/testing/script";
import { type Proof } from "./harness";

const FAILURE = "unchecked grant: the admission layer keeps a revoked grant";
const NARROW = "Narrow the change back to the issue before you fix anything.";
let reviews = 0;

function commit(worktree: string, files: Record<string, string | null>, message: string) {
  const steps: FakeStep[] = [];
  for (const [file, content] of Object.entries(files))
    steps.push(
      content === null
        ? { type: "terminal", command: "git", args: ["rm", "-q", file], cwd: worktree }
        : { type: "fs_write", path: join(worktree, file), content },
    );
  steps.push(
    { type: "terminal", command: "git", args: ["add", "-A"], cwd: worktree },
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
  );
  return steps;
}

const admission = Array.from({ length: 900 }, (_, index) => `grant ${index}`).join("\n") + "\n";

export default {
  covers: ["src/loop/narrow-back.ts", "src/loop/orchestrator.ts", "src/closeout/rounds.ts"],
  summary:
    "A candidate past 800 changed lines with a P1 finding gets a narrowing restart instead of a fix round; the agent removes the extra layer and the item merges.",
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
                  location: "admission.txt:1",
                  explanation: FAILURE,
                  evidence: "grant 0 is never revoked",
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
      ? input.prompt.includes(NARROW)
        ? commit(input.worktree, { "admission.txt": null }, "Remove the admission layer")
        : commit(
            input.worktree,
            { "widgets.txt": "shelf a: 12\n", "admission.txt": admission },
            "Count widgets behind an admission layer",
          )
      : [],
  async run(proof) {
    await proof.delegate();
    const merged = await proof.waitFor(
      "the item is merged",
      async () =>
        ["merged", "failed", "manual", "cancelled", "awaiting_input"].includes(
          (await proof.itemState()) ?? "",
        ),
      120_000,
    );
    const turns = proof.launches.filter((launch) => ["implement", "fix"].includes(launch.purpose));
    const purposes = proof.launches.map((launch) => launch.purpose);
    const narrowing = turns[1]?.prompt ?? "";
    proof.expect(
      "the second turn is a narrowing restart that names the size, the limit and the added file",
      turns.length === 2 &&
        narrowing.includes(
          "Paws stopped the next fix round: the change grew to 901 changed lines in 2 files, past the 800-line limit.",
        ) &&
        narrowing.includes(NARROW) &&
        narrowing.includes("- admission.txt (+900 −0)") &&
        narrowing.includes(FAILURE),
      { purposes, prompt: narrowing.slice(0, 2_000) },
    );
    const log = await proof.originMainLog();
    proof.expect(
      "the narrowed change merges without the admission layer",
      log.includes("Remove the admission layer"),
      log,
    );
    proof.expect(
      "the item is merged, not asked about",
      merged && (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
