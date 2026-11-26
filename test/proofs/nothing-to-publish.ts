import { join } from "node:path";
import { ACME, type Proof } from "./harness";

export default {
  covers: ["src/github/pulls.ts", "src/loop/nothing-to-publish.ts"],
  summary:
    "GitHub refuses the pull request because the branch has no commits ahead of main; Paws asks once instead of retrying, and the answer completes the item without a pull request.",
  noCi: true,
  noCommitsAhead: true,
  agent: (input) =>
    input.purpose === "implement"
      ? [
          { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
          { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
          {
            type: "terminal",
            command: "git",
            args: ["commit", "-q", "-m", "Count widgets per shelf"],
            cwd: input.worktree,
          },
        ]
      : [],
  async run(proof) {
    await proof.delegate();
    const asked = await proof.waitFor(
      "Paws asks about the empty branch",
      async () => (await proof.itemState()) === "awaiting_input",
      120_000,
    );
    const branch = await proof.itemBranch();
    const question = proof.linear.questions.at(-1);
    proof.expect(
      "the question names the branch and offers both choices",
      asked &&
        question !== undefined &&
        question.body.includes(`\`${branch}\` has no commits ahead of main`) &&
        JSON.stringify(question.options) ===
          JSON.stringify(["Complete without a pull request", "Send back to the agent"]),
      question,
    );
    await proof.waitFor("no retry follows", () => false, 3_000);
    const posts = () =>
      proof.github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pulls"));
    proof.expect("the pull request was tried once", posts().length === 1, posts());
    await proof.answerInLinear("Complete without a pull request");
    const done = await proof.waitFor(
      "the item completes",
      async () => (await proof.itemState()) === "completed",
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const transitions = await proof.transitions();
    proof.expect(
      "the item completed and was never merged",
      done &&
        transitions.at(-1)?.event === "answer_completed" &&
        !transitions.some((row) => row.to === "merged") &&
        proof.github.opened.length === 0,
      transitions,
    );
    const final = proof.linear.progress.at(-1);
    proof.expect(
      "Linear got a final response and the issue moved to completed",
      final?.kind === "response" &&
        final.body.startsWith("Completed without a pull request") &&
        proof.linear.issueStateTypes.get(ACME.issueId) === "completed",
      { final, issue: proof.linear.issueStateTypes.get(ACME.issueId) },
    );
  },
} satisfies Proof;
