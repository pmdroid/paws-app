import { join } from "node:path";
import { ACME, type Proof } from "./harness";

const turns = new Map<string, number>();

export default {
  covers: ["src/github/pulls.ts", "src/loop/nothing-to-publish.ts"],
  summary:
    "A person closes the Paws pull request unmerged while it waits in the merge queue; Paws does not open a new pull request for the same head, asks instead, and the answer completes the item.",
  ciPending: true,
  agent: (input) =>
    input.purpose === "implement" &&
    turns.set(input.worktree, (turns.get(input.worktree) ?? 0) + 1).get(input.worktree) === 1
      ? [{ type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" }]
      : [],
  async run(proof) {
    proof.github.ci.failed = true;
    await proof.delegate();
    await proof.waitFor(
      "the pull request is open and waits on CI",
      async () => (await proof.itemState()) === "merge_queue" && proof.github.opened.length === 1,
    );
    proof.github.closed.add(1);
    proof.github.ci.pending = false;
    const asked = await proof.waitFor(
      "Paws asks instead of republishing the head",
      async () => (await proof.itemState()) === "awaiting_input",
      120_000,
    );
    const question = proof.linear.questions.at(-1);
    proof.expect(
      "the question names the closed pull request",
      asked && question?.body.includes("PR #1 was closed without merging") === true,
      { question, transitions: await proof.transitions() },
    );
    const posts = proof.github.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/pulls"),
    );
    proof.expect("no second pull request is opened for the head", posts.length === 1, posts);
    proof.expect(
      "the closed pull request was looked up at the head",
      proof.github.calls.some(
        (call) => call.path.includes("state=closed") && call.outcome === "200",
      ),
    );
    await proof.answerInLinear("Complete without a pull request");
    const done = await proof.waitFor(
      "the item completes",
      async () => (await proof.itemState()) === "completed",
    );
    proof.expect(
      "the item completed and nothing merged",
      done &&
        (await proof.transitions()).at(-1)?.event === "answer_completed" &&
        proof.github.merged.size === 0 &&
        proof.github.opened.length === 1,
      await proof.transitions(),
    );
    const deleted = await proof.waitFor("the Paws branch is deleted", () =>
      proof.github.calls.some((call) => call.method === "DELETE" && call.outcome === "204"),
    );
    proof.expect("the Paws branch is deleted although the PR was already closed", deleted);
    proof.expect(
      "the issue moved to completed",
      proof.linear.issueStateTypes.get(ACME.issueId) === "completed",
    );
  },
} satisfies Proof;
