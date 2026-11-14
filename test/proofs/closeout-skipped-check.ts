import { join } from "node:path";
import type { Proof } from "./harness";

export default {
  covers: ["src/acp/ask-team.ts"],
  summary:
    "A checks agent runs one command and ends; Paws runs the omitted command and merges without a question.",
  policy: `specVersion: "0.1"
items:
  - id: first
    kind: command
    gate: beforePR
    exec: ["true"]
    timeoutSeconds: 10
  - id: skipped
    kind: command
    gate: beforePR
    exec: ["true"]
    timeoutSeconds: 10
`,
  agent: (input) =>
    input.purpose === "implement"
      ? [
          { type: "fs_write", path: join(input.worktree, "change.txt"), content: "change\n" },
          { type: "terminal", command: "git", args: ["add", "change.txt"], cwd: input.worktree },
          {
            type: "terminal",
            command: "git",
            args: [
              "-c",
              "user.name=Agent",
              "-c",
              "user.email=agent@test.invalid",
              "commit",
              "-m",
              "Add change",
            ],
            cwd: input.worktree,
          },
        ]
      : [{ type: "run_closeout", id: "first" }, { type: "end" }],
  async run(proof) {
    await proof.delegate();
    await proof.waitFor(
      "the item merges",
      async () => (await proof.itemState()) === "merged",
      120_000,
    );
    proof.expect(
      "omitted check does not require a question",
      proof.linear.questions.length === 0,
      proof.linear.questions,
    );
    proof.expect("the item merged", (await proof.itemState()) === "merged");
  },
} satisfies Proof;
