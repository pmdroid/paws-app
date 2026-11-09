import { join } from "node:path";
import { ACME, type Proof } from "./harness";

export default {
  covers: ["src/linear/repositories.ts", "src/loop/orchestrator.ts"],
  summary:
    "An unknown Implementer label asks for a preset correction; choosing the default resumes and merges the Acme issue.",
  agent: (input) =>
    input.purpose === "implement"
      ? [
          { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
          { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
          {
            type: "terminal",
            command: "git",
            args: ["commit", "-q", "-m", "Count Acme widgets"],
            cwd: input.worktree,
          },
        ]
      : [],
  async run(proof) {
    proof.linear.repositoryHints.set(ACME.issueId, {
      mentions: [],
      issueLabels: [],
      parentLabels: [],
      projectLabels: [],
      profileLabels: { implementer: "Acme unknown" },
    });
    await proof.delegate();
    await proof.waitFor("profile question", () => proof.linear.questions.length > 0);
    proof.expect(
      "no implement turn ran before the answer",
      proof.launches.filter((x) => x.purpose === "implement").length === 0,
    );
    proof.expect(
      "question names the problem preset",
      JSON.stringify(proof.linear.questions).includes("Acme unknown"),
    );
    await proof.answerInLinear("Use the default");
    await proof.waitFor(
      "default profile completes the issue",
      () => proof.itemState() === "merged",
      120_000,
    );
    proof.expect("default answer allows merge", proof.itemState() === "merged", proof.itemState());
  },
} satisfies Proof;
